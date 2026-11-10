import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import { isDeclarationPrefixMacro, neutralizeDialect } from "./preprocess";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import type { Access, Declaration, DeclarationKind, DeclarationRange, ParsedFile } from "./types";

/**
 * C++ and HIP extraction.
 *
 * The adapter walks tree-sitter-cpp's tree and produces the small declaration model in `types.ts`. Two
 * properties matter more than the node-by-node detail:
 *
 * - The tree is parsed from a neutralized copy of the source (see `preprocess.ts`), but every string in the
 *   result is sliced from the original. Byte offsets are identical by construction.
 * - A declaration is independent of where it is defined. An out-of-class `Socket::connect` keeps its
 *   qualified name, so `show` can pair it with the declaration in the header later.
 */
export async function parseCppFile(
    source: string,
    filePath: string,
    language: "cpp" | "hip",
): Promise<ParsedFile> {
    const parseSource = neutralizeDialect(source);
    const { root } = await parseSyntax("cpp", parseSource);
    const visitor = new CppVisitor(source, filePath, language);

    visitor.visit(root);

    return {
        path: filePath,
        language,
        size: Buffer.byteLength(source),
        lineCount: visitor.lineCount,
        parseErrors: countParseErrors(root),
        source,
        roots: visitor.roots,
        all: visitor.all,
    };
}

interface ScopeContext {
    scope: string;
    parent?: Declaration;
    access?: Access;
    defaultAccess?: Access;
    signatureStart?: number;
    docAnchor?: SyntaxNode;
    /** True while walking a function body; plain locals are then not declarations. */
    local?: boolean;
}

interface NameInfo {
    simple: string;
    qualifier: string;
    nameNode: SyntaxNode;
}

const TYPE_NODES = new Set([
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
]);

const FUNCTION_NAME_NODES = new Set([
    "identifier",
    "field_identifier",
    "destructor_name",
    "operator_name",
    "operator_cast",
    "type_identifier",
]);

const LOCAL_BLOCK_NODES = new Set([
    "case_statement",
    "catch_clause",
    "do_statement",
    "for_range_loop",
    "for_statement",
    "if_statement",
    "labeled_statement",
    "switch_statement",
    "try_statement",
    "while_statement",
]);

const DECLARATOR_NODES = new Set([
    "identifier",
    "field_identifier",
    "pointer_declarator",
    "reference_declarator",
    "array_declarator",
    "init_declarator",
    "parenthesized_declarator",
    "function_declarator",
    "abstract_function_declarator",
]);

class CppVisitor {
    readonly roots: Declaration[] = [];
    readonly all: Declaration[] = [];
    readonly lineCount: number;

    private readonly seen = new Set<string>();
    private readonly namespaces = new Set<string>();
    private readonly lineStarts: number[] = [0];

    constructor(
        private readonly source: string,
        private readonly filePath: string,
        private readonly language: "cpp" | "hip",
    ) {
        for (let index = 0; index < source.length; index += 1) {
            if (source[index] === "\n") {
                this.lineStarts.push(index + 1);
            }
        }

        this.lineCount = this.lineStarts.length;
    }

    visit(node: SyntaxNode): void {
        this.visitNode(node, { scope: "" });
    }

    private visitNode(node: SyntaxNode, context: ScopeContext): void {
        switch (node.type) {
            case "translation_unit":
            case "declaration_list":
            case "linkage_specification":
            case "preproc_ifdef":
            case "preproc_if":
            case "preproc_elif":
            case "preproc_else":
            case "compound_statement":
            case "ERROR":
                this.visitChildren(node, context);

                return;
            case "namespace_definition":
                this.visitNamespace(node, context);

                return;
            case "template_declaration":
                this.visitTemplate(node, context);

                return;
            case "class_specifier":
            case "struct_specifier":
            case "union_specifier":
            case "enum_specifier":
                this.visitType(node, context);

                return;
            case "function_definition":
                this.visitFunction(node, context, true);

                return;
            case "declaration":
                this.visitDeclaration(node, context);

                return;
            case "field_declaration":
                this.visitFieldDeclaration(node, context);

                return;
            case "expression_statement":
                this.visitDefaultedDefinition(node, context);

                return;
            case "alias_declaration":
            case "type_definition":
                this.visitAlias(node, context);

                return;
            default:
                if (context.local === true && LOCAL_BLOCK_NODES.has(node.type)) {
                    this.visitChildren(node, context);
                }

                return;
        }
    }

