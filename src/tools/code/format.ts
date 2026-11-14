import { MAX_FILES } from "./languages";
import type {
    CodeToolParams,
    Declaration,
    DeclarationKind,
    DeclarationRange,
    ParsedFile,
    SymbolSelector,
} from "./types";

/** Parse `ns::Type::member(const X&)` into a name selector plus an optional parameter-type hint. */
export function parseSelector(raw: string): SymbolSelector {
    const trimmed = raw.trim();
    let base = trimmed;
    let hint = "";
    const open = trimmed.lastIndexOf("(");

    if (open > 0 && trimmed.endsWith(")") && !trimmed.slice(0, open).endsWith("operator")) {
        base = trimmed.slice(0, open);
        hint = trimmed.slice(open + 1, -1);
    }

    const parts = base
        .split(/::|\./)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    const name = parts.at(-1) ?? base;

    return {
        raw,
        parts,
        name,
        signatureHint: hint.length === 0 ? [] : splitParameters(hint).map(normalizeParameterType),
    };
}

export function selectorMatches(declaration: Declaration, selector: SymbolSelector): boolean {
    const qualified = normalizeSymbol(declaration.qualifiedName);
    const requested = normalizeSymbol(selector.parts.join("::"));
    const simple = normalizeSymbol(declaration.name);
    const requestedName = normalizeSymbol(selector.name);

    const nameMatches =
        qualified === requested ||
        qualified.endsWith(`::${requested}`) ||
        (selector.parts.length === 1 && simple === requestedName);

    if (!nameMatches) {
        return false;
    }

    if (
        selector.parts.length === 1 &&
        declaration.kind === "constructor" &&
        simple === requestedName
    ) {
        return false;
    }

    if (selector.signatureHint.length === 0) {
        return true;
    }

    const parameters = declaration.paramTypes.map(normalizeParameterType);

    // A leading hint is enough to pick an overload: an agent that remembered the first two parameters of a
    // four-parameter function was naming that function, not asking a different question.
    return (
        selector.signatureHint.length <= parameters.length &&
        selector.signatureHint.every((parameter, index) => parameter === parameters[index])
    );
}

/** True when a selector matched only because its parameter hint stopped short of the full list. */
export function selectorHintIsPartial(declaration: Declaration, selector: SymbolSelector): boolean {
    return (
        selector.signatureHint.length > 0 &&
        declaration.paramTypes.length > selector.signatureHint.length
    );
}

export function normalizeSymbol(text: string): string {
    return text.replace(/\s+/g, "").replace(/\./g, "::");
}

/** How a selector reached a heading: its title as written, or a remembered piece of it. */
export type HeadingMatch = "exact" | "prefix" | "substring";

/**
 * Match a selector against *prose*: a heading's title, or a block's title.
 *
 * The rule that protects a code symbol — never guess between candidates — would leave most headings unreachable:
 * nobody reproduces `Framing, viewport restore, and the render cache` from memory, and a truncated title still names
 * the section the caller wants. A test title is the same kind of name: `show("commented-out import")` should reach
 * `it("does not turn a commented-out import into an edge")`. So prose also matches by prefix and substring, and every
 * candidate is reported, which turns a loose match into a list of sections instead of a confident wrong answer.
 *
 * Comparison ignores case, leading `#` marks, and the punctuation prose is quoted with — including the backticks
 * around `code` spans, which is why `normalizeSymbol` is not reused here.
 */
export function headingMatch(
    declaration: Declaration,
    selector: SymbolSelector,
): HeadingMatch | undefined {
    if (declaration.kind !== "heading" && declaration.kind !== "block") {
        return undefined;
    }

    const wanted = normalizeHeading(selector.parts.join(" "));

    if (wanted.length === 0) {
        return undefined;
    }

    const title = normalizeHeading(declaration.name);

    if (title === wanted) {
        return "exact";
    }

    if (title.startsWith(wanted)) {
        return "prefix";
    }

    return title.includes(wanted) ? "substring" : undefined;
}

