import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import { countParseErrors, parseSyntax } from "./tree-sitter";
import { stripComments } from "./text";
import type { Access, Declaration, DeclarationKind, DeclarationRange, ParsedFile } from "./types";

/**
 * JavaScript, TypeScript, and TSX extraction.
 *
 * The adapter deliberately mirrors `cpp.ts`: tree-sitter owns the syntax, this file only emits the small
 * declaration model the formatter and matchers consume. TypeScript has no preprocessor pass, so every slice
 * below is taken directly from the original source.
 */
export async function parseTypeScriptFile(
    source: string,
    filePath: string,
    language: "javascript" | "typescript" | "tsx",
): Promise<ParsedFile> {
    const { root } = await parseSyntax(language, source);
    const visitor = new TypeScriptVisitor(source, language);

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
    signatureStart?: number;
    docAnchor?: SyntaxNode;
    /** True while walking a function/method body; plain locals are then not declarations. */
    local?: boolean;
}

const LOCAL_BLOCK_NODES = new Set([
    "catch_clause",
    "do_statement",
    "finally_clause",
    "for_in_statement",
    "for_statement",
    "if_statement",
    "labeled_statement",
    "switch_case",
    "switch_statement",
    "try_statement",
    "while_statement",
]);

const DECLARATION_NODES = new Set([
    "abstract_class_declaration",
    "ambient_declaration",
    "class_declaration",
    "enum_declaration",
    "function_declaration",
    "function_signature",
    "generator_function_declaration",
    "interface_declaration",
    "internal_module",
    "lexical_declaration",
    "module",
    "type_alias_declaration",
    "variable_declaration",
]);

class TypeScriptVisitor {
    readonly roots: Declaration[] = [];
    readonly all: Declaration[] = [];
    readonly lineCount: number;

    private readonly seen = new Set<string>();
    private readonly lineStarts: number[] = [0];

