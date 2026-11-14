import type { CodeTiming } from "./timing";

/** The questions the outline tool answers. */
export type CodeAction = "digest" | "search" | "show" | "usages" | "deps" | "flow";

/** How much of a declaration the caller wants. */
export type CodeDetail = "signatures" | "full";

/** The occurrence classes the usages action can report. */
export const USAGE_KINDS = ["def", "call", "ref"] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export function isUsageKind(value: string): value is UsageKind {
    return (USAGE_KINDS as readonly string[]).includes(value);
}

/**
 * The normalized declaration model shared by every language adapter.
 *
 * This is deliberately not a syntax tree. Tree-sitter owns the AST; an adapter extracts only the handful of
 * fields the formatter and the matchers need, so adding a language never means teaching the rest of the tool
 * about that language's node types.
 */
export const DECLARATION_KINDS = [
    "namespace",
    "class",
    "struct",
    "union",
    "interface",
    "trait",
    "enum",
    "enumMember",
    "function",
    "method",
    "constructor",
    "destructor",
    "operator",
    "field",
    "variable",
    "typeAlias",
    "macro",
    /**
     * A named block: a statement-level call whose name is a string literal and whose last argument is a
     * function - `describe("outline digest", () => ...)`, `it("maps a module", async () => ...)`,
     * `router.get("/users", (req, res) => ...)`. Not a declaration in any grammar; the shape is what makes
     * test suites, routes, and event handlers visible to a map that otherwise stops at declarations.
     */
    "block",
    "heading",
    /** A Markdown frontmatter block: no name of its own, but the highest-signal prose in a memory tree. */
    "frontmatter",
] as const;

export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

export function isDeclarationKind(value: string): value is DeclarationKind {
    return (DECLARATION_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a declaration satisfies a kind filter.
 *
 * `class` is the one kind that is a language-family question rather than a syntax one: TypeScript writes `class`,
 * C++ writes `struct` for the same thing, and Rust has `struct` with no `class` at all. A caller who asks for classes
 * on a C++ tree means the types, so the filter folds them together; the narrower names still select themselves.
 */
export function matchesDeclarationKind(
    actual: DeclarationKind,
    requested: DeclarationKind,
): boolean {
    if (actual === requested) {
        return true;
    }

    return requested === "class" && (actual === "struct" || actual === "union");
}

/**
 * One `kind` parameter serving two disjoint axes: declaration kinds for `digest`/`search`, occurrence classes for
 * `usages`. The value sets do not overlap, so the action routes the value without a second parameter.
 */
export type KindFilter = UsageKind | DeclarationKind;

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
    /**
     * The callee that opened a `block`, e.g. `describe`, `test.describe`, or `router.get`.
     *
     * Kept here rather than read back out of `signature`, so the formatter never parses an expression it did not
     * build: a title holding a quote or a comma is ordinary prose, not a syntax error to recover from.
     */
    blockCallee?: string;
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
    /** A literal file or directory, or an rg-style pattern matched against the workspace path. */
    path?: string;
    /**
     * `search`: the phrase. `show`/`usages`: one or more selectors, split at top-level commas so a comma in an
     * overload selector survives.
     */
    query?: string;
    detail?: CodeDetail;
    /** Maximum rendered result size, in characters. */
    limit?: number;
    /** Body-line offset for continuing a result cut by the limit. */
    offset?: number;
    /** `digest`/`search`: a declaration kind. `usages`: an occurrence class. Routed by action. */
    kind?: KindFilter;
    /** `search`/`usages` only: scope to a file's direct imports, or with a `dependents:` prefix, its importers. */
    within?: string;
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

/** A selector parsed from the `query` parameter of `show` or `usages`. */
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