function normalizeHeading(text: string): string {
    return text
        .replace(/^#+\s*/, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/**
 * A parameter type as an overload selector compares it.
 *
 * Spelling must not decide whether a caller can name an overload. The source says `std::int64_t`; an agent that
 * has read the header, or remembers the type as `int64_t`, says `int64_t` — and a matcher that compares the literal
 * text answers "not found" for a symbol it is showing. So qualifiers, cv-qualifiers, and reference/pointer
 * decoration are dropped on both sides: `const Address&` and `address` are the same parameter.
 *
 * Dropping a namespace does conflate `A::Options` with `B::Options`. That is acceptable here because this is a
 * *hint*, not an identity: an ambiguous result is reported as several candidates, and the caller then widens with a
 * qualifier instead of getting a confident wrong answer.
 */
export function normalizeParameterType(text: string): string {
    return (
        text
            .replace(/\s+/g, "")
            // `std::int64_t` and `int64_t` are the same parameter; so are `Foo::Bar` and `Bar`.
            .replace(/(?:[A-Za-z_]\w*::)+/g, "")
            // Adapters hand over whitespace-squeezed types (`constLayerPlan&`), so a word-boundary rule never fires.
            // Two passes handle a doubled qualifier, and the lookahead keeps a type named `constant` intact.
            .replace(/(?:const|volatile)(?![a-z])/g, "")
            .replace(/(?:const|volatile)(?![a-z])/g, "")
            .replace(/[&*]/g, "")
            .toLowerCase()
    );
}

/**
 * Split a requested symbol list, including commas an agent folded into one element.
 *
 * Models habitually pass `"A::b, C::d"` as a single entry. A comma inside a parameter list belongs to an
 * overload selector - `Socket::connect(const Address&, int)` - so only top-level commas split. Repeated
 * symbols are kept: `usages` counts them separately, and collapsing them here would hide that from the caller.
 */
export function splitSymbolList(symbols: readonly string[]): string[] {
    const requested: string[] = [];

    for (const entry of symbols) {
        for (const part of splitTopLevelCommas(entry)) {
            const symbol = part.trim();

            if (symbol.length > 0) {
                requested.push(symbol);
            }
        }
    }

    return requested;
}

function splitTopLevelCommas(entry: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index < entry.length; index += 1) {
        const character = entry[index];

        if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth = Math.max(0, depth - 1);
        } else if (character === "," && depth === 0) {
            parts.push(entry.slice(start, index));
            start = index + 1;
        }
    }

    parts.push(entry.slice(start));

    return parts;
}

export function pairKey(declaration: Declaration): string {
    return `${normalizeSymbol(declaration.qualifiedName)}\u0000${declaration.paramTypes
        .map(normalizeSymbol)
        .join(",")}`;
}

export function lineRange(range: DeclarationRange): string {
    if (range.startLine === range.endLine) {
        return `${range.startLine}`;
    }

    return `${range.startLine}-${range.endLine}`;
}

export function pathRange(filePath: string, range: DeclarationRange): string {
    return `${filePath}:${lineRange(range)}`;
}

export function indent(depth: number): string {
    return "  ".repeat(depth);
}

/**
 * A page and its footer, separated by one blank line.
 *
 * Footer lines annotate the page — what a filter hid, where the next page starts, which channel ranked a row, which
 * kinds are left out — and run directly under the last row they read as one more row of results. A page with no
 * footer, or a footer with no page (a "nothing matched" answer), keeps the plain join.
 */
export function bodyThenFooter(
    body: readonly string[],
    notes: readonly (string | undefined)[],
): string {
    const page = body.filter((part) => part.length > 0).join("\n");
    const footer = notes.filter((part): part is string => part !== undefined && part.length > 0);

    if (page.length === 0) {
        return footer.join("\n");
    }

    return footer.length === 0 ? page : `${page}\n\n${footer.join("\n")}`;
}

