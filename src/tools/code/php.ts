import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Access, Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import {
    DeclarationVisitor,
    accessOfModifiers,
    appendQualified,
    cleanName,
    findFirst,
    namedChildren,
    normalizeType,
} from "./visitor";

export async function parsePhpFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("php", source);
    const visitor = new PhpVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "php",
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
}

class PhpVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "php");
    }

    visit(root: SyntaxNode): void {
        this.visitProgram(root, { scope: "" });
    }

    private visitProgram(node: SyntaxNode, context: ScopeContext): void {
        let scope = context.scope;

        for (const child of namedChildren(node)) {
            if (child.type === "namespace_definition") {
                const name = namespaceName(child, this.source);
                const body =
                    child.childForFieldName("body") ??
                    findFirst(child, "compound_statement") ??
                    null;

                if (body === null) {
                    scope = appendQualified(context.scope, name);

                    continue;
                }

                this.visitNamespace(child, { ...context, scope });

                continue;
            }

            this.visitNode(child, { ...context, scope });
        }
    }

    private visitNode(node: SyntaxNode, context: ScopeContext): void {
        switch (node.type) {
            case "program":
            case "declaration_list":
            case "ERROR":
                this.visitProgram(node, context);

                return;
            case "namespace_definition":
                this.visitNamespace(node, context);

                return;
            case "class_declaration":
            case "interface_declaration":
            case "trait_declaration":
            case "enum_declaration":
                this.visitType(node, context);

                return;
            case "function_definition":
            case "method_declaration":
                this.visitFunction(node, context);

                return;
            case "property_declaration":
                this.visitProperties(node, context);

                return;
            case "const_declaration":
                this.visitConstants(node, context);

                return;
            case "enum_case":
                this.visitEnumCase(node, context);

                return;
            default:
                return;
        }
    }

    private visitNamespace(node: SyntaxNode, context: ScopeContext): void {
        const name = namespaceName(node, this.source);
        const body =
            node.childForFieldName("body") ?? findFirst(node, "compound_statement") ?? null;
        const declaration = this.addDeclaration(
            {
                kind: "namespace",
                name,
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                docAnchor: node,
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitProgram(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }

    private visitType(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "name");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "declaration_list");
        const declaration = this.addDeclaration(
            {
                kind: typeKind(node.type),
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: node,
                access: accessOfModifiers(node, this.source) ?? context.access ?? "public",
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitProgram(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
                access: declaration.access,
            });
        }
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "name");

        if (nameNode === null) {
            return;
        }

        const name = cleanName(this.textOf(nameNode));
        const body = node.childForFieldName("body") ?? findFirst(node, "compound_statement");
        const parameters = this.parametersOf(node);
        const kind =
            name === "__construct"
                ? "constructor"
                : name === "__destruct"
                  ? "destructor"
                  : context.parent === undefined
                    ? "function"
                    : "method";

        this.addDeclaration(
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
                paramTypes: parameters.types,
                paramTexts: parameters.texts,
                access:
                    accessOfModifiers(node, this.source) ??
                    context.access ??
                    (context.parent?.kind === "class" ? "public" : undefined),
                isDefinition: body !== null,
            },
            context.parent,
        );
    }

    private visitProperties(node: SyntaxNode, context: ScopeContext): void {
        for (const element of namedChildren(node)) {
            if (element.type !== "property_element") {
                continue;
            }

            const nameNode =
                element.childForFieldName("name") ?? findFirst(element, "variable_name");

            if (nameNode === null) {
                continue;
            }

            this.addDeclaration(
                {
                    kind: "field",
                    name: cleanName(this.textOf(nameNode)).replace(/^\$/, ""),
                    scope: context.scope,
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    signatureEnd: node.endIndex,
                    nameNode,
                    docAnchor: node,
                    access: accessOfModifiers(node, this.source) ?? context.access ?? "public",
                    isDefinition: true,
                },
                context.parent,
            );
        }
    }

    private visitConstants(node: SyntaxNode, context: ScopeContext): void {
        for (const element of namedChildren(node)) {
            if (element.type !== "const_element") {
                continue;
            }

            const nameNode = element.childForFieldName("name") ?? findFirst(element, "name");

            if (nameNode === null) {
                continue;
            }

            this.addDeclaration(
                {
                    kind: context.parent === undefined ? "variable" : "field",
                    name: cleanName(this.textOf(nameNode)),
                    scope: context.scope,
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    signatureEnd: node.endIndex,
                    nameNode,
                    docAnchor: node,
                    access: accessOfModifiers(node, this.source) ?? context.access,
                    isDefinition: true,
                },
                context.parent,
            );
        }
    }

    private visitEnumCase(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "name");

        if (nameNode === null) {
            return;
        }

        this.addDeclaration(
            {
                kind: "enumMember",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: node.endIndex,
                nameNode,
                docAnchor: node,
                isDefinition: true,
            },
            context.parent,
        );
    }

    private parametersOf(node: SyntaxNode): { types: string[]; texts: string[] } {
        const parameters =
            node.childForFieldName("parameters") ?? findFirst(node, "formal_parameters");

        if (parameters === null) {
            return { types: [], texts: [] };
        }

        const types: string[] = [];
        const texts: string[] = [];

        for (const parameter of namedChildren(parameters)) {
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

function namespaceName(node: SyntaxNode, source: string): string {
    const nameNode = node.childForFieldName("name") ?? findFirst(node, "namespace_name");
    const text = nameNode === null ? "" : source.slice(nameNode.startIndex, nameNode.endIndex);

    return cleanName(text).replace(/\\/g, "::");
}

function typeKind(type: string): "class" | "interface" | "trait" | "enum" {
    if (type === "interface_declaration") {
        return "interface";
    }

    if (type === "trait_declaration") {
        return "trait";
    }

    if (type === "enum_declaration") {
        return "enum";
    }

    return "class";
}
