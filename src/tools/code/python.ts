import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import { DeclarationVisitor, cleanName, findFirst, namedChildren, normalizeType } from "./visitor";

export async function parsePythonFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("python", source);
    const visitor = new PythonVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "python",
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
    signatureStart?: number;
    docAnchor?: SyntaxNode;
    local?: boolean;
}

const LOCAL_BLOCK_NODES = new Set([
    "block",
    "case_clause",
    "else_clause",
    "except_clause",
    "finally_clause",
    "for_statement",
    "if_statement",
    "match_statement",
    "try_statement",
    "while_statement",
    "with_statement",
]);

class PythonVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "python");
    }

    visit(root: SyntaxNode): void {
        this.visitContents(root, { scope: "" });
    }

    private visitContents(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            this.visitNode(child, context);
        }
    }

    private visitNode(node: SyntaxNode, context: ScopeContext): void {
        switch (node.type) {
            case "module":
            case "block":
            case "ERROR":
                this.visitContents(node, context);

                return;
            case "decorated_definition":
                this.visitDecorated(node, context);

                return;
            case "class_definition":
                this.visitClass(node, context);

                return;
            case "function_definition":
                this.visitFunction(node, context);

                return;
            default:
                if (context.local === true && LOCAL_BLOCK_NODES.has(node.type)) {
                    this.visitContents(node, context);
                }

                return;
        }
    }

    private visitDecorated(node: SyntaxNode, context: ScopeContext): void {
        const definition = namedChildren(node).find(
            (child) => child.type === "function_definition" || child.type === "class_definition",
        );

        if (definition === undefined) {
            return;
        }

        this.visitNode(definition, {
            ...context,
            signatureStart: context.signatureStart ?? node.startIndex,
            docAnchor: context.docAnchor ?? node,
        });
    }

    private visitClass(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "block");
        const declaration = this.addDeclaration(
            {
                kind: "class",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: context.signatureStart ?? node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: context.docAnchor ?? node,
                access: context.parent?.kind === "class" ? "public" : undefined,
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitContents(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
                local: context.local,
            });
        }
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "block");
        const parameters = this.parametersOf(node);
        const name = cleanName(this.textOf(nameNode));
        const kind =
            context.parent?.kind === "class"
                ? name === "__init__"
                    ? "constructor"
                    : "method"
                : "function";

        const declaration = this.addDeclaration(
            {
                kind,
                name,
                scope: context.scope,
                startIndex: context.signatureStart ?? node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: context.docAnchor ?? node,
                paramTypes: parameters.types,
                paramTexts: parameters.texts,
                access: context.parent?.kind === "class" ? "public" : undefined,
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitContents(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
                local: true,
            });
        }
    }

    private parametersOf(node: SyntaxNode): { types: string[]; texts: string[] } {
        const parameters = node.childForFieldName("parameters") ?? findFirst(node, "parameters");

        if (parameters === null) {
            return { types: [], texts: [] };
        }

        const types: string[] = [];
        const texts: string[] = [];

        for (const parameter of namedChildren(parameters)) {
            if (
                parameter.type !== "typed_parameter" &&
                parameter.type !== "typed_default_parameter"
            ) {
                continue;
            }

            const typeNode = parameter.childForFieldName("type");

            if (typeNode === null) {
                continue;
            }

            const text = normalizeType(this.textOf(typeNode));

            if (text.length > 0) {
                types.push(text);
                texts.push(cleanName(this.textOf(typeNode)));
            }
        }

        return { types, texts };
    }
}