/**
 * One footer line naming what a narrowing parameter removed.
 *
 * A filtered result that only shrinks leaves the caller unable to distinguish "nothing matched" from "the filter
 * hid it", and the total is the number they will reason about — so it is stated rather than implied. The line names
 * an active filter even when it hid nothing, because a scoped result must not read as the whole tree.
 */
/** One line when discovery hit its cap: the parse set is a prefix of the matches, not all of them. */
export function discoveryCapNote(): string {
    return `# note: file discovery was capped at ${MAX_FILES}; the scan covers the first matches only`;
}

export function filterNote(options: {
    path?: string;
    pathHidden?: number;
    kind?: DeclarationKind;
    kindHidden?: number;
    /** What the filtered files actually contain, so a filter that hid everything says what is there instead. */
    kindCounts?: ReadonlyMap<DeclarationKind, number>;
}): string | undefined {
    const parts: string[] = [];
    const target = options.path?.trim() ?? "";

    if (target.length > 0) {
        parts.push(`path=${target}${hiddenSuffix(options.pathHidden ?? 0, "file")}`);
    }

    if (options.kind !== undefined) {
        parts.push(
            `kind=${options.kind}${hiddenSuffix(options.kindHidden ?? 0, "declaration")}${histogramSuffix(options.kindCounts, options.kind)}`,
        );
    }

    return parts.length === 0 ? undefined : `# filter: ${parts.join(" · ")}`;
}

/**
 * The kinds that answer a near-miss filter, nearest first.
 *
 * `kind=class` on a C++ tree was the motivating case: a histogram sorted by count listed `function 427, field 150`
 * first and never reached `struct`, which is the only word the caller can act on.
 */
const RELATED_KINDS = new Map<DeclarationKind, readonly DeclarationKind[]>([
    ["class", ["struct", "union", "interface", "trait"]],
    ["struct", ["class", "union"]],
    ["union", ["struct", "class"]],
    ["interface", ["trait", "class"]],
    ["trait", ["interface", "class"]],
    ["enum", ["enumMember"]],
    ["enumMember", ["enum"]],
    ["function", ["method", "constructor", "operator"]],
    ["method", ["function", "operator"]],
    ["field", ["variable"]],
    ["variable", ["field"]],
    ["typeAlias", ["class", "struct"]],
]);

/**
 * The largest kind groups behind a filter, related kinds first.
 *
 * `kind=class` returning nothing over 83 hidden declarations is a dead end unless the answer says the tree is made of
 * `struct`s: the histogram is what turns the filter hint into the next call. Ordering by relevance to the requested
 * kind rather than by count is what makes the type kinds visible on a tree with hundreds of functions.
 */
function histogramSuffix(
    counts: ReadonlyMap<DeclarationKind, number> | undefined,
    requested: DeclarationKind | undefined,
): string {
    if (counts === undefined) {
        return "";
    }

    const related = requested === undefined ? [] : (RELATED_KINDS.get(requested) ?? []);
    const present = [...counts.entries()].filter(([, count]) => count > 0);
    const ordered = [
        ...related.flatMap((kind) => {
            const count = counts.get(kind) ?? 0;

            return count > 0 ? [[kind, count] as const] : [];
        }),
        ...present
            .filter(([kind]) => !related.includes(kind))
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ];
    const top = ordered.slice(0, 3).map(([kind, count]) => `${kind} ${count}`);

    return top.length === 0 ? "" : ` · kinds here: ${top.join(", ")}`;
}

/** Every declaration kind in the parsed files, with its count. */
export function declarationKindCounts(files: readonly ParsedFile[]): Map<DeclarationKind, number> {
    const counts = new Map<DeclarationKind, number>();

    for (const file of files) {
        for (const declaration of file.all) {
            counts.set(declaration.kind, (counts.get(declaration.kind) ?? 0) + 1);
        }
    }

    return counts;
}

