import type { CodeTiming } from "./timing";

/** The questions the outline tool answers. */
export type CodeAction = "digest" | "search" | "show" | "usages";

/** How much of a declaration the caller wants. */
export type CodeDetail = "signatures" | "full";

/** The occurrence classes the usages action can report. */
export type UsageKind = "def" | "call" | "ref";

/**
 * The normalized declaration model shared by every language adapter.
 *
 * This is deliberately not a syntax tree. Tree-sitter owns the AST; an adapter extracts only the handful of
 * fields the formatter and the matchers need, so adding a language never means teaching the rest of the tool
 * about that language's node types.
 */
export type DeclarationKind =
    | "namespace"
    | "class"
    | "struct"
    | "union"
    | "interface"
    | "trait"
    | "enum"
    | "enumMember"
    | "function"
    | "method"
    | "constructor"
    | "destructor"
    | "operator"
    | "field"
    | "variable"
    | "typeAlias"
    | "macro"
    | "heading";

export type Access = "public" | "protected" | "private";

/** A one-based line range plus the byte offsets tree-sitter gave the node. */
export interface DeclarationRange {
    startLine: number;
    endLine: number;
    startIndex: number;
    endIndex: number;
}

/** The range of the declaration's name node, used to classify usages as definitions. */
export interface NameRange {
    startIndex: number;
    endIndex: number;
}

export interface Declaration {
    kind: DeclarationKind;
    /** The simple name, e.g. `connect`, `~Socket`, `operator bool`. */
    name: string;
    /** The fully qualified name, e.g. `net::Socket::connect`. */
    qualifiedName: string;
    /** Exact source text with runs of whitespace collapsed to one space. */
    signature: string;
    /** The declaration's full range, including a template header when present. */
    range: DeclarationRange;
    /** The body range when the declaration has one. */
    bodyRange?: DeclarationRange;
    /** The name node's byte range, for def/usage classification. */
    nameRange?: NameRange;
    /** Parameter types only, used to pair declarations with definitions across header/source files. */
    paramTypes: string[];
    /** The same parameter types with source spacing, for user-facing overload hints. */
    paramTexts?: string[];
    /** The byte range of an immediately preceding doc comment, when one is adjacent. */
    docRange?: { startIndex: number; endIndex: number };
    access?: Access;
    isDefinition: boolean;
    children: Declaration[];
    /** The language id the adapter used, e.g. `cpp` or `hip`. */
    language: string;
}

/** One parsed source file. `all` is flattened and keeps the same object identities as the `roots` tree. */
export interface ParsedFile {
    path: string;
    language: string;
    size: number;
    lineCount: number;
    parseErrors: number;
    /** The original file text. Output slices always come from this, never from the neutralized parse buffer. */
    source: string;
    roots: Declaration[];
    all: Declaration[];
}

/** The parameters the agent passes. Action-specific fields are validated in `index.ts`. */
export interface CodeToolParams {
    action: CodeAction;
    path?: string;
    /** Declaration-name query for `search`. */
    query?: string;
    symbols?: string[];
    detail?: CodeDetail;
    /** Maximum rendered result size, in characters. */
    limit?: number;
    /** Body-line offset for continuing a result cut by the limit. */
    offset?: number;
    kind?: UsageKind;
}

/** What an action returns: the model-facing text plus structural details for the caller/TUI. */
export interface CodeActionResult {
    text: string;
    details: {
        action: CodeAction;
        path: string;
        source: "container" | "local";
        files: number;
        matches?: number;
        parseErrors?: number;
        truncated?: boolean;
        /** Filled by the registration, so a direct action call has no timings to report. */
        timing?: CodeTiming;
    };
}

/** A selector parsed from the `symbols` parameter. */
export interface SymbolSelector {
    /** The raw selector as the agent wrote it. */
    raw: string;
    /** The parts split on `::` or `.`, with any signature hint removed. */
    parts: string[];
    /** The last part, used for name-based matching. */
    name: string;
    /** Normalized parameter types from `Foo::bar(const X&)`, when supplied. */
    signatureHint: string[];
}
