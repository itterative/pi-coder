import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

import type { Access, Declaration, DeclarationKind, DeclarationRange, NameRange } from "./types";

export interface DeclarationInput {
    kind: DeclarationKind;
    name: string;
    scope: string;
    startIndex: number;
    endIndex: number;
    /** End of the signature; normally the body start, or the node end for a declaration without a body. */
    signatureEnd: number;
    body?: SyntaxNode | null;
    nameNode?: SyntaxNode | null;
    docAnchor?: SyntaxNode | null;
    paramTypes?: readonly string[];
    paramTexts?: readonly string[];
    access?: Access;
    isDefinition: boolean;
    /** Override the normal dedupe key when repeated names are legitimately distinct (Markdown headings). */
    dedupeKey?: string;
}

/**
 * Shared declaration bookkeeping for language adapters.
 *
 * Adapters own their tree-sitter node types and scope rules. This base owns only the parts that must agree
 * across languages: line ranges, signature slicing, doc-comment adjacency, qualified names, and dedupe.
 */
export abstract class DeclarationVisitor {
    readonly roots: Declaration[] = [];
    readonly all: Declaration[] = [];
    readonly lineCount: number;

    protected readonly lineStarts: number[] = [0];
    private readonly seen = new Set<string>();

    constructor(
        protected readonly source: string,
        protected readonly language: string,
    ) {
        for (let index = 0; index < source.length; index += 1) {
            if (source[index] === "\n") {
                this.lineStarts.push(index + 1);
            }
        }

        this.lineCount = this.lineStarts.length;
    }

    abstract visit(root: SyntaxNode): void;

    protected addDeclaration(input: DeclarationInput, parent?: Declaration): Declaration {
        const qualifiedName = appendQualified(input.scope, input.name);
        const declaration: Declaration = {
            kind: input.kind,
            name: input.name,
            qualifiedName,
            signature: this.signatureBetween(input.startIndex, input.signatureEnd),
            range: this.rangeOf(input.startIndex, input.endIndex),
            bodyRange:
                input.body === null || input.body === undefined
                    ? undefined
                    : this.rangeOf(input.body.startIndex, input.body.endIndex),
            nameRange:
                input.nameNode === null || input.nameNode === undefined
                    ? undefined
                    : this.nameRangeOf(input.nameNode),
            docRange: this.docRangeOf(input.docAnchor ?? null),
            paramTypes: [...(input.paramTypes ?? [])],
            paramTexts: input.paramTexts === undefined ? undefined : [...input.paramTexts],
            access: input.access,
            isDefinition: input.isDefinition,
            children: [],
            language: this.language,
        };

        this.push(declaration, parent, input.dedupeKey);

        return declaration;
    }

    protected push(
        declaration: Declaration,
        parent: Declaration | undefined,
        dedupeKey?: string,
    ): void {
        const key =
            dedupeKey ??
            [
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

    protected declarationByQualifiedName(qualifiedName: string): Declaration | undefined {
        return this.all.find((declaration) => declaration.qualifiedName === qualifiedName);
    }

    protected signatureBetween(startIndex: number, endIndex: number): string {
        const text = this.source
            .slice(startIndex, endIndex)
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/\/\/[^\n]*/g, " ")
            .replace(/;\s*$/, "");

        return this.collapse(text);
    }

    protected collapse(text: string): string {
        return text
            .replace(/\s+/g, " ")
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
            .replace(/\s*,\s*/g, ", ")
            .trim();
    }

    protected rangeOf(startIndex: number, endIndex: number): DeclarationRange {
        return {
            startLine: this.lineAt(startIndex),
            endLine: this.lineAt(Math.max(startIndex, endIndex - 1)),
            startIndex,
            endIndex,
        };
    }

    protected nameRangeOf(node: SyntaxNode): NameRange {
        return { startIndex: node.startIndex, endIndex: node.endIndex };
    }

    protected docRangeOf(anchor: SyntaxNode | null): NameRange | undefined {
        if (anchor === null) {
            return undefined;
        }

        const comments: SyntaxNode[] = [];
        let previous = anchor.previousNamedSibling ?? null;

        while (previous !== null && isCommentNode(previous)) {
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

    protected lineAt(index: number): number {
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

    protected textOf(node: SyntaxNode): string {
        return this.source.slice(node.startIndex, node.endIndex);
    }
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
    return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

export function findFirst(node: SyntaxNode, type: string): SyntaxNode | null {
    for (const child of namedChildren(node)) {
        if (child.type === type) {
            return child;
        }
    }

    return null;
}

export function findFirstAmong(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
    for (const child of namedChildren(node)) {
        if (types.has(child.type)) {
            return child;
        }
    }

    return null;
}

export function appendQualified(scope: string, name: string): string {
    return scope.length === 0 ? name : `${scope}::${name}`;
}

export function cleanName(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

export function normalizeType(type: string): string {
    return type.replace(/\s+/g, "").replace(/,$/, "");
}

export function accessFromText(text: string): Access | undefined {
    if (/\bprivate\b/.test(text)) {
        return "private";
    }

    if (/\bprotected\b/.test(text)) {
        return "protected";
    }

    if (/\bpublic\b/.test(text)) {
        return "public";
    }

    return undefined;
}

export function accessOfModifiers(node: SyntaxNode, source: string): Access | undefined {
    for (const child of namedChildren(node)) {
        if (
            child.type === "modifier" ||
            child.type === "modifiers" ||
            child.type === "visibility_modifier" ||
            child.type === "accessibility_modifier"
        ) {
            const access = accessFromText(source.slice(child.startIndex, child.endIndex));

            if (access !== undefined) {
                return access;
            }
        }
    }

    return undefined;
}

export function isCommentNode(node: SyntaxNode): boolean {
    return node.type.includes("comment");
}

export function isCapitalizedName(name: string): boolean {
    const first = name[0] ?? "";

    return first.length > 0 && first === first.toUpperCase() && first !== first.toLowerCase();
}