/**
 * The footer line for a dependency-scoped search or usages call.
 *
 * It names the anchor even when the scope changed nothing, because a scoped result must not read as the whole tree,
 * and it counts neighbours that fell outside the searched path rather than letting the file total imply otherwise.
 */
export function withinNote(options: {
    direction: "imports" | "dependents";
    anchor: string;
    files: number;
    outside: number;
    /** Set when the anchor was read from the cwd rather than from `path`'s literal prefix. */
    relativeTo?: "cwd";
}): string {
    const direction = options.direction === "dependents" ? "dependents of" : "imports of";
    // Only said when the reading differed from the documented one; naming the same file twice would cost attention
    // on every ordinary scoped call.
    const resolved = options.relativeTo === "cwd" ? " (relative to cwd)" : "";
    const outside =
        options.outside > 0
            ? ` (${counted(options.outside, "file")} outside the searched path)`
            : "";

    return `# within: ${direction} ${options.anchor}${resolved} · ${counted(options.files, "file")}${outside}`;
}

function hiddenSuffix(count: number, noun: string): string {
    return count > 0 ? ` (${counted(count, noun)} hidden)` : "";
}

export function counted(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A parse-error note that says whose problem it is.
 *
 * The grammar recovers from syntax it cannot reduce instead of failing the parse, so an error node means the tree is
 * still usable and something may be missing. Only the grammar can fix that, so the note names the parser and never
 * promises the result is complete.
 */
export function parseErrorNote(parseErrors: number, missing: string): string {
    return `# parse: tree-sitter recovered from ${counted(parseErrors, "syntax error")}; ${missing}`;
}

/**
 * A scope the caller did not name reads as the whole tree, not as a lone `.`.
 *
 * `# show . BashTokenizer::tokenize` was the tool echoing an empty path back at the caller; the dot is a default, not
 * a location, and every header that prints it was printing a placeholder as if it were the target.
 */
export function scopeLabel(scope: string): string {
    return scope === "." ? "(whole tree)" : scope;
}

export function declarationLine(
    declaration: Declaration,
    depth: number,
    options: { includeLine?: boolean; includeDefTag?: boolean; signatureLimit?: number } = {},
): string {
    const includeLine = options.includeLine ?? true;
    const includeDefTag = options.includeDefTag ?? true;
    const signature = rowSignature(declaration, options.signatureLimit);
    const tag =
        includeDefTag && declaration.isDefinition && isDefinitionTagged(declaration.kind)
            ? " [def]"
            : "";
    const line = includeLine ? `  :${lineRange(declaration.range)}` : "";

    return `${indent(depth)}${signature}${line}${tag}`;
}

/**
 * The signature a row prints.
 *
 * Two kinds have a name that is worth more than their source: a frontmatter block's source is just `---`, and a
 * block's source is a call with a whole callback in it, while the pair that identifies it is the callee and the
 * string it was opened with.
 */
function rowSignature(declaration: Declaration, limit: number | undefined): string {
    if (declaration.kind === "frontmatter") {
        return declaration.name;
    }

    if (declaration.blockCallee !== undefined) {
        return shortSignature(`${declaration.blockCallee} "${declaration.name}"`, limit ?? 120);
    }

    return shortSignature(declaration.signature, limit);
}

/**
 * How a declaration is named at the head of a section.
 *
 * The same reason as `rowSignature`: `show` on a suite should say `describe "outline digest"`, not
 * `block outline digest::…`, because the title is the name a caller remembers.
 */
export function declarationHeading(declaration: Declaration): string {
    if (declaration.blockCallee !== undefined) {
        return `${declaration.blockCallee} "${declaration.name}"`;
    }

    return `${kindLabel(declaration.kind)} ${declaration.qualifiedName}`;
}

export function kindLabel(kind: Declaration["kind"]): string {
    switch (kind) {
        case "frontmatter":
            return "yaml";
        case "class":
        case "struct":
        case "union":
        case "interface":
        case "enum":
        case "enumMember":
        case "namespace":
        case "function":
        case "method":
        case "constructor":
        case "destructor":
        case "operator":
        case "field":
        case "variable":
        case "typeAlias":
        case "macro":
        case "block":
            return kind;
        default:
            return kind;
    }
}

export function isFunctionLike(kind: Declaration["kind"]): boolean {
    return (
        kind === "function" ||
        kind === "method" ||
        kind === "constructor" ||
        kind === "destructor" ||
        kind === "operator"
    );
}

/** Kinds that carry the `[def]`/`[decl]` tag: functions and methods, and a macro a caller can `show`. */
export function isDefinitionTagged(kind: Declaration["kind"]): boolean {
    return isFunctionLike(kind) || kind === "macro";
}

export function isContainer(kind: Declaration["kind"]): boolean {
    return (
        kind === "class" ||
        kind === "struct" ||
        kind === "union" ||
        kind === "interface" ||
        kind === "trait" ||
        kind === "enum" ||
        kind === "namespace" ||
        kind === "block"
    );
}

/** Exact source for a declaration range, with an adjacent doc comment when `includeDocs` is set. */
export interface DeclarationSource {
    lines: string[];
    /** Source line of `lines[0]`, which is the doc comment when one was included. */
    startLine: number;
    /** True when the declaration's own indentation was removed, so the text no longer matches the file bytes. */
    dedented: boolean;
}

export function sourceForDeclaration(
    source: string,
    declaration: Declaration,
    includeDocs: boolean,
): DeclarationSource {
    const lines: string[] = [];
    // A doc range normally precedes the declaration. A Markdown section keeps its prose *inside* its range, which
    // the section slice already prints, so printing the doc too would duplicate it.
    const doc =
        includeDocs &&
        declaration.docRange !== undefined &&
        declaration.docRange.endIndex <= declaration.range.startIndex
            ? declaration.docRange
            : undefined;
    const anchor = doc?.startIndex ?? declaration.range.startIndex;
    const indent = indentBefore(source, anchor);

    if (doc !== undefined) {
        lines.push(...sliceSource(source, doc.startIndex, doc.endIndex, indent));
    }

    lines.push(
        ...sliceSource(source, declaration.range.startIndex, declaration.range.endIndex, indent),
    );

    return { lines, startLine: lineOf(source, anchor), dedented: indent.length > 0 };
}

/** 1-based line number of a byte index. */
function lineOf(source: string, index: number): number {
    let line = 1;
    let cursor = source.indexOf("\n");

    while (cursor !== -1 && cursor < index) {
        line += 1;
        cursor = source.indexOf("\n", cursor + 1);
    }

    return line;
}

/**
 * Slice exact source, dedented by the declaration's own indentation.
 *
 * Tree-sitter node starts sit after leading whitespace, while continuation lines keep it. Prepending the
 * start line's indent and then removing the common indent keeps doc lines and bodies aligned instead of
 * returning a first line at column zero followed by source-column continuations.
 */
export function sliceSource(
    source: string,
    startIndex: number,
    endIndex: number,
    indent = "",
): string[] {
    const lineStart = source.lastIndexOf("\n", startIndex - 1) + 1;
    const prefix = source.slice(lineStart, startIndex);
    let text = source.slice(startIndex, endIndex);

    if (indent.length > 0 && /^[ \t]*$/.test(prefix)) {
        text = prefix + text;
    }

    const lines = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line));

    if (lines.at(-1) === "") {
        lines.pop();
    }

    return lines;
}