    constructor(
        private readonly source: string,
        private readonly language: "javascript" | "typescript" | "tsx",
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
            case "program":
            case "statement_block":
            case "ERROR":
                this.visitChildren(node, context);

                return;
            case "export_statement":
                this.visitExport(node, context);

                return;
            case "ambient_declaration":
                this.visitAmbient(node, context);

                return;
            case "internal_module":
            case "module":
                this.visitModule(node, context);

                return;
            case "class_declaration":
            case "abstract_class_declaration":
                this.visitClass(node, context);

                return;
            case "interface_declaration":
                this.visitInterface(node, context);

                return;
            case "function_declaration":
            case "generator_function_declaration":
            case "function_signature":
                this.visitFunction(node, context);

                return;
            case "lexical_declaration":
            case "variable_declaration":
                this.visitVariables(node, context);

                return;
            case "enum_declaration":
                this.visitEnum(node, context);

                return;
            case "type_alias_declaration":
                this.visitTypeAlias(node, context);

                return;
            case "expression_statement":
                this.visitCallStatement(node, context);

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

    private visitExport(node: SyntaxNode, context: ScopeContext): void {
        const inner = namedChildren(node).find((child) => DECLARATION_NODES.has(child.type));

        if (inner === undefined) {
            return;
        }

        this.visitNode(inner, {
            ...context,
            signatureStart: context.signatureStart ?? node.startIndex,
            docAnchor: context.docAnchor ?? node,
        });
    }

    private visitAmbient(node: SyntaxNode, context: ScopeContext): void {
        const inner = namedChildren(node).find((child) => child.type !== "comment");

        if (inner === undefined) {
            return;
        }

        this.visitNode(inner, {
            ...context,
            signatureStart: context.signatureStart ?? node.startIndex,
            docAnchor: context.docAnchor ?? node,
        });
    }

    private visitModule(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "identifier") ??
            findFirst(node, "string");
        const body = node.childForFieldName("body") ?? findFirst(node, "statement_block") ?? null;
        const name = nameNode === null ? "<anonymous>" : cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = context.signatureStart ?? node.startIndex;
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const declaration: Declaration = {
            kind: "namespace",
            name,
            qualifiedName,
            signature: this.signatureBetween(startIndex, signatureEnd),
            range: this.rangeOf(startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            nameRange:
                nameNode === null
                    ? undefined
                    : { startIndex: nameNode.startIndex, endIndex: nameNode.endIndex },
            docRange: this.docRangeOf(context.docAnchor ?? node),
            paramTypes: [],
            access: context.access,
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

    private visitClass(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ?? findFirst(node, "type_identifier") ?? null;
        const body = node.childForFieldName("body") ?? findFirst(node, "class_body") ?? null;
        const name = nameNode === null ? "<anonymous>" : cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = context.signatureStart ?? node.startIndex;
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const declaration: Declaration = {
            kind: "class",
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
            this.visitMembers(body, { scope: qualifiedName, parent: declaration });
        }
    }

    private visitInterface(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ?? findFirst(node, "type_identifier") ?? null;
        const body = node.childForFieldName("body") ?? findFirst(node, "interface_body") ?? null;
        const name = nameNode === null ? "<anonymous>" : cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = context.signatureStart ?? node.startIndex;
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const declaration: Declaration = {
            kind: "interface",
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
            this.visitMembers(body, { scope: qualifiedName, parent: declaration });
        }
    }

    private visitMembers(body: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(body)) {
            switch (child.type) {
                case "method_definition":
                case "abstract_method_signature":
                case "method_signature":
                    this.visitMethod(child, context);

                    break;
                case "field_definition":
                case "public_field_definition":
                case "property_signature":
                    this.visitField(child, context);

                    break;
                default:
                    break;
            }
        }
    }

    private visitMethod(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "property_identifier") ??
            findFirst(node, "private_property_identifier") ??
            null;

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const body = node.childForFieldName("body") ?? null;
        const kind: DeclarationKind =
            name === "constructor" && context.parent?.kind === "class" ? "constructor" : "method";
        const startIndex = node.startIndex;
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const parameters = this.paramTypesOf(node);

        const declaration: Declaration = {
            kind,
            name,
            qualifiedName: appendQualified(context.scope, name),
            signature: this.signatureBetween(startIndex, signatureEnd),
            range: this.rangeOf(startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            nameRange: this.nameRangeOf(nameNode),
            docRange: this.docRangeOf(node),
            paramTypes: parameters.types,
            paramTexts: parameters.texts,
            access: this.accessOf(node) ?? context.access ?? "public",
            isDefinition: body !== null,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);

        if (body !== null) {
            this.visitNode(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
                local: true,
            });
        }
    }

    private visitField(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "property_identifier") ??
            findFirst(node, "private_property_identifier") ??
            null;

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const declaration: Declaration = {
            kind: "field",
            name,
            qualifiedName: appendQualified(context.scope, name),
            signature: this.signatureBetween(node.startIndex, node.endIndex),
            range: this.rangeOf(node.startIndex, node.endIndex),
            nameRange: this.nameRangeOf(nameNode),
            docRange: this.docRangeOf(node),
            paramTypes: [],
            access: this.accessOf(node) ?? context.access ?? "public",
            isDefinition: node.type !== "property_signature",
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier") ?? null;

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const body = node.childForFieldName("body") ?? null;
        const startIndex = context.signatureStart ?? node.startIndex;
        const signatureEnd = body?.startIndex ?? node.endIndex;
        const parameters = this.paramTypesOf(node);
        const declaration: Declaration = {
            kind: "function",
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
            isDefinition: body !== null,
            children: [],
            language: this.language,
        };

        this.push(declaration, context.parent);

        if (body !== null) {
            this.visitNode(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
                local: true,
            });
        }
    }

