import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import {
    DeclarationVisitor,
    appendQualified,
    cleanName,
    findFirst,
    isCapitalizedName,
    namedChildren,
    normalizeType,
} from "./visitor";

export async function parseGoFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("go", source);
    const visitor = new GoVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "go",
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

class GoVisitor extends DeclarationVisitor {
    constructor(source: string) {
        super(source, "go");
    }

    visit(root: SyntaxNode): void {
        const packageClause = findFirst(root, "package_clause");
        const packageNode =
            packageClause === null ? null : findFirst(packageClause, "package_identifier");
        const scope = packageNode === null ? "" : cleanName(this.textOf(packageNode));

        this.visitContents(root, { scope });
    }

    private visitContents(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            this.visitNode(child, context);
        }
    }

    private visitNode(node: SyntaxNode, context: ScopeContext): void {
        switch (node.type) {
            case "source_file":
                this.visitContents(node, context);

                return;
            case "type_declaration":
                this.visitTypeDeclaration(node, context);

                return;
            case "function_declaration":
                this.visitFunction(node, context);

                return;
            case "method_declaration":
                this.visitMethod(node, context);

                return;
            case "const_declaration":
            case "var_declaration":
                this.visitVariables(node, context);

                return;
            case "ERROR":
                this.visitContents(node, context);

                return;
            default:
                return;
        }
    }

    private visitTypeDeclaration(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            if (child.type === "type_spec") {
                this.visitTypeSpec(child, context);
            }
        }
    }

    private visitTypeSpec(node: SyntaxNode, context: ScopeContext): void {
        const nameNode =
            node.childForFieldName("name") ?? findFirst(node, "type_identifier") ?? null;

        if (nameNode === null) {
            return;
        }

        const typeNode = node.childForFieldName("type") ?? namedChildren(node).at(-1) ?? null;
        const name = cleanName(this.textOf(nameNode));
        const body =
            typeNode === null
                ? null
                : typeNode.type === "struct_type"
                  ? findFirst(typeNode, "field_declaration_list")
                  : typeNode.type === "interface_type"
                    ? typeNode
                    : null;
        const kind =
            typeNode?.type === "struct_type"
                ? "struct"
                : typeNode?.type === "interface_type"
                  ? "interface"
                  : "typeAlias";
        const signatureEnd =
            typeNode?.type === "interface_type"
                ? typeNode.startIndex + "interface".length
                : (body?.startIndex ?? node.endIndex);
        const declaration = this.addDeclaration(
            {
                kind,
                name,
                scope: context.scope,
                startIndex:
                    node.parent?.type === "type_declaration"
                        ? node.parent.startIndex
                        : node.startIndex,
                endIndex: node.endIndex,
                signatureEnd,
                body,
                nameNode,
                docAnchor: node,
                access: isCapitalizedName(name) ? "public" : "private",
                isDefinition: typeNode !== null,
            },
            context.parent,
        );

        if (typeNode?.type === "struct_type") {
            this.visitStructFields(typeNode, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        } else if (typeNode?.type === "interface_type") {
            this.visitInterfaceMethods(typeNode, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }

    private visitStructFields(node: SyntaxNode, context: ScopeContext): void {
        const fields = findFirst(node, "field_declaration_list");

        if (fields === null) {
            return;
        }

        for (const field of namedChildren(fields)) {
            if (field.type !== "field_declaration") {
                continue;
            }

            const names = namedChildren(field).filter((child) => child.type === "field_identifier");
            const embedded =
                names.length === 0
                    ? ([...namedChildren(field)]
                          .reverse()
                          .find((child) => child.type === "type_identifier") ?? null)
                    : null;

            for (const nameNode of embedded === null ? names : [embedded]) {
                if (nameNode === null) {
                    continue;
                }

                const name = cleanName(this.textOf(nameNode));

                this.addDeclaration(
                    {
                        kind: "field",
                        name,
                        scope: context.scope,
                        startIndex: field.startIndex,
                        endIndex: field.endIndex,
                        signatureEnd: field.endIndex,
                        nameNode,
                        docAnchor: field,
                        access: isCapitalizedName(name) ? "public" : "private",
                        isDefinition: true,
                    },
                    context.parent,
                );
            }
        }
    }

    private visitInterfaceMethods(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            if (child.type !== "method_elem") {
                continue;
            }

            const nameNode =
                child.childForFieldName("name") ?? findFirst(child, "field_identifier") ?? null;

            if (nameNode === null) {
                continue;
            }

            const parameters = this.parametersOf(child);

            this.addDeclaration(
                {
                    kind: "method",
                    name: cleanName(this.textOf(nameNode)),
                    scope: context.scope,
                    startIndex: child.startIndex,
                    endIndex: child.endIndex,
                    signatureEnd: child.endIndex,
                    nameNode,
                    docAnchor: child,
                    paramTypes: parameters.types,
                    paramTexts: parameters.texts,
                    access: "public",
                    isDefinition: false,
                },
                context.parent,
            );
        }
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier") ?? null;

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "block");
        const parameters = this.parametersOf(node);
        const name = cleanName(this.textOf(nameNode));

        this.addDeclaration(
            {
                kind: "function",
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
                access: isCapitalizedName(name) ? "public" : "private",
                isDefinition: body !== null,
            },
            context.parent,
        );
    }

    private visitMethod(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "field_identifier");

        if (nameNode === null) {
            return;
        }

        const receiverName = this.receiverTypeName(node);
        const scope =
            receiverName === null ? context.scope : appendQualified(context.scope, receiverName);
        const parent = this.declarationByQualifiedName(scope) ?? context.parent;
        const body = node.childForFieldName("body") ?? findFirst(node, "block");
        const parameters = this.parametersOf(node);
        const name = cleanName(this.textOf(nameNode));

        this.addDeclaration(
            {
                kind: "method",
                name,
                scope,
                startIndex: node.startIndex,
                endIndex: node.endIndex,
                signatureEnd: body?.startIndex ?? node.endIndex,
                body,
                nameNode,
                docAnchor: node,
                paramTypes: parameters.types,
                paramTexts: parameters.texts,
                access: isCapitalizedName(name) ? "public" : "private",
                isDefinition: body !== null,
            },
            parent,
        );
    }

    private visitVariables(node: SyntaxNode, context: ScopeContext): void {
        const specType = node.type === "const_declaration" ? "const_spec" : "var_spec";

        for (const spec of namedChildren(node)) {
            if (spec.type !== specType) {
                continue;
            }

            for (const nameNode of fieldNodes(spec, "name")) {
                const name = cleanName(this.textOf(nameNode));

                this.addDeclaration(
                    {
                        kind: "variable",
                        name,
                        scope: context.scope,
                        startIndex: node.startIndex,
                        endIndex: node.endIndex,
                        signatureEnd: node.endIndex,
                        nameNode,
                        docAnchor: node,
                        access: isCapitalizedName(name) ? "public" : "private",
                        isDefinition: true,
                    },
                    context.parent,
                );
            }
        }
    }

    private receiverTypeName(node: SyntaxNode): string | null {
        const receiver = node.childForFieldName("receiver");

        if (receiver === null) {
            return null;
        }

        const parameter = namedChildren(receiver).find(
            (child) => child.type === "parameter_declaration",
        );
        const typeNode = parameter?.childForFieldName("type") ?? null;
        const typeIdentifier = typeNode === null ? null : findFirst(typeNode, "type_identifier");
        const named =
            typeIdentifier ?? (typeNode === null ? null : findFirst(typeNode, "identifier"));

        return named === null ? null : cleanName(this.textOf(named));
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
            if (
                parameter.type !== "parameter_declaration" &&
                parameter.type !== "variadic_parameter_declaration"
            ) {
                continue;
            }

            const typeNode = parameter.childForFieldName("type");

            if (typeNode === null) {
                continue;
            }

            const text = normalizeType(this.textOf(typeNode));

            if (text.length > 0) {
                types.push(
                    parameter.type === "variadic_parameter_declaration" ? `...${text}` : text,
                );
                texts.push(cleanName(this.textOf(typeNode)));
            }
        }

        return { types, texts };
    }
}

function fieldNodes(node: SyntaxNode, field: string): SyntaxNode[] {
    const matches: SyntaxNode[] = [];

    for (let index = 0; index < node.childCount; index += 1) {
        const child = node.child(index);

        if (child !== null && child.isNamed && node.fieldNameForChild(index) === field) {
            matches.push(child);
        }
    }

    return matches;
}
