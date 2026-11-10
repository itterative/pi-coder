import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Access, Declaration, ParsedFile } from "./types";
import { countParseErrors, parseSyntax } from "./tree-sitter";
import {
    DeclarationVisitor,
    accessOfModifiers,
    cleanName,
    findFirst,
    namedChildren,
    normalizeType,
} from "./visitor";

export async function parseJavaFile(source: string, filePath: string): Promise<ParsedFile> {
    const { root } = await parseSyntax("java", source);
    const visitor = new JavaVisitor(source);

    visitor.visit(root);

    return {
        path: filePath,
        language: "java",
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

class JavaVisitor extends DeclarationVisitor {
    private packageName = "";

    constructor(source: string) {
        super(source, "java");
    }

    visit(root: SyntaxNode): void {
        const packageNode = findFirst(root, "package_declaration");
        const packageName = packageNode === null ? null : (namedChildren(packageNode)[0] ?? null);

        this.packageName = packageName === null ? "" : normalizePackage(this.textOf(packageName));
        this.visitProgram(root, { scope: this.packageName });
    }

    private visitProgram(node: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(node)) {
            this.visitNode(child, context);
        }
    }

    private visitNode(node: SyntaxNode, context: ScopeContext): void {
        switch (node.type) {
            case "program":
                this.visitProgram(node, context);

                return;
            case "class_declaration":
            case "interface_declaration":
            case "enum_declaration":
            case "record_declaration":
            case "annotation_type_declaration":
                this.visitType(node, context);

                return;
            case "method_declaration":
            case "constructor_declaration":
                this.visitFunction(node, context);

                return;
            case "field_declaration":
                this.visitFields(node, context);

                return;
            case "enum_constant":
                this.visitEnumConstant(node, context);

                return;
            case "enum_body_declarations":
            case "ERROR":
                this.visitProgram(node, context);

                return;
            default:
                return;
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

        const name = cleanName(this.textOf(nameNode));
        const body =
            node.childForFieldName("body") ??
            findFirst(node, "class_body") ??
            findFirst(node, "interface_body") ??
            findFirst(node, "enum_body") ??
            null;
        const kind = typeKind(node.type);
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
                access: accessOfModifiers(node, this.source) ?? "public",
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitMembers(body, {
                scope: declaration.qualifiedName,
                parent: declaration,
            });
        }
    }

    private visitMembers(body: SyntaxNode, context: ScopeContext): void {
        for (const child of namedChildren(body)) {
            switch (child.type) {
                case "class_declaration":
                case "interface_declaration":
                case "enum_declaration":
                case "record_declaration":
                case "annotation_type_declaration":
                    this.visitType(child, context);

                    break;
                case "method_declaration":
                case "constructor_declaration":
                    this.visitFunction(child, context);

                    break;
                case "field_declaration":
                    this.visitFields(child, context);

                    break;
                case "enum_constant":
                    this.visitEnumConstant(child, context);

                    break;
                case "enum_body_declarations":
                    this.visitMembers(child, context);

                    break;
                default:
                    break;
            }
        }
    }

    private visitFunction(node: SyntaxNode, context: ScopeContext): void {
        const nameNode = node.childForFieldName("name") ?? findFirst(node, "identifier") ?? null;

        if (nameNode === null) {
            return;
        }

        const body = node.childForFieldName("body") ?? findFirst(node, "block") ?? null;
        const parameters = this.parametersOf(node);
        const declaration = this.addDeclaration(
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
                access: accessOfModifiers(node, this.source) ?? context.access ?? "public",
                isDefinition: body !== null,
            },
            context.parent,
        );

        if (body !== null) {
            this.visitLocalTypes(body, declaration);
        }
    }

    private visitFields(node: SyntaxNode, context: ScopeContext): void {
        const declarators = namedChildren(node).filter(
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
                    access: accessOfModifiers(node, this.source) ?? context.access ?? "public",
                    isDefinition: true,
                },
                context.parent,
            );
        }
    }

    private visitEnumConstant(node: SyntaxNode, context: ScopeContext): void {
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

    private visitLocalTypes(body: SyntaxNode, parent: Declaration): void {
        for (const child of namedChildren(body)) {
            if (
                child.type === "class_declaration" ||
                child.type === "interface_declaration" ||
                child.type === "enum_declaration" ||
                child.type === "record_declaration"
            ) {
                this.visitType(child, {
                    scope: parent.qualifiedName,
                    parent,
                });
            }
        }
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
            if (parameter.type !== "formal_parameter" && parameter.type !== "receiver_parameter") {
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

function typeKind(type: string): "class" | "interface" | "enum" {
    if (type === "interface_declaration" || type === "annotation_type_declaration") {
        return "interface";
    }

    if (type === "enum_declaration") {
        return "enum";
    }

    return "class";
}

function normalizePackage(text: string): string {
    return cleanName(text).replace(/\./g, "::");
}
