import { commentRanges, commentSyntaxFor, commentTextIn } from "./comments";
import type { ParsedFile } from "./types";

/**
 * A prose comment that belongs to no declaration.
 *
 * The doc channel reads the block *above* a declaration and the body channel reads the text *inside* one, so a
 * comment above the imports or between two top-level statements is in neither. Those blocks are file headers, section
 * notes, and the only explanation some behaviour gets — prose with no owner, which is why `search` reaches them
 * through their own channel rather than through a declaration row.
 */
export interface CommentBlock {
    startIndex: number;
    endIndex: number;
    /** One-based line of the first comment marker, so a row can say where `read` should go. */
    startLine: number;
    endLine: number;
    /** Comment text with markers and decoration stripped, whitespace collapsed, and length capped. */
    text: string;
    /** `text` cut at its first sentence, for a row that can afford one line. */
    lead: string;
}

/** Below this a block is a label (`// TODO`, `# ---- next ----`), not prose worth a vector or a row. */
export const COMMENT_BLOCK_MIN_CHARS = 60;

/** The body-chunk ceiling: long enough for a header, short enough for one embedding window. */
export const COMMENT_BLOCK_MAX_CHARS = 2_400;

/** Words of at least three letters. `// 10.4.2 ----` is decoration however long it is. */
const PROSE_WORDS = 8;

const cache = new WeakMap<ParsedFile, readonly CommentBlock[]>();

/**
 * The unowned prose comment blocks of a file, in source order.
 *
 * Cached per `ParsedFile`: the semantic index asks for these on every search that reaches a file, and the extraction
 * is a comment scan plus one comparison per declaration.
 */
export function commentBlocksOf(file: ParsedFile): readonly CommentBlock[] {
    const cached = cache.get(file);

    if (cached !== undefined) {
        return cached;
    }

    const blocks = extractBlocks(file);

    cache.set(file, blocks);

    return blocks;
}

function extractBlocks(file: ParsedFile): CommentBlock[] {
    const syntax = commentSyntaxFor(file.language);

    // Markdown and INI have no comment syntax worth a separate channel; Markdown prose is already a section's doc.
    if (syntax === undefined) {
        return [];
    }

    const covered = coveredRanges(file);
    const starts = lineStarts(file.source);
    const blocks: CommentBlock[] = [];
    let current: { start: number; end: number } | undefined;

    for (const range of commentRanges(file.source, 0, file.source.length, syntax)) {
        // An owned comment is already the doc channel of the declaration that owns it.
        if (covered.some(([start, end]) => range.start >= start && range.start < end)) {
            if (current !== undefined) {
                pushBlock(blocks, file, syntax, current, starts);
                current = undefined;
            }

            continue;
        }

        // Consecutive `//` lines are one block; a blank line between them starts another.
        if (current !== undefined && newlinesBetween(file.source, current.end, range.start) <= 1) {
            current.end = range.end;

            continue;
        }

        if (current !== undefined) {
            pushBlock(blocks, file, syntax, current, starts);
        }

        current = { start: range.start, end: range.end };
    }

    if (current !== undefined) {
        pushBlock(blocks, file, syntax, current, starts);
    }

    return blocks;
}

function pushBlock(
    blocks: CommentBlock[],
    file: ParsedFile,
    syntax: NonNullable<ReturnType<typeof commentSyntaxFor>>,
    span: { start: number; end: number },
    starts: readonly number[],
): void {
    const text = commentTextIn(file.source, span.start, span.end, syntax, COMMENT_BLOCK_MAX_CHARS);

    if (text.length < COMMENT_BLOCK_MIN_CHARS || proseWordCount(text) < PROSE_WORDS) {
        return;
    }

    blocks.push({
        startIndex: span.start,
        endIndex: span.end,
        startLine: lineAt(starts, span.start),
        endLine: lineAt(starts, span.end),
        text,
        lead: leadSentenceOf(text),
    });
}

/**
 * Every byte a declaration already accounts for: its own range and the doc comment above it.
 *
 * A comment inside a range is part of a body chunk or of the head vector's inline-comment text, so indexing it again
 * would answer one query twice.
 */
function coveredRanges(file: ParsedFile): [number, number][] {
    const covered: [number, number][] = [];

    for (const declaration of file.all) {
        covered.push([declaration.range.startIndex, declaration.range.endIndex]);

        if (declaration.docRange !== undefined) {
            covered.push([declaration.docRange.startIndex, declaration.docRange.endIndex]);
        }
    }

    return covered;
}

function newlinesBetween(source: string, end: number, start: number): number {
    let count = 0;

    for (let index = end; index < start; index += 1) {
        if (source[index] === "\n") {
            count += 1;
        }
    }

    return count;
}

function proseWordCount(text: string): number {
    return text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
}

/** The first sentence of a block, or its first ~140 characters when it has no full stop. */
function leadSentenceOf(text: string): string {
    const stop = text.search(/\.(\s|$)/);

    if (stop !== -1 && stop < 140) {
        return text.slice(0, stop + 1);
    }

    if (text.length <= 140) {
        return text;
    }

    const cut = text.lastIndexOf(" ", 140);

    return `${text.slice(0, cut === -1 ? 140 : cut).trimEnd()}…`;
}

function lineStarts(source: string): number[] {
    const starts = [0];

    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") {
            starts.push(index + 1);
        }
    }

    return starts;
}

/** The one-based line holding `offset`. */
function lineAt(starts: readonly number[], offset: number): number {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
        const middle = (low + high + 1) >> 1;

        if ((starts[middle] ?? 0) <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low + 1;
}
