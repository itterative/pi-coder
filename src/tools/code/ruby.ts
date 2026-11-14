import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import { DeclarationVisitor, cleanName, findFirst, namedChildren } from "./visitor";

export async function parseRubyFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("ruby", source);
    const visitor = new RubyVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "ruby",
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
}

class RubyVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "ruby");
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
            case "program":
            case "body_statement":
            case "ERROR":
                this.visitContents(node, context);

                return;
            case "module":
                this.visitModule(node, context);

                return;
            case "class":
                this.visitClass(node, context);

                return;
            case "method":
            case "singleton_method":
                this.visitMethod(node, context);

                return;
            case "assignment":
                this.visitAssignment(node, context);

                return;
            default:
                return;
        }
    }

    /**
     * A module or class constant.
     *
     * Ruby itself decides what a constant is: a capitalised target. A lowercase assignment is a local, and a method
     * body is never walked into, so everything reached here is a declaration the file's map should show.
     */
    private visitAssignment(node: SyntaxNode, context: ScopeContext): void {
        const left = node.childForFieldName("left");

        if (left === null || left.type !== "constant") {
            return;
        }

        this.addDeclaration(
            {
                kind: "variable",
                name: cleanName(this.textOf(left)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: node.endIndex,
                body: null,
                nameNode: left,
                docAnchor: node,
                isDefinition: true,
            },
            context.parent,
        );
    }

    private visitModule(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "constant");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "body_statement");
        const declaration = this.addDeclaration(
            {
                kind: "namespace",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: node,
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitContents(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }

    private visitClass(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "constant");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "body_statement");
        const declaration = this.addDeclaration(
            {
                kind: "class",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: node,
                access: context.parent?.kind === "class" ? "public" : undefined,
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitContents(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }

    private visitMethod(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "identifier") ??
            findFirst(node, "constant");

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const body = node.childForFieldName("body") ?? findFirst(node, "body_statement");
        const kind =
            context.parent?.kind === "class" && name === "initialize"
                ? "constructor"
                : context.parent === undefined
                  ? "function"
                  : "method";

        const declaration = this.addDeclaration(
            {
                kind,
                name,
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: node,
                access: context.parent?.kind === "class" ? "public" : undefined,
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitContents(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }
}
