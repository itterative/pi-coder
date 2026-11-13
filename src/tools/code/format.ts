import type { Declaration, DeclarationKind, DeclarationRange, SymbolSelector } from "./types";

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
 * One footer line naming what a narrowing parameter removed.
 *
 * A filtered result that only shrinks leaves the caller unable to distinguish "nothing matched" from "the filter
 * hid it", and the total is the number they will reason about — so it is stated rather than implied. The line names
 * an active filter even when it hid nothing, because a scoped result must not read as the whole tree.
 */
export function filterNote(options: {
    glob?: string;
    globHidden: number;
    declarationKind?: DeclarationKind;
    kindHidden?: number;
}): string | undefined {
    const parts: string[] = [];
    const glob = options.glob?.trim() ?? "";

    if (glob.length > 0) {
        parts.push(`glob=${glob}${hiddenSuffix(options.globHidden, "file")}`);
    }

    if (options.declarationKind !== undefined) {
        parts.push(
            `declarationKind=${options.declarationKind}${hiddenSuffix(options.kindHidden ?? 0, "declaration")}`,
        );
    }

    return parts.length === 0 ? undefined : `# filter: ${parts.join(" · ")}`;
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
}): string {
    const direction = options.direction === "dependents" ? "dependents of" : "imports of";
    const outside =
        options.outside > 0
            ? ` (${counted(options.outside, "file")} outside the searched path)`
            : "";

    return `# within: ${direction} ${options.anchor} · ${counted(options.files, "file")}${outside}`;
}

function hiddenSuffix(count: number, noun: string): string {
    return count > 0 ? ` (${counted(count, noun)} hidden)` : "";
}