    private visitVariables(node: SyntaxNode, context: ScopeContext): void {
        const startIndex = context.signatureStart ?? node.startIndex;
        const declarators = namedChildren(node).filter(
            (child) => child.type === "variable_declarator",
        );

        for (const declarator of declarators) {
            const nameNode =
                declarator.childForFieldName("name") ?? findFirst(declarator, "identifier") ?? null;

            if (nameNode === null) {
                continue;
            }

            const name = cleanName(this.textOf(nameNode));
            const value = declarator.childForFieldName("value") ?? null;
            const functionValue = isFunctionValue(value);
            const body = functionValue ? (value?.childForFieldName("body") ?? null) : null;

            if (context.local === true && !functionValue) {
                continue;
            }

            const parameters = functionValue ? this.paramTypesOf(value) : undefined;
            const kind: DeclarationKind = functionValue ? "function" : "variable";
            const signatureEnd =
                functionValue && body?.type === "statement_block"
                    ? body.startIndex
                    : (value?.endIndex ?? node.endIndex);
            const declaration: Declaration = {
                kind,
                name,
                qualifiedName: appendQualified(context.scope, name),
                signature: this.signatureBetween(startIndex, signatureEnd),
                range: this.rangeOf(startIndex, node.endIndex),
                bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
                nameRange: this.nameRangeOf(nameNode),
                docRange: this.docRangeOf(context.docAnchor ?? node),
                paramTypes: parameters?.types ?? [],
                paramTexts: parameters?.texts,
                access: context.access,
                isDefinition: true,
                children: [],
                language: this.language,
            };

            this.push(declaration, context.parent);

            if (functionValue && body !== null) {
                this.visitNode(body, {
                    scope: declaration.qualifiedName,
                    parent: declaration,
                    local: true,
                });
            }
        }
    }

    /**
     * A statement-level call whose first argument is a string literal and whose last argument is a function.
     *
     * The shape is the whole rule, and that is the point: a named block is `something("name", ...) { ... }` in
     * every framework that has one - `describe`/`it`, a route with an inline handler, an event subscription, a
     * mocked module - so no callee allowlist is needed and a new framework needs no change here. `console.log("x")`
     * (no callback) and `router.get(path, handler)` (no literal) do not qualify; `vi.mock("fs", () => ...)` does,
     * which is the honest reading of the same shape.
     *
     * The callback is walked with `local: true`: a plain local inside a suite is not a declaration, but a nested
     * `it` is, which is what turns a test file into a tree.
     */
    private visitCallStatement(node: SyntaxNode, context: ScopeContext): void {
        const expression = namedChildren(node)[0];

        if (expression === undefined || expression.type !== "call_expression") {
            return;
        }

        const calleeNode = expression.childForFieldName("function");
        const argumentList = expression.childForFieldName("arguments");
        const args = argumentList === null ? [] : namedChildren(argumentList);
        const first = args[0];
        const last = args.at(-1);

        if (calleeNode === null || first === undefined || last === undefined) {
            return;
        }

        if (!isFunctionValue(last)) {
            return;
        }

        const name = stringLiteralValue(first, this.textOf(first));

        if (name === undefined) {
            return;
        }

        const callee = this.collapse(this.textOf(calleeNode));
        const body = last.childForFieldName("body") ?? null;
        const qualifiedName = appendQualified(context.scope, name);
        const declaration: Declaration = {
            kind: "block",
            name,
            qualifiedName,
            signature: `${callee}(${this.textOf(first)})`,
            range: this.rangeOf(node.startIndex, node.endIndex),
            bodyRange: body === null ? undefined : this.rangeOf(body.startIndex, body.endIndex),
            nameRange: this.nameRangeOf(first),
            docRange: this.docRangeOf(node),
            paramTypes: [],
            access: context.access,
            isDefinition: true,
            children: [],
            language: this.language,
            blockCallee: callee,
        };

        this.push(declaration, context.parent);

        if (body === null) {
            return;
        }

        this.visitNode(body, {
            scope: qualifiedName,
            parent: declaration,
            docAnchor: node,
            local: true,
        });
    }

