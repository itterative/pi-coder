import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import {
    DeclarationVisitor,
    accessOfModifiers,
    cleanName,
    findFirst,
    namedChildren,
    normalizeType,
} from "./visitor";

export async function parseCSharpFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("c-sharp", source);
    const visitor = new CSharpVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "csharp",
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

class CSharpVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "csharp");
    }

    visit(root: SyntaxNode): void {
        const fileScoped = findFirst(root, "file_scoped_namespace_declaration");
        const nameNode = fileScoped?.childForFieldName("name") ?? null;
        const scope = nameNode === null ? "" : normalizeNamespace(this.textOf(nameNode));

        this.visitContents(root, { scope });
    }

    private visitContents(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            if (child.type === "file_scoped_namespace_declaration") {
                continue;
            }

            this.visitNode(child, context);
        }
    }

    private visitNode(node: SyntaxNode, context: ScopeContext): void {
        switch (node.type) {
            case "compilation_unit":
                this.visitContents(node, context);

                return;
            case "namespace_declaration":
                this.visitNamespace(node, context);

                return;
            case "class_declaration":
            case "interface_declaration":
            case "struct_declaration":
            case "record_declaration":
            case "enum_declaration":
                this.visitType(node, context);

                return;
            case "method_declaration":
            case "constructor_declaration":
                this.visitFunction(node, context);

                return;
            case "field_declaration":
                this.visitFields(node, context);

                return;
            case "property_declaration":
                this.visitProperty(node, context);

                return;
            case "enum_member_declaration":
                this.visitEnumMember(node, context);

                return;
            case "declaration_list":
                this.visitContents(node, context);

                return;
            case "ERROR":
                this.visitContents(node, context);

                return;
            default:
                return;
        }
    }

    private visitNamespace(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "qualified_name");

        if (nameNode === null) {
            return;
        }

        const body =
            node.childForFieldName("body") ??
            findFirst(node, "declaration_list") ??
            findFirst(node, "namespace_body");
        const name = normalizeNamespace(this.textOf(nameNode));
        const declaration = this.addDeclaration(
            {
                kind: "namespace",
                name,
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

    private visitType(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "identifier") ??
            findFirst(node, "type_identifier") ??
            null;

        if (nameNode === null) {
            return;
        }

        const body =
            node.childForFieldName("body") ??
            findFirst(node, "declaration_list") ??
            findFirst(node, "enum_member_declaration_list");
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
                access:
                    accessOfModifiers(node, this.source) ??
                    (context.parent === undefined || context.parent.kind === "namespace"
                        ? "public"
                        : "private"),
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

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier") ?? null;

        if (nameNode === null) {
            return;
        }

        const body =
            node.childForFieldName("body") ??
            findFirst(node, "block") ??
            findFirst(node, "arrow_expression_clause");
        const parameters = this.parametersOf(node);

        this.addDeclaration(
            {
                kind: node.type === "constructor_declaration" ? "constructor" : "method",
                name: cleanName(this.textOf(nameNode)),
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
                    (context.parent?.kind === "interface" ? "public" : "private"),
                isDefinition: body !== null,
            },
            context.parent,
        );
    }

    private visitFields(node: SyntaxNode, context: ScopeContext): void {
        const declaration = findFirst(node, "variable_declaration");
        const declarators =
            declaration === null
                ? namedChildren(node).filter((child) => child.type === "variable_declarator")
                : namedChildren(declaration).filter(
                      (child) => child.type === "variable_declarator",
                  );

        for (const declarator of declarators) {
            const nameNode =
                declarator.childForFieldName("name") ?? findFirst(declarator, "identifier");

            if (nameNode === null) {
                continue;
            }

            this.addDeclaration(
                {
                    kind: "field",
                    name: cleanName(this.textOf(nameNode)),
                    scope: context.scope,
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    signatureEnd: node.endIndex,
                    nameNode,
                    docAnchor: node,
                    access:
                        accessOfModifiers(node, this.source) ??
                        (context.parent?.kind === "interface" ? "public" : "private"),
                    isDefinition: true,
                },
                context.parent,
            );
        }
    }

    private visitProperty(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        const accessors = node.childForFieldName("accessors") ?? findFirst(node, "accessor_list");

        this.addDeclaration(
            {
                kind: "field",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: accessors?.startIndex ?? node.endIndex,
                body: accessors,
                nameNode,
                docAnchor: node,
                access:
                    accessOfModifiers(node, this.source) ??
                    (context.parent?.kind === "interface" ? "public" : "private"),
                isDefinition: true,
            },
            context.parent,
        );
    }

    private visitEnumMember(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier");

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
            node.childForFieldName("parameters") ?? findFirst(node, "parameter_list");

        if (parameters === null) {
            return { types: [], texts: [] };
        }

        const types: string[] = [];
        const texts: string[] = [];

        for (const parameter of namedChildren(parameters)) {
            if (parameter.type !== "parameter") {
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

function typeKind(type: string): "class" | "interface" | "struct" | "enum" {
    if (type === "interface_declaration") {
        return "interface";
    }

    if (type === "struct_declaration") {
        return "struct";
    }

    if (type === "enum_declaration") {
        return "enum";
    }

    return "class";
}

function normalizeNamespace(text: string): string {
    return cleanName(text).replace(/\./g, "::");
}