function counted(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function declarationLine(
    declaration: Declaration,
    depth: number,
    options: { includeLine?: boolean; includeDefTag?: boolean; signatureLimit?: number } = {},
): string {
    const includeLine = options.includeLine ?? true;
    const includeDefTag = options.includeDefTag ?? true;
    // A frontmatter block's source is just `---`; its own name is the only thing worth showing in a map.
    const signature =
        declaration.kind === "frontmatter"
            ? declaration.name
            : shortSignature(declaration.signature, options.signatureLimit);
    const tag =
        includeDefTag && declaration.isDefinition && isFunctionLike(declaration.kind)
            ? " [def]"
            : "";
    const line = includeLine ? `  :${lineRange(declaration.range)}` : "";

    return `${indent(depth)}${signature}${line}${tag}`;
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

export function isContainer(kind: Declaration["kind"]): boolean {
    return (
        kind === "class" ||
        kind === "struct" ||
        kind === "union" ||
        kind === "interface" ||
        kind === "trait" ||
        kind === "enum" ||
        kind === "namespace"
    );
}

/** Exact source for a declaration range, with an adjacent doc comment when `includeDocs` is set. */
export function sourceForDeclaration(
    source: string,
    declaration: Declaration,
    includeDocs: boolean,
): string[] {
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

    return lines;
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
    /** Body lines skipped by this page. */
    offset: number;
    /** Absolute body-line offset for the next page, when content remains. */
    nextOffset?: number;
    /** Body lines this page did not reach. */
    remaining: number;
    /** Body lines in the whole result. */
    total: number;
}

interface LaidBlock {
    text: string;
    lines: string[];
    /** Absolute body-line index of this block's first line. */
    start: number;
}

interface BlockPosition {
    index: number;
    /** Lines into the block to start at. */
    intra: number;
}

interface FittedLines {
    text: string;
    kept: number;
}

/** Join header and blocks, stopping at a block boundary when the character limit is reached. */
export function renderWithinBudget(
    header: string,
    blocks: readonly string[],
    limit: number,
    offset = 0,
): BudgetedText {
    const startOffset = Math.max(0, Math.floor(offset));
    const laid = layBlocks(blocks);

    if (laid.length === 0) {
        return noContent(header, startOffset);
    }

    const totalLines = bodyLineCount(laid);

    if (startOffset >= totalLines) {
        return {
            ...noContent(header, startOffset),
            text: `${header}\n# offset ${startOffset} is beyond the end (${totalLines} body line(s))`,
            truncated: false,
            total: totalLines,
        };
    }

    const position = positionAt(laid, startOffset);
    const parts: string[] = [header];
    let used = header.length;
    let index = position.index;
    let included = 0;

    if (position.intra > 0) {
        const block = laid[index];

        if (block === undefined) {
            return noContent(header, startOffset);
        }

        const suffix = block.lines.slice(position.intra).join("\n");
        const cost = suffix.length + 1;
        const fitted = takeLines(suffix, Math.max(0, limit - used - 1), used);

        if (used + cost > limit) {
            parts.push(fitted.text);

            return omittedAfter(parts, fitted.kept, laid.length - index - 1, {
                startOffset,
                endOffset: startOffset + fitted.kept,
                total: totalLines,
            });
        }

        parts.push(suffix);
        used += cost;
        index += 1;
        included = 1;
    }

    for (; index < laid.length; index += 1) {
        const block = laid[index];

        if (block === undefined) {
            continue;
        }

        const cost = block.text.length + 1;

        if (used + cost > limit) {
            if (included === 0) {
                const fitted = takeLines(block.text, Math.max(0, limit - used - 1), used);
                parts.push(fitted.text);

                return omittedAfter(parts, fitted.kept, laid.length - index - 1, {
                    startOffset,
                    endOffset: block.start + fitted.kept,
                    total: totalLines,
                });
            }

            parts.push(`# omitted ${laid.length - index} more block(s) at the character limit`);

            return {
                text: parts.join("\n\n"),
                truncated: true,
                offset: startOffset,
                nextOffset: block.start,
                remaining: totalLines - block.start,
                total: totalLines,
            };
        }

        parts.push(block.text);
        used += cost;
        included += 1;
    }

    return {
        text: parts.join("\n\n"),
        truncated: startOffset > 0,
        offset: startOffset,
        remaining: 0,
        total: totalLines,
    };
}

function noContent(header: string, offset: number): BudgetedText {
    return {
        text: header,
        truncated: offset > 0,
        offset,
        remaining: 0,
        total: 0,
    };
}

/**
 * Build a page that stopped inside a block.
 *
 * The trailing note names the blocks left after this one, because a page cut inside the first body otherwise hides
 * every later block with no trace: a caller cannot tell "not found" from "not reached".
 */
function omittedAfter(
    parts: readonly string[],
    kept: number,
    blocksLeft: number,
    page: { startOffset: number; endOffset: number; total: number },
): BudgetedText {
    const lines = [...parts];

    if (blocksLeft > 0) {
        lines.push(`# omitted ${blocksLeft} more block(s) after this body`);
    }

    return {
        text: lines.join("\n\n"),
        truncated: true,
        offset: page.startOffset,
        ...(kept > 0 ? { nextOffset: page.endOffset } : {}),
        remaining: Math.max(0, page.total - page.endOffset),
        total: page.total,
    };
}

/**
 * A one-line continuation hint for a character-limited result.
 *
 * It names what is left in lines as well as the next offset, because the page step is set by the character budget,
 * not by a line count: without the remaining count, a caller cannot tell whether one call or eight remain.
 */
export function nextOffsetNote(fitted: BudgetedText): string | undefined {
    if (fitted.nextOffset === undefined) {
        return undefined;
    }

    const scope =
        fitted.remaining > 0 ? ` · ${fitted.remaining} of ${fitted.total} line(s) left` : "";

    return `# next: offset=${fitted.nextOffset}${scope} · raise limit to fit more per call`;
}

function layBlocks(blocks: readonly string[]): LaidBlock[] {
    const laid: LaidBlock[] = [];
    let start = 0;

    for (const text of blocks) {
        const lines = text.split("\n");

        laid.push({ text, lines, start });
        start += lines.length + 1;
    }

    return laid;
}

function bodyLineCount(laid: readonly LaidBlock[]): number {
    const last = laid.at(-1);

    return last === undefined ? 0 : last.start + last.lines.length;
}

function positionAt(laid: readonly LaidBlock[], offset: number): BlockPosition {
    for (let index = 0; index < laid.length; index += 1) {
        const block = laid[index];

        if (block === undefined) {
            continue;
        }

        const end = block.start + block.lines.length;

        if (offset < end) {
            return { index, intra: offset - block.start };
        }

        const next = laid[index + 1];

        if (next !== undefined && offset < next.start) {
            return { index: index + 1, intra: 0 };
        }
    }

    return { index: Math.max(0, laid.length - 1), intra: 0 };
}

function takeLines(text: string, maxCharacters: number, headerChars = 0): FittedLines {
    if (text.length <= maxCharacters) {
        return { text, kept: text.split("\n").length };
    }

    const lines = text.split("\n");
    const kept: string[] = [];
    let used = 0;

    for (const line of lines) {
        if (used + line.length + 1 > maxCharacters) {
            break;
        }

        kept.push(line);
        used += line.length + 1;
    }

    if (kept.length === 0) {
        const firstLine = lines[0] ?? "";
        const needed = headerChars + firstLine.length + 1;

        return {
            text: `# … next line needs about ${needed} chars; raise limit to at least ${needed}`,
            kept: 0,
        };
    }

    const omitted = Math.max(1, lines.length - kept.length);

    return {
        text: `${kept.join("\n")}\n# … truncated ${omitted} line(s)`,
        kept: kept.length,
    };
}

export function truncateLines(text: string, maxCharacters: number): string {
    return takeLines(text, maxCharacters).text;
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
