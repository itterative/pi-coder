import { yieldToEventLoop } from "../../common/async";
import type { BodyQuery } from "./body";
import { commentBlocksOf, type CommentBlock } from "./comment-blocks";
import { normalizeText } from "./text";
import type { ParsedFile } from "./types";

/**
 * Literal text found in a comment block no declaration owns.
 *
 * The doc channel answers for a comment above a declaration and the body channel for text inside one, so this is the
 * third place prose can live: a file header, a section note, an explanation between two top-level statements. It is
 * literal evidence, like a body row, and it is gated the same way — a single word is an identifier question.
 */
export interface CommentHit {
    file: ParsedFile;
    block: CommentBlock;
    /** The first line of the block carrying a query token, shortened for output. */
    evidence: { line: number; text: string };
    /** Occurrences of the query's anchor token in the block. */
    count: number;
    /** Whether the query appears contiguously, which ranks above the same words scattered. */
    phrase: boolean;
}

/** Scan this many files between event-loop turns; a block scan is a substring test, not a parse. */
const COMMENT_FILE_YIELD_INTERVAL = 64;

export async function collectCommentHits(
    parsed: readonly ParsedFile[],
    query: BodyQuery,
    signal?: AbortSignal,
): Promise<CommentHit[]> {
    const anchor = query.tokens.toSorted((left, right) => right.length - left.length)[0] ?? "";
    const hits: CommentHit[] = [];
    let processed = 0;

    for (const file of parsed) {
        if (file.language === "markdown") {
            continue;
        }

        hits.push(...fileCommentHits(file, query, anchor));

        processed += 1;

        if (processed % COMMENT_FILE_YIELD_INTERVAL === 0) {
            signal?.throwIfAborted();
            await yieldToEventLoop(0, signal);
        }
    }

    return hits.toSorted(
        (left, right) =>
            left.file.path.localeCompare(right.file.path) ||
            left.block.startLine - right.block.startLine,
    );
}

function fileCommentHits(file: ParsedFile, query: BodyQuery, anchor: string): CommentHit[] {
    // One pass over the file rejects it before any block is read: no block can hold every token if the file does not.
    const lower = file.source.toLowerCase();

    if (!query.tokens.every((token) => lower.includes(token))) {
        return [];
    }

    const hits: CommentHit[] = [];

    for (const block of commentBlocksOf(file)) {
        const text = block.text.toLowerCase();

        if (!query.tokens.every((token) => text.includes(token))) {
            continue;
        }

        const phrase = normalizeText(block.text).includes(query.phrase);

        if (query.quoted && !phrase) {
            continue;
        }

        hits.push({
            file,
            block,
            evidence: evidenceLineOf(file, block, anchor),
            count: occurrences(text, anchor),
            phrase,
        });
    }

    return hits;
}

/** The first source line of the block that carries the anchor token, or the block's first line. */
function evidenceLineOf(
    file: ParsedFile,
    block: CommentBlock,
    anchor: string,
): { line: number; text: string } {
    const lines = file.source.split("\n");

    for (let line = block.startLine; line <= block.endLine; line += 1) {
        const text = lines[line - 1] ?? "";

        if (text.toLowerCase().includes(anchor)) {
            return { line, text: text.trim() };
        }
    }

    return { line: block.startLine, text: (lines[block.startLine - 1] ?? "").trim() };
}

function occurrences(text: string, term: string): number {
    if (term.length === 0) {
        return 0;
    }

    let count = 0;
    let index = text.indexOf(term);

    while (index !== -1) {
        count += 1;
        index = text.indexOf(term, index + term.length);
    }

    return count;
}