function indentBefore(source: string, index: number): string {
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    const prefix = source.slice(lineStart, index);

    return /^[ \t]*$/.test(prefix) ? prefix : "";
}

/** A signature is for orientation, not a contract dump; the source slice is still exact. */
export function shortSignature(signature: string, limit = 240): string {
    return signature.length <= limit ? signature : `${signature.slice(0, limit - 1)}…`;
}

export function shortLine(text: string, limit = 180): string {
    const collapsed = text.replace(/\s+/g, " ").trim();

    return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

export interface BudgetedText {
    text: string;
    truncated: boolean;
    /** Rendered line this page starts at (0-based). */
    offset: number;
    /** Rendered line the next page starts at, when content remains. */
    nextOffset?: number;
    /** Rendered lines this page did not reach. */
    remaining: number;
    /** Rendered lines in the whole body. */
    total: number;
}

/**
 * Fit whole rendered lines into a character budget.
 *
 * The budget is the page size a caller asked for with `limit`, so it decides where a page ends; the unit of `offset`
 * is the rendered line, which is the text the caller is reading. Blocks are not allocated: they are only a source of
 * group headings, so a continuation can be reprinted with the heading it lost and a cut never ends on one.
 */
export function renderWithinBudget(
    header: string,
    blocks: readonly string[],
    limit: number,
    offset = 0,
    options: { headings?: boolean } = {},
): BudgetedText {
    const { lines, starts } = flattenBlocks(blocks);
    const total = lines.length;
    const start = skipBlankLines(lines, Math.max(0, Math.floor(offset)));

    if (total === 0) {
        return { text: header, truncated: start > 0, offset: start, remaining: 0, total: 0 };
    }

    if (start >= total) {
        return {
            text: `${header}\n# offset ${start} is beyond the end (${total} line(s))`,
            truncated: false,
            offset: start,
            remaining: 0,
            total,
        };
    }

    // A block that leads with a heading loses it when a page starts inside the block, and the rows then arrive with
    // nothing saying what they belong to. Only callers whose blocks really lead with a heading ask for this.
    const blockStarts = options.headings === true ? starts : [];
    const groupStart = blockStarts.findLast((candidate) => candidate <= start);
    let heading =
        groupStart !== undefined && start > groupStart ? `${lines[groupStart] ?? ""}\n` : "";
    const content = Math.max(0, limit - header.length - 2);
    let kept = fitLines(lines, start, Math.max(0, content - heading.length));

    // A heading is worth a line, never the page: when reprinting it would crowd out the only content line, the
    // content wins and the heading is dropped.
    if (kept === 0 && heading.length > 0) {
        heading = "";
        kept = fitLines(lines, start, content);
    }

    if (kept === 0) {
        const first = lines[start] ?? "";
        const needed = header.length + 2 + heading.length + first.length + 1;

        return {
            text: `${header}\n# the next line needs about ${needed} chars; raise limit to at least ${needed}`,
            truncated: true,
            offset: start,
            remaining: total - start,
            total,
        };
    }

    let shown = start + kept;

    // A cut straight after a heading names a group and shows none of it; the heading belongs to the next page.
    if (shown - 1 > start && shown < total && blockStarts.includes(shown - 1)) {
        shown -= 1;
    }

    // A separator line is a line for the budget, but it is not content: never end a page on one. This runs after
    // the retreat, because moving the cut back onto a separator is exactly what re-exposes one.
    while (shown > start && (lines[shown - 1] ?? "").length === 0) {
        shown -= 1;
    }

    const end = skipBlankLines(lines, shown);

    return {
        text: `${header}\n\n${heading}${lines.slice(start, shown).join("\n")}`,
        truncated: start > 0 || end < total,
        offset: start,
        ...(end < total ? { nextOffset: end } : {}),
        remaining: Math.max(0, total - end),
        total,
    };
}

interface Layout {
    lines: string[];
    /** Body-line index of each block's first line. */
    starts: number[];
}

/** A result's rendered lines: the blocks in order, one blank line between two of them. */
function flattenBlocks(blocks: readonly string[]): Layout {
    const lines: string[] = [];
    const starts: number[] = [];

    for (const block of blocks) {
        if (lines.length > 0) {
            lines.push("");
        }

        starts.push(lines.length);
        lines.push(...block.split("\n"));
    }

    return { lines, starts };
}

/** The first content line at or after `index`: a page never begins with the blank line between two blocks. */
function skipBlankLines(lines: readonly string[], index: number): number {
    let next = index;

    while (next < lines.length && (lines[next] ?? "").length === 0) {
        next += 1;
    }

    return next;
}

/** How many whole lines fit from `start` under `budget` characters. */
function fitLines(lines: readonly string[], start: number, budget: number): number {
    let used = 0;
    let kept = 0;

    for (let index = start; index < lines.length; index += 1) {
        const line = lines[index] ?? "";

        if (used + line.length + 1 > budget) {
            break;
        }

        used += line.length + 1;
        kept += 1;
    }

    return kept;
}

/**
 * The one continuation hint for a cut result.
 *
 * It prints the whole call rather than a bare number: pasting it back reproduces this page's action, path, query,
 * filters, and limit, so the next page answers the same question. The remaining count is in rendered lines, the same
 * unit `offset` uses.
 */
export function nextOffsetNote(
    fitted: BudgetedText,
    params: CodeToolParams,
    options: { offset?: number; where?: string; sourceLine?: boolean } = {},
): string | undefined {
    if (fitted.nextOffset === undefined) {
        return undefined;
    }

    const offset = options.offset ?? fitted.nextOffset;
    const where = options.where === undefined ? "" : ` · in ${options.where}`;
    const unit = options.sourceLine === true ? " · source line, resumable with read" : "";

    return `# next: ${fitted.remaining} more line(s) · ${resumeCall(params, offset)}${where}${unit}`;
}

/** The call that produces the next page, carrying every parameter that shaped this one. */
export function resumeCall(params: CodeToolParams, offset: number): string {
    const args = [`action=${JSON.stringify(params.action)}`];

    if (params.path !== undefined) {
        args.push(`path=${JSON.stringify(params.path)}`);
    }

    if (params.query !== undefined) {
        args.push(`query=${JSON.stringify(params.query)}`);
    }

    if (params.detail !== undefined) {
        args.push(`detail=${JSON.stringify(params.detail)}`);
    }

    if (params.kind !== undefined) {
        args.push(`kind=${JSON.stringify(params.kind)}`);
    }

    if (params.within !== undefined) {
        args.push(`within=${JSON.stringify(params.within)}`);
    }

    if (params.limit !== undefined) {
        args.push(`limit=${params.limit}`);
    }

    args.push(`offset=${offset}`);

    return `outline(${args.join(", ")})`;
}

/**
 * A zero-hit under the default scope is not proof the symbol is absent from the project.
 *
 * The scan rooted at the cwd honors ignore files and the built-in build list, while a named path is read literally
 * (see `scanLiterally` in `source.ts`). Saying so only when the caller did not name a path keeps it off the common
 * call; saying it on an empty result is when the reader otherwise reaches for `rg`.
 */
export function defaultScopeNote(path: string | undefined): string | undefined {
    const named = path?.trim() ?? "";

    if (named.length > 0 && named !== ".") {
        return undefined;
    }

    return "# note: the default scan skips ignored paths (ignore files, node_modules, build, third_party); pass path= to search one";
}

/** Rendered line of each block's first line; `flattenBlocks` inserts the blank line this counts. */
export function blockLineStarts(blocks: readonly string[]): number[] {
    return flattenBlocks(blocks).starts;
}

function splitParameters(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (char === "<" || char === "(" || char === "[" || char === "{") {
            depth += 1;
        } else if (char === ">" || char === ")" || char === "]" || char === "}") {
            depth = Math.max(0, depth - 1);
        } else if (char === "," && depth === 0) {
            parts.push(text.slice(start, index).trim());
            start = index + 1;
        }
    }

    const tail = text.slice(start).trim();

    if (tail.length > 0) {
        parts.push(tail);
    }

    return parts;
}
