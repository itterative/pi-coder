import type { SupportedLanguage } from "./languages";

/**
 * Comment syntax, for the text a declaration embeds rather than for parsing.
 *
 * This is deliberately not on `LanguageAdapter`: the adapter registry owns grammars and preprocessors, which are
 * parse concerns, while this table exists so `text.ts` can lift prose out of a body and `imports.ts` can mask
 * comments before scanning for import statements. Keeping it here also keeps `text.ts` free of the parser imports
 * that `adapters.ts` pulls in.
 */
export interface CommentSyntax {
    line: readonly string[];
    block?: { open: string; close: string };
}

/** One comment's extent in the source, markers included. */
export interface CommentRange {
    start: number;
    end: number;
}

const C_LINE = ["//"] as const;
const C_BLOCK = { open: "/*", close: "*/" } as const;

const SYNTAX: Partial<Record<SupportedLanguage, CommentSyntax>> = {
    cpp: { line: C_LINE, block: C_BLOCK },
    hip: { line: C_LINE, block: C_BLOCK },
    csharp: { line: C_LINE, block: C_BLOCK },
    go: { line: C_LINE, block: C_BLOCK },
    java: { line: C_LINE, block: C_BLOCK },
    javascript: { line: C_LINE, block: C_BLOCK },
    typescript: { line: C_LINE, block: C_BLOCK },
    tsx: { line: C_LINE, block: C_BLOCK },
    rust: { line: C_LINE, block: C_BLOCK },
    php: { line: ["//", "#"], block: C_BLOCK },
    python: { line: ["#"] },
    ruby: { line: ["#"] },
};

export function commentSyntaxFor(language: string): CommentSyntax | undefined {
    return SYNTAX[language as SupportedLanguage];
}

/** Characters that open a string literal in the languages above; a `//` inside one is not a comment. */
const STRING_DELIMITERS = new Set(["'", '"', "`"]);

/**
 * Every comment extent in `[start, end)`, in source order.
 *
 * The one scanner both consumers share: `commentTextIn` lifts the prose for embeddings, and `maskComments` blanks
 * those same ranges before `imports.ts` looks for statements, so a commented-out `import` cannot become an edge.
 */
export function commentRanges(
    source: string,
    start: number,
    end: number,
    syntax: CommentSyntax,
): CommentRange[] {
    const ranges: CommentRange[] = [];
    let index = Math.max(0, start);

    while (index < end) {
        const char = source[index];

        if (char !== undefined && STRING_DELIMITERS.has(char)) {
            index = skipString(source, index, end);

            continue;
        }

        const lineMarker = syntax.line.find((marker) => source.startsWith(marker, index));

        if (lineMarker !== undefined) {
            const newline = source.indexOf("\n", index);
            const stop = newline < 0 || newline > end ? end : newline;

            ranges.push({ start: index, end: stop });
            index = stop;

            continue;
        }

        const block = syntax.block;

        if (block !== undefined && source.startsWith(block.open, index)) {
            const close = source.indexOf(block.close, index + block.open.length);
            const stop = close < 0 || close > end ? end : close + block.close.length;

            ranges.push({ start: index, end: stop });
            index = stop;

            continue;
        }

        index += 1;
    }

    return ranges;
}

/**
 * The comment prose inside `[start, end)`, with markers and block decoration stripped.
 *
 * Best-effort by construction: this text is embedded, not parsed, so a heuristic that skips string literals is
 * enough to keep `"https://…"` and `"#fff"` out of the document, and a missed edge case (a C++ raw string, a Ruby
 * `%q` literal) costs a little noise rather than a wrong answer. `limit` caps how much of a large body is lifted:
 * comments are concept-dense, but they should not drown out the doc comment and signature ahead of them.
 */
export function commentTextIn(
    source: string,
    start: number,
    end: number,
    syntax: CommentSyntax,
    limit = 1_200,
): string {
    const parts: string[] = [];
    let size = 0;

    for (const range of commentRanges(source, start, end, syntax)) {
        if (size >= limit) {
            break;
        }

        const text = commentBody(source.slice(range.start, range.end), syntax);

        if (text.length > 0) {
            parts.push(text);
            size += text.length;
        }
    }

    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit).trim();
}

/**
 * String-literal extents in `[start, end)`.
 *
 * A statement keyword inside a string is not a statement: `const doc = "\\nimport x from './y'"` must not become an
 * import edge. Extractors check their match offset against these ranges; the specifier itself lives inside one, but
 * the keyword that starts the statement does not.
 */
export function stringRanges(source: string, start: number, end: number): CommentRange[] {
    const ranges: CommentRange[] = [];
    let index = Math.max(0, start);

    while (index < end) {
        if (STRING_DELIMITERS.has(source[index] ?? "")) {
            const stop = skipString(source, index, end);

            ranges.push({ start: index, end: stop });
            index = stop;

            continue;
        }

        index += 1;
    }

    return ranges;
}

/**
 * The source with every comment replaced by spaces, offsets preserved.
 *
 * Newlines survive, so a line number computed on the masked text is the original line number. String literals are
 * left intact because an import specifier lives inside one.
 */
export function maskComments(source: string, syntax: CommentSyntax): string {
    let masked = "";
    let cursor = 0;

    for (const range of commentRanges(source, 0, source.length, syntax)) {
        masked += source.slice(cursor, range.start);
        masked += source.slice(range.start, range.end).replace(/[^\n]/g, " ");
        cursor = range.end;
    }

    return masked + source.slice(cursor);
}

/** One comment's prose: the marker is removed, and a block's `*` decoration with it. */
function commentBody(text: string, syntax: CommentSyntax): string {
    const lineMarker = syntax.line.find((marker) => text.startsWith(marker));

    if (lineMarker !== undefined) {
        return text.slice(lineMarker.length).trim();
    }

    const block = syntax.block;

    if (block === undefined || !text.startsWith(block.open)) {
        return text.trim();
    }

    const closes = text.endsWith(block.close);
    const body = text.slice(
        block.open.length,
        closes ? text.length - block.close.length : undefined,
    );

    return blockText(body);
}

/** Inside a `/* … *\/` block: drop the leading `*` decoration each line carries. */
function blockText(body: string): string {
    return body
        .split("\n")
        .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
        .filter((line) => line.length > 0)
        .join(" ");
}

/**
 * The offset just past a string literal, so its contents cannot be mistaken for comments.
 *
 * An unterminated literal stops at the end of the range: an unbalanced quote should cost the rest of one body, not
 * run into the next declaration.
 */
function skipString(source: string, start: number, end: number): number {
    const delimiter = source[start];
    let index = start + 1;

    while (index < end) {
        const char = source[index];

        if (char === "\\") {
            index += 2;

            continue;
        }

        if (char === delimiter) {
            // A doubled quote (`''` in some dialects) stays inside the literal; skipping both is harmless either way.
            return index + 1;
        }

        if (char === "\n" && delimiter !== "`") {
            // An unterminated single-line literal: resume scanning after it rather than swallowing the body.
            return index + 1;
        }

        index += 1;
    }

    return end;
}