    private visitEnum(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier") ?? null;
        const body = node.childForFieldName("body") ?? findFirst(node, "enum_body") ?? null;
        const name = nameNode === null ? "<anonymous>" : cleanName(this.textOf(nameNode));
        const qualifiedName = appendQualified(context.scope, name);
        const startIndex = context.signatureStart ?? node.startIndex;
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
            const nameNode =
                child.type === "property_identifier"
                    ? child
                    : findFirst(child, "property_identifier");

            if (nameNode === null) {
                continue;
            }

            const memberName = cleanName(this.textOf(nameNode));
            const member: Declaration = {
                kind: "enumMember",
                name: memberName,
                qualifiedName: appendQualified(qualifiedName, memberName),
                signature: this.signatureBetween(child.startIndex, child.endIndex),
                range: this.rangeOf(child.startIndex, child.endIndex),
                nameRange: this.nameRangeOf(nameNode),
                paramTypes: [],
                access: context.access,
                isDefinition: true,
                children: [],
                language: this.language,
            };

            this.push(member, declaration);
        }
    }

    private visitTypeAlias(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ?? findFirst(node, "type_identifier") ?? null;

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const startIndex = context.signatureStart ?? node.startIndex;
        const declaration: Declaration = {
            kind: "typeAlias",
            name,
            qualifiedName: appendQualified(context.scope, name),
            signature: this.signatureBetween(startIndex, node.endIndex),
            range: this.rangeOf(startIndex, node.endIndex),
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

    private paramTypesOf(functionNode: SyntaxNode): { types: string[]; texts: string[] } {
        const parameters =
            functionNode.childForFieldName("parameters") ??
            findFirst(functionNode, "formal_parameters");

        if (parameters === null) {
            return { types: [], texts: [] };
        }

        const types: string[] = [];
        const texts: string[] = [];

        for (const parameter of namedChildren(parameters)) {
            if (parameter.type === "comment") {
                continue;
            }

            const typeNode = parameter.childForFieldName("type");
            const pattern = parameter.childForFieldName("pattern");
            const raw = typeNode === null ? "" : this.textOf(typeNode).replace(/^:\s*/, "");
            let text = normalizeType(raw);

            if (pattern?.type === "rest_pattern" && text.length > 0) {
                text = `...${text}`;
            }

            if (text.length > 0 && text !== "void") {
                types.push(text);
                texts.push(text);
            }
        }

        return { types, texts };
    }

    private accessOf(node: SyntaxNode): Access | undefined {
        for (const child of namedChildren(node)) {
            if (child.type !== "accessibility_modifier") {
                continue;
            }

            const text = cleanName(this.textOf(child));

            if (text === "public" || text === "protected" || text === "private") {
                return text;
            }
        }

        return undefined;
    }

    private push(declaration: Declaration, parent: Declaration | undefined): void {
        const key = [
            declaration.qualifiedName,
            declaration.kind,
            declaration.isDefinition ? "def" : "decl",
            declaration.signature,
            declaration.paramTypes.join(","),
            // Two suites may share a title in one file. Unlike a declaration and its definition, which the key
            // exists to pair, they are different blocks, so their position is part of their identity.
            declaration.kind === "block" ? declaration.range.startIndex : "",
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

    private signatureBetween(startIndex: number, endIndex: number): string {
        const text = stripComments(this.source.slice(startIndex, endIndex)).replace(/;\s*$/, "");

        return this.collapse(text);
    }

    private collapse(text: string): string {
        return text
            .replace(/\s+/g, " ")
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
            .replace(/\s*,\s*/g, ", ")
            .trim();
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

function namedChildren(node: SyntaxNode): SyntaxNode[] {
    return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function findFirst(node: SyntaxNode, type: string): SyntaxNode | null {
    for (const child of namedChildren(node)) {
        if (child.type === type) {
            return child;
        }
    }

    return null;
}

function isFunctionValue(
    node: SyntaxNode | null,
): node is SyntaxNode & { type: "arrow_function" | "function_expression" | "function" } {
    return (
        node !== null &&
        (node.type === "arrow_function" ||
            node.type === "function_expression" ||
            node.type === "function")
    );
}

/**
 * The text inside a string or substitution-free template literal, collapsed to one line.
 *
 * A title is prose, so the surrounding quote marks and any indentation the source wrapped it in are not part of
 * the name a caller would search for. A template with a substitution is an expression, not a name, and is skipped.
 */
function stringLiteralValue(node: SyntaxNode, text: string): string | undefined {
    if (node.type !== "string" && node.type !== "template_string") {
        return undefined;
    }

    if (node.namedChildren.some((child) => child?.type === "template_substitution")) {
        return undefined;
    }

    // The surrounding quote marks are not part of the name. An escape sequence inside stays as written: a title is
    // matched the way the caller remembers it, not the way the runtime would evaluate it.
    const value = text
        .replace(/^["'`]/, "")
        .replace(/["'`]$/, "")
        .replace(/\s+/g, " ")
        .trim();

    return value.length === 0 ? undefined : value;
}

function appendQualified(scope: string, name: string): string {
    return scope.length === 0 ? name : `${scope}::${name}`;
}

function cleanName(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function normalizeType(type: string): string {
    return type.replace(/\s+/g, "").replace(/,$/, "");
}