    private visitChildren(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            this.visitNode(child, context);
        }
    }

    private visitNamespace(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "namespace_identifier");
        const body = node.childForFieldName("body") ?? findFirst(node, "declaration_list");

        if (nameNode === null) {
            this.visitChildren(node, context);

            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = this.declarationStart(context.signatureStart ?? node.startIndex);

        for (const namespaceName of namespacePrefixes(qualifiedName)) {
            this.namespaces.add(namespaceName);
        }
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const declaration: Declaration = {
            kind: "namespace",
            name,
            qualifiedName,
            signature: this.signatureBetween(startIndex, signatureEnd),
            range: this.rangeOf(startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            paramTypes: [],
            isDefinition: body !== null,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);

        if (body !== null) {
            this.visitNode(body, {
                scope: qualifiedName,
                parent: declaration,
                docAnchor: node,
            });
        }
    }

    private visitTemplate(node: SyntaxNode, context: ScopeContext): void {
        const inner = namedChildren(node).at(-1);

        if (inner === undefined) {
            return;
        }

        this.visitNode(inner, {
            ...context,
            signatureStart: node.startIndex,
            docAnchor: context.docAnchor ?? node,
        });
    }

    private visitType(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "type_identifier");
        const body = node.childForFieldName("body") ?? null;

        if (node.type === "enum_specifier") {
            this.visitEnum(node, context, nameNode, body);

            return;
        }

        const kind: DeclarationKind =
            node.type === "class_specifier"
                ? "class"
                : node.type === "struct_specifier"
                  ? "struct"
                  : "union";
        const name = nameNode === null ? "<anonymous>" : cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = this.declarationStart(context.signatureStart ?? node.startIndex);
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const declaration: Declaration = {
            kind,
            name,
            qualifiedName,
            signature: this.signatureBetween(startIndex, signatureEnd),
            range: this.rangeOf(startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            nameRange: nameNode === null ? undefined : this.nameRangeOf(nameNode),
            docRange: this.docRangeOf(context.docAnchor ?? node),
            paramTypes: [],
            access: context.access,
            isDefinition: body !== null,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);

        if (body !== null) {
            const defaultAccess: Access = kind === "class" ? "private" : "public";

            this.visitMembers(body, {
                scope: qualifiedName,
                parent: declaration,
                access: defaultAccess,
                defaultAccess,
            });
        }
    }

    private visitEnum(
        node: SyntaxNode,
        context: ScopeContext,
        nameNode: SyntaxNode | null,
        body: SyntaxNode | null,
    ): void {
        const name = nameNode === null ? "<anonymous>" : cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = this.declarationStart(context.signatureStart ?? node.startIndex);
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const declaration: Declaration = {
            kind: "enum",
            name,
            qualifiedName,
            signature: this.signatureBetween(startIndex, signatureEnd),
            range: this.rangeOf(startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            nameRange: nameNode === null ? undefined : this.nameRangeOf(nameNode),
            docRange: this.docRangeOf(context.docAnchor ?? node),
            paramTypes: [],
            access: context.access,
            isDefinition: body !== null,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);

        if (body === null) {
            return;
        }

        for (const child of namedChildren(body)) {
            if (child.type !== "enumerator") {
                continue;
            }

            const childName = findFirst(child, "identifier");

            if (childName === null) {
                continue;
            }

            const memberName = cleanName(this.textOf(childName));
            const member: Declaration = {
                kind: "enumMember",
                name: memberName,
                qualifiedName: appendQualified(qualifiedName, memberName),
                signature: this.signatureBetween(child.startIndex, child.endIndex),
                range: this.rangeOf(child.startIndex, child.endIndex),
                nameRange: this.nameRangeOf(childName),
                paramTypes: [],
                access: context.access,
                isDefinition: true,
                children: [],
                language: this.language,
            };

            this.push(member, declaration);
        }
    }

    private visitMembers(body: SyntaxNode, context: ScopeContext): void {
        let access = context.access ?? context.defaultAccess;

        for (const child of namedChildren(body)) {
            if (child.type === "access_specifier") {
                access = cleanName(this.textOf(child)) as Access;

                continue;
            }

            this.visitNode(child, { ...context, access });
        }
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext, isDefinition: boolean): void {
        const declarator =
            node.childForFieldName("declarator") ??
            namedChildren(node).find((child) => findFunctionDeclarator(child) !== null) ??
            null;

        if (declarator === null) {
            return;
        }

        const functionDeclarator = findFunctionDeclarator(declarator);
        const name = resolveName(declarator, (target) => this.textOf(target));

        if (functionDeclarator === null || name === undefined) {
            return;
        }

        const body = node.childForFieldName("body") ?? null;
        const defaulted = /=\s*(?:default|delete)\b/.test(this.textOf(node));
        const kind = classifyFunction(name, context, functionDeclarator, this.namespaces);
        const qualifiedName =
            name.qualifier.length === 0
                ? appendQualified(context.scope, name.simple)
                : combineOutOfLine(context.scope, name.qualifier, name.simple);
        const startIndex = this.declarationStart(context.signatureStart ?? node.startIndex);
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const parameters = this.paramTypesOf(functionDeclarator);
        const declaration: Declaration = {
            kind,
            name: name.simple,
            qualifiedName,
            signature: this.signatureBetween(startIndex, signatureEnd),
            range: this.rangeOf(startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            nameRange: this.nameRangeOf(name.nameNode),
            docRange: this.docRangeOf(context.docAnchor ?? node),
            paramTypes: parameters.types,
            paramTexts: parameters.texts,
            access: context.access,
            isDefinition: (isDefinition && body !== null) || defaulted,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);

        if (body !== null) {
            this.visitNode(body, {
                scope: qualifiedName,
                parent: declaration,
                local: true,
            });
        }
    }

    /**
     * tree-sitter-cpp parses an out-of-class `Foo::~Foo() = default;` as an expression statement, not a
     * declaration. Recover it as a definition so `show` pairs it with the header declaration and `usages`
     * tags it `[def]`.
     */
    private visitDefaultedDefinition(node: SyntaxNode, context: ScopeContext): void {
        const assignment = namedChildren(node).find(
            (child) => child.type === "assignment_expression",
        );

        if (assignment === undefined) {
            return;
        }

        const left = assignment.childForFieldName("left") ?? namedChildren(assignment)[0] ?? null;
        const right = assignment.childForFieldName("right") ?? namedChildren(assignment)[1] ?? null;

        if (left === null || right === null || left.type !== "call_expression") {
            return;
        }

        const qualifier = cleanName(this.textOf(right));

        if (qualifier !== "default" && qualifier !== "delete") {
            return;
        }

        const functionNode = left.childForFieldName("function") ?? namedChildren(left)[0] ?? null;

        if (functionNode === null) {
            return;
        }

        const functionDeclarator = findFunctionDeclarator(functionNode) ?? functionNode;
        const name = resolveName(functionNode, (target) => this.textOf(target));

        if (name === undefined) {
            return;
        }

        const kind = classifyFunction(name, context, functionDeclarator, this.namespaces);
        const qualifiedName =
            name.qualifier.length === 0
                ? appendQualified(context.scope, name.simple)
                : combineOutOfLine(context.scope, name.qualifier, name.simple);
        const declaration: Declaration = {
            kind,
            name: name.simple,
            qualifiedName,
            signature: this.signatureBetween(node.startIndex, node.endIndex),
            range: this.rangeOf(node.startIndex, node.endIndex),
            nameRange: this.nameRangeOf(name.nameNode),
            docRange: this.docRangeOf(node),
            paramTypes: this.callArgumentTypes(left),
            access: context.access,
            isDefinition: true,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);
    }

    private callArgumentTypes(call: SyntaxNode): string[] {
        const argumentsNode =
            call.childForFieldName("arguments") ?? findFirst(call, "argument_list");

        if (argumentsNode === null) {
            return [];
        }

        return namedChildren(argumentsNode)
            .map((argument) => normalizeType(this.textOf(argument)))
            .filter((argument) => argument.length > 0);
    }

    private visitDeclaration(node: SyntaxNode, context: ScopeContext): void {
        const nestedType = namedChildren(node).find((child) => TYPE_NODES.has(child.type));

        if (nestedType !== undefined) {
            this.visitNode(nestedType, {
                ...context,
                signatureStart: context.signatureStart ?? nestedType.startIndex,
                docAnchor: context.docAnchor ?? node,
            });

            return;
        }

        const hasFunctionDeclarator = namedChildren(node).some(
            (child) => findFunctionDeclarator(child) !== null,
        );

        if (hasFunctionDeclarator) {
            this.visitFunction(node, context, false);

            return;
        }

        this.visitVariables(node, context);
    }

    private visitFieldDeclaration(node: SyntaxNode, context: ScopeContext): void {
        const nestedType = namedChildren(node).find((child) => TYPE_NODES.has(child.type));

        if (nestedType !== undefined) {
            this.visitNode(nestedType, {
                ...context,
                signatureStart: nestedType.startIndex,
                docAnchor: context.docAnchor ?? node,
            });

            return;
        }

        const hasFunctionDeclarator = namedChildren(node).some(
            (child) => findFunctionDeclarator(child) !== null,
        );

        if (hasFunctionDeclarator) {
            this.visitFunction(node, context, false);

            return;
        }

        this.visitFields(node, context);
    }

    private visitFields(node: SyntaxNode, context: ScopeContext): void {
        const declarators = namedChildren(node).filter((child) => DECLARATOR_NODES.has(child.type));

        if (declarators.length === 0) {
            return;
        }

        const first = declarators[0];

        if (first === undefined) {
            return;
        }

        const typePrefix = this.source.slice(node.startIndex, first.startIndex);

        for (const declarator of declarators) {
            const nameNode = lastIdentifier(declarator);

            if (nameNode === null) {
                continue;
            }

            const name = cleanName(this.textOf(nameNode));
            const declaration: Declaration = {
                kind: "field",
                name,
                qualifiedName: appendQualified(context.scope, name),
                signature: this.collapse(
                    `${typePrefix}${this.source.slice(declarator.startIndex, declarator.endIndex)}`,
                ),
                range: this.rangeOf(node.startIndex, node.endIndex),
                nameRange: this.nameRangeOf(nameNode),
                docRange: this.docRangeOf(context.docAnchor ?? node),
                paramTypes: [],
                access: context.access,
                isDefinition: false,
                children: [],
                language: this.language,
            };

            this.push(declaration, context.parent);
        }
    }

    private visitVariables(node: SyntaxNode, context: ScopeContext): void {
        const declarators = namedChildren(node).filter((child) => DECLARATOR_NODES.has(child.type));

        for (const declarator of declarators) {
            const nameNode = lastIdentifier(declarator);

            if (nameNode === null) {
                continue;
            }

            const name = cleanName(this.textOf(nameNode));
            const lambda = lambdaExpressionOf(declarator);

            if (context.local === true && lambda === null) {
                continue;
            }

            const startIndex = this.declarationStart(context.signatureStart ?? node.startIndex);
            const body = lambda?.childForFieldName("body") ?? null;
            const lambdaDeclarator = lambda?.childForFieldName("declarator") ?? null;
            const parameters =
                lambdaDeclarator === null
                    ? { types: [], texts: [] }
                    : this.paramTypesOf(lambdaDeclarator);
            const signatureEnd =
                lambda === null ? node.endIndex : (body?.startIndex ?? lambda.endIndex);
            const declaration: Declaration = {
                kind: lambda === null ? "variable" : "function",
                name,
                qualifiedName: appendQualified(context.scope, name),
                signature: this.signatureBetween(startIndex, signatureEnd),
                range: this.rangeOf(startIndex, node.endIndex),
                bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
                nameRange: this.nameRangeOf(nameNode),
                docRange: this.docRangeOf(context.docAnchor ?? node),
                paramTypes: parameters.types,
                paramTexts: parameters.texts,
                access: context.access,
                isDefinition: true,
                children: [],
                language: this.language,
            };

            this.push(declaration, context.parent);

            if (lambda !== null && body !== null) {
                this.visitNode(body, {
                    scope: declaration.qualifiedName,
                    parent: declaration,
                    local: true,
                });
            }
        }
    }

    private visitAlias(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            [...namedChildren(node)].reverse().find((child) => child.type === "type_identifier") ??
            null;

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const declaration: Declaration = {
            kind: "typeAlias",
            name,
            qualifiedName: appendQualified(context.scope, name),
            signature: this.signatureBetween(
                this.declarationStart(context.signatureStart ?? node.startIndex),
                node.endIndex,
            ),
            range: this.rangeOf(
                this.declarationStart(context.signatureStart ?? node.startIndex),
                node.endIndex,
            ),
            nameRange: this.nameRangeOf(nameNode),
            docRange: this.docRangeOf(context.docAnchor ?? node),
            paramTypes: [],
            access: context.access,
            isDefinition: true,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);
    }

    private push(declaration: Declaration, parent: Declaration | undefined): void {
        const key = [
            declaration.qualifiedName,
            declaration.kind,
            declaration.isDefinition ? "def" : "decl",
            declaration.signature,
            declaration.paramTypes.join(","),
        ].join("\u0000");

        if (this.seen.has(key)) {
            return;
        }

        this.seen.add(key);
        this.all.push(declaration);

        if (parent === undefined) {
            this.roots.push(declaration);

            return;
        }

        parent.children.push(declaration);
    }

    private paramTypesOf(functionDeclarator: SyntaxNode): { types: string[]; texts: string[] } {
        const parameters = functionDeclarator.childForFieldName("parameters") ?? null;

        if (parameters === null) {
            return { types: [], texts: [] };
        }

        const types: string[] = [];
        const texts: string[] = [];

        for (const parameter of namedChildren(parameters)) {
            if (parameter.type === "variadic_parameter_declaration") {
                types.push("...");
                texts.push("...");

                continue;
            }

            const declarator = parameter.childForFieldName("declarator") ?? null;
            const raw =
                declarator === null
                    ? this.textOf(parameter)
                    : this.textOf(parameter).slice(0, declarator.startIndex - parameter.startIndex);
            const text = this.collapse(
                `${raw}${leadingDeclaratorOperators(declarator, (target) => this.textOf(target))}`,
            );
            const type = normalizeType(text);

            if (type.length > 0 && type !== "void") {
                types.push(type);
                texts.push(text);
            }
        }

        return { types, texts };
    }

    private signatureBetween(startIndex: number, endIndex: number): string {
        const text = this.source
            .slice(startIndex, endIndex)
            .replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*/g, "")
            .replace(/;\s*$/, "");

        return this.collapse(text);
    }

    /**
     * Extend a declaration start over neutralized prefix macros on the same line (`FMT_EXPORT`, `MYLIB_API`).
     *
     * The parse buffer replaced them with spaces so the declaration would parse; the original text still has
     * them, and this is what keeps them in a signature without making the parser see them.
     */
    private declarationStart(startIndex: number): number {
        let start = startIndex;

        while (true) {
            const attributeStart = this.attributeStartBefore(start);

            if (attributeStart !== undefined) {
                start = attributeStart;

                continue;
            }

            let cursor = start;

            while (
                cursor > 0 &&
                (this.source[cursor - 1] === " " || this.source[cursor - 1] === "\t")
            ) {
                cursor -= 1;
            }

            if (cursor === 0 || this.source[cursor - 1] === "\n") {
                return start;
            }

            const wordEnd = cursor;

            while (cursor > 0 && /[A-Za-z0-9_]/.test(this.source[cursor - 1] ?? "")) {
                cursor -= 1;
            }

            const word = this.source.slice(cursor, wordEnd);

            if (!isDeclarationPrefixMacro(word)) {
                return start;
            }

            start = cursor;
        }
    }

    /** Include a blanked `[[...]]` or `__attribute__((...))` that decorates this declaration. */
    private attributeStartBefore(start: number): number | undefined {
        let cursor = start;

        while (cursor > 0 && /\s/.test(this.source[cursor - 1] ?? "")) {
            cursor -= 1;
        }

        if (this.source.slice(cursor - 2, cursor) === "]]") {
            const open = this.source.lastIndexOf("[[", cursor - 2);

            return open >= 0 ? open : undefined;
        }

        if (this.source[cursor - 1] !== ")") {
            return undefined;
        }

        let depth = 0;
        let open = -1;

        for (let index = cursor - 1; index >= 0; index -= 1) {
            const char = this.source[index];

            if (char === ")") {
                depth += 1;
            } else if (char === "(") {
                depth -= 1;

                if (depth === 0) {
                    open = index;

                    break;
                }
            }
        }

        if (open < 0) {
            return undefined;
        }

        let wordEnd = open;

        while (wordEnd > 0 && /\s/.test(this.source[wordEnd - 1] ?? "")) {
            wordEnd -= 1;
        }

        let wordStart = wordEnd;

        while (wordStart > 0 && /[A-Za-z0-9_]/.test(this.source[wordStart - 1] ?? "")) {
            wordStart -= 1;
        }

        return this.source.slice(wordStart, wordEnd) === "__attribute__" ? wordStart : undefined;
    }

    private collapse(text: string): string {
        return text.replace(/\s+/g, " ").trim();
    }

    private rangeOf(startIndex: number, endIndex: number): DeclarationRange {
        return {
            startLine: this.lineAt(startIndex),
            endLine: this.lineAt(Math.max(startIndex, endIndex - 1)),
            startIndex,
            endIndex,
        };
    }

    private nameRangeOf(node: SyntaxNode): { startIndex: number; endIndex: number } {
        return { startIndex: node.startIndex, endIndex: node.endIndex };
    }

    private docRangeOf(anchor: SyntaxNode): { startIndex: number; endIndex: number } | undefined {
        const comments: SyntaxNode[] = [];
        let previous = anchor.previousNamedSibling ?? null;

        while (previous !== null && previous.type === "comment") {
            comments.unshift(previous);
            previous = previous.previousNamedSibling ?? null;
        }

        const first = comments[0];
        const last = comments.at(-1);

        if (first === undefined || last === undefined) {
            return undefined;
        }

        if (anchor.startPosition.row - last.endPosition.row > 2) {
            return undefined;
        }

        return { startIndex: first.startIndex, endIndex: last.endIndex };
    }

    private lineAt(index: number): number {
        let low = 0;
        let high = this.lineStarts.length - 1;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const start = this.lineStarts[middle] ?? 0;

            if (start <= index) {
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return high + 1;
    }

    private textOf(node: SyntaxNode): string {
        return this.source.slice(node.startIndex, node.endIndex);
    }
}

function findFirst(node: SyntaxNode, type: string): SyntaxNode | null {
    for (const child of namedChildren(node)) {
        if (child.type === type) {
            return child;
        }
    }

    return null;
}

function lambdaExpressionOf(declarator: SyntaxNode): SyntaxNode | null {
    if (declarator.type === "lambda_expression") {
        return declarator;
    }

    const value = declarator.childForFieldName("value") ?? null;

    if (value?.type === "lambda_expression") {
        return value;
    }

    return findFirst(declarator, "lambda_expression");
}

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
    if (node.type === "function_declarator" || node.type === "abstract_function_declarator") {
        return node;
    }

    const declarator = node.childForFieldName("declarator") ?? null;

    if (declarator !== null) {
        return findFunctionDeclarator(declarator);
    }

    const parameters = node.childForFieldName("parameters") ?? null;

    for (const child of namedChildren(node)) {
        if (child === parameters) {
            continue;
        }

        const found = findFunctionDeclarator(child);

        if (found !== null) {
            return found;
        }
    }

    return null;
}

function resolveName(node: SyntaxNode, textOf: (node: SyntaxNode) => string): NameInfo | undefined {
    if (node.type === "qualified_identifier") {
        const nameNode = node.childForFieldName("name") ?? namedChildren(node).at(-1) ?? null;

        if (nameNode === null) {
            return undefined;
        }

        const scopeNode = node.childForFieldName("scope") ?? null;
        const qualifier =
            scopeNode === null
                ? cleanName(
                      textOf(node)
                          .slice(0, nameNode.startIndex - node.startIndex)
                          .replace(/::$/, ""),
                  )
                : cleanName(textOf(scopeNode));

        return {
            simple: cleanName(textOf(nameNode)),
            qualifier,
            nameNode,
        };
    }

    if (node.type === "operator_cast") {
        const text = cleanName(textOf(node));
        const open = text.indexOf("(");

        return {
            simple: (open < 0 ? text : text.slice(0, open)).trim(),
            qualifier: "",
            nameNode: node,
        };
    }

    if (FUNCTION_NAME_NODES.has(node.type)) {
        return { simple: cleanName(textOf(node)), qualifier: "", nameNode: node };
    }

    const declarator = node.childForFieldName("declarator") ?? null;

    if (declarator !== null) {
        return resolveName(declarator, textOf);
    }

    for (const child of namedChildren(node)) {
        const found = resolveName(child, textOf);

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
}

function classifyFunction(
    name: NameInfo,
    context: ScopeContext,
    functionDeclarator: SyntaxNode,
    namespaces: ReadonlySet<string>,
): DeclarationKind {
    if (name.simple.startsWith("~")) {
        return "destructor";
    }

    if (name.simple.startsWith("operator")) {
        return "operator";
    }

    const parentKind = context.parent?.kind;
    const parentName = context.parent?.name;

    if (
        parentKind !== undefined &&
        (parentKind === "class" || parentKind === "struct" || parentKind === "union") &&
        name.qualifier.length === 0 &&
        name.simple === parentName
    ) {
        return "constructor";
    }

    if (name.qualifier.length > 0) {
        const lastQualifier = name.qualifier.split("::").at(-1);

        if (lastQualifier === name.simple) {
            return "constructor";
        }

        if (!namespaces.has(name.qualifier)) {
            return "method";
        }
    }

    if (parentKind === "class" || parentKind === "struct" || parentKind === "union") {
        return "method";
    }

    if (functionDeclarator.type === "abstract_function_declarator") {
        return "operator";
    }

    return "function";
}

function namespacePrefixes(qualifiedName: string): string[] {
    const parts = qualifiedName.split("::");

    return parts.map((_part, index) => parts.slice(0, index + 1).join("::"));
}

function appendQualified(scope: string, name: string): string {
    return scope.length === 0 ? name : `${scope}::${name}`;
}

function combineOutOfLine(scope: string, qualifier: string, name: string): string {
    const base = scope.length === 0 ? [] : scope.split("::");
    const rest = `${qualifier}::${name}`.split("::").filter((part) => part.length > 0);

    if (base.length > 0 && rest.length >= base.length) {
        const prefix = rest.slice(0, base.length);

        if (prefix.every((part, index) => part === base[index])) {
            return [...base, ...rest.slice(base.length)].join("::");
        }
    }

    return [...base, ...rest].join("::");
}

function leadingDeclaratorOperators(
    declarator: SyntaxNode | null,
    textOf: (node: SyntaxNode) => string,
): string {
    if (declarator === null) {
        return "";
    }

    const match = /^[&*]+/.exec(textOf(declarator).trimStart());

    return match?.[0] ?? "";
}

function normalizeType(type: string): string {
    return type.replace(/\s+/g, "").replace(/,$/, "");
}

function lastIdentifier(node: SyntaxNode): SyntaxNode | null {
    if (node.type === "identifier" || node.type === "field_identifier") {
        return node;
    }

    const declarator = node.childForFieldName("declarator") ?? null;

    if (declarator !== null) {
        const found = lastIdentifier(declarator);

        if (found !== null) {
            return found;
        }
    }

    for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
        const child = node.namedChild(index);

        if (child === null) {
            continue;
        }

        const found = lastIdentifier(child);

        if (found !== null) {
            return found;
        }
    }

    return null;
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
    return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function cleanName(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
