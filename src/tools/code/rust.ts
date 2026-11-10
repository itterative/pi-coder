import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Access, Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import {
    DeclarationVisitor,
    appendQualified,
    cleanName,
    findFirst,
    namedChildren,
    normalizeType,
} from "./visitor";

export async function parseRustFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("rust", source);
    const visitor = new RustVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "rust",
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

class RustVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "rust");
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
            case "source_file":
            case "declaration_list":
            case "ERROR":
                this.visitContents(node, context);

                return;
            case "mod_item":
                this.visitModule(node, context);

                return;
            case "struct_item":
            case "enum_item":
            case "trait_item":
            case "union_item":
                this.visitType(node, context);

                return;
            case "impl_item":
                this.visitImpl(node, context);

                return;
            case "function_item":
            case "function_signature_item":
                this.visitFunction(node, context);

                return;
            case "const_item":
            case "static_item":
                this.visitVariable(node, context);

                return;
            case "type_item":
                this.visitAlias(node, context);

                return;
            default:
                return;
        }
    }

    private visitModule(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "declaration_list");
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
                access: visibilityOf(node, this.source),
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
            findFirst(node, "type_identifier") ??
            findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        const body = this.typeBody(node);
        const kind = typeKind(node.type);
        const declaration = this.addDeclaration(
            {
                kind,
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: node,
                access: visibilityOf(node, this.source),
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body === null) {
            return;
        }

        if (node.type === "struct_item" || node.type === "union_item") {
            this.visitFields(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        } else if (node.type === "enum_item") {
            this.visitVariants(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        } else {
            this.visitContents(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }

    private visitImpl(node: SyntaxNode, context: ScopeContext): void {
        const typeNode =
            node.childForFieldName("type") ??
            findFirst(node, "type_identifier") ??
            findFirst(node, "generic_type");

        if (typeNode === null) {
            return;
        }

        const typeIdentifier = findFirst(typeNode, "type_identifier") ?? typeNode;
        const typeName = cleanName(this.textOf(typeIdentifier));
        const scope = appendQualified(context.scope, typeName);
        const parent = this.declarationByQualifiedName(scope) ?? context.parent;
        const body = node.childForFieldName("body") ?? findFirst(node, "declaration_list");

        if (body !== null) {
            this.visitContents(body, { scope, parent });
        }
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "identifier") ??
            findFirst(node, "field_identifier");

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "block");
        const parameters = this.parametersOf(node);
        const kind =
            context.parent?.kind === "interface" ||
            context.parent?.kind === "class" ||
            context.parent?.kind === "struct" ||
            context.parent?.kind === "union"
                ? "method"
                : "function";

        this.addDeclaration(
            {
                kind,
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
                    context.parent?.kind === "interface"
                        ? "public"
                        : visibilityOf(node, this.source),
                isDefinition: body !== null,
            },
            context.parent,
        );
    }

    private visitVariable(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        this.addDeclaration(
            {
                kind: "variable",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: node.endIndex,
                nameNode,
                docAnchor: node,
                access: visibilityOf(node, this.source),
                isDefinition: true,
            },
            context.parent,
        );
    }

    private visitAlias(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ??
            findFirst(node, "type_identifier") ??
            findFirst(node, "identifier");

        if (nameNode === null) {
            return;
        }

        this.addDeclaration(
            {
                kind: "typeAlias",
                name: cleanName(this.textOf(nameNode)),
                scope: context.scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: node.endIndex,
                nameNode,
                docAnchor: node,
                access: visibilityOf(node, this.source),
                isDefinition: true,
            },
            context.parent,
        );
    }

    private visitFields(node: SyntaxNode, context: ScopeContext): void {
        for (const field of namedChildren(node)) {
            if (field.type !== "field_declaration") {
                continue;
            }

            const nameNode =
                field.childForFieldName("name") ??
                findFirst(field, "field_identifier") ??
                findFirst(field, "identifier");

            if (nameNode === null) {
                continue;
            }

            this.addDeclaration(
                {
                    kind: "field",
                    name: cleanName(this.textOf(nameNode)),
                    scope: context.scope,
                    startIndex: field.startIndex,
                    endIndex: field.endIndex,
                    signatureEnd: field.endIndex,
                    nameNode,
                    docAnchor: field,
                    access: visibilityOf(field, this.source),
                    isDefinition: true,
                },
                context.parent,
            );
        }
    }

    private visitVariants(node: SyntaxNode, context: ScopeContext): void {
        for (const variant of namedChildren(node)) {
            if (variant.type !== "enum_variant") {
                continue;
            }

            const nameNode = variant.childForFieldName("name") ?? findFirst(variant, "identifier");

            if (nameNode === null) {
                continue;
            }

            this.addDeclaration(
                {
                    kind: "enumMember",
                    name: cleanName(this.textOf(nameNode)),
                    scope: context.scope,
                    startIndex: variant.startIndex,
                    endIndex: variant.endIndex,
                    signatureEnd: variant.endIndex,
                    nameNode,
                    docAnchor: variant,
                    isDefinition: true,
                },
                context.parent,
            );
        }
    }

    private typeBody(node: SyntaxNode): SyntaxNode | null {
        if (node.type === "struct_item" || node.type === "union_item") {
            return (
                node.childForFieldName("body") ??
                findFirst(node, "field_declaration_list") ??
                findFirst(node, "ordered_field_declaration_list")
            );
        }

        if (node.type === "enum_item") {
            return node.childForFieldName("body") ?? findFirst(node, "enum_variant_list");
        }

        return node.childForFieldName("body") ?? findFirst(node, "declaration_list");
    }

    private parametersOf(node: SyntaxNode): { types: string[]; texts: string[] } {
        const parameters = node.childForFieldName("parameters") ?? findFirst(node, "parameters");

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

function typeKind(type: string): "struct" | "enum" | "interface" | "union" {
    if (type === "trait_item") {
        return "interface";
    }

    if (type === "enum_item") {
        return "enum";
    }

    if (type === "union_item") {
        return "union";
    }

    return "struct";
}

function visibilityOf(node: SyntaxNode, source: string): Access | undefined {
    const visibility = findFirst(node, "visibility_modifier");

    if (visibility === null) {
        return undefined;
    }

    const text = source.slice(visibility.startIndex, visibility.endIndex);

    return text.startsWith("pub") ? "public" : undefined;
}
