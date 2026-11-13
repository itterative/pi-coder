import { shortSignature } from "../format";
import { EMBED_TEXT_VERSION } from "../text";
import type { Declaration, ParsedFile } from "../types";
import { modelProfile } from "./profiles";
import { hashKey } from "./store";

/**
 * Body chunks: the vectors that let a query reach *inside* a long declaration.
 *
 * The head vector of a declaration embeds its doc comment, its inline comments, and its signature — never its code.
 * That is the right unit for "which function is this", and the wrong one for "where in this 400-line function is the
 * retry loop". A chunk is one or more ordered body regions with the declaration's identity prefixed, embedded as its
 * own vector and mapped back to the declaration when it ranks.
 *
 * The plan is deterministic: same source, same policy, same chunks. Search recomputes keys from the current parse and
 * looks them up, so a plan that drifted between build and query would silently lose vectors. The policy is therefore
 * part of `EMBED_TEXT_VERSION`, and the plan is cached per parsed file so query time is hashing, not re-chunking.
 */

/** Body text shorter than this is covered by its declaration's head vector; chunking it would double small files. */
export const CHUNK_MIN_CHARS = 800;

/** Packing target. Well under the embedder's 1024-token truncation even for punctuation-heavy code. */
export const CHUNK_TARGET_CHARS = 1_600;

/** Hard ceiling for one chunk. A segment larger than this is split at line boundaries, with overlap. */
export const CHUNK_MAX_CHARS = 2_400;

/** Lines repeated at the start of the next window when one oversized segment has to be cut. */
export const CHUNK_OVERLAP_LINES = 8;

/**
 * Chunks kept per declaration.
 *
 * A declaration with more than this much body is covered by its first chunks plus its head vector (identity, doc,
 * signature), which is the honest tradeoff: a 100 k-character function cannot be fully represented without either
 * hundreds of vectors or windows past the truncation limit.
 */
export const MAX_CHUNKS_PER_DECLARATION = 12;

/** Signature text carried by every chunk header, so a fragment still says what it belongs to. */
const HEADER_SIGNATURE_CHARS = 160;

export interface CodeChunk {
    /** 1-based, for the `§i/n` marker on a result row. */
    index: number;
    total: number;
    startLine: number;
    endLine: number;
    key: string;
    text: string;
}

export function chunkKeyOf(text: string): string {
    return hashKey(`${EMBED_TEXT_VERSION}\u0000${modelProfile().id}\u0000${text}`);
}

/** The chunks of one declaration. Empty when the body is small, absent, or the language has no body. */
export function chunksOf(file: ParsedFile, declaration: Declaration): readonly CodeChunk[] {
    let perFile = chunkCache.get(file);

    if (perFile === undefined) {
        perFile = new Map();
        chunkCache.set(file, perFile);
    }

    const cached = perFile.get(declaration);

    if (cached !== undefined) {
        return cached;
    }

    const chunks = planChunks(file, declaration);

    perFile.set(declaration, chunks);

    return chunks;
}

const chunkCache = new WeakMap<ParsedFile, Map<Declaration, readonly CodeChunk[]>>();

interface Span {
    start: number;
    end: number;
}

/**
 * One planned chunk: the ordered source spans it carries.
 *
 * Not a single widened range: a chunked child is collapsed to its signature line, so the parent's chunk has gaps
 * where that child's body sits. Representing a chunk as `[first.start, last.end)` would silently pull those skipped
 * bodies back in and duplicate the child's own vectors.
 */
type ChunkSpans = Span[];

function planChunks(file: ParsedFile, declaration: Declaration): CodeChunk[] {
    const body = declaration.bodyRange;

    if (body === undefined || body.endIndex - body.startIndex < CHUNK_MIN_CHARS) {
        return [];
    }

    const spans = segmentsOf(file, declaration, body.startIndex, body.endIndex);
    const kept = capChunks(packSpans(spans, file.source));
    const starts = lineStartsOf(file);
    const signature = shortSignature(declaration.signature, HEADER_SIGNATURE_CHARS);

    return kept.map((chunkSpans, position) => {
        const index = position + 1;
        const total = kept.length;
        const first = chunkSpans[0]!;
        const last = chunkSpans.at(-1)!;
        const bodyText = chunkSpans
            .map((span) => file.source.slice(span.start, span.end).trim())
            .filter((text) => text.length > 0)
            .join("\n");
        const header = `title: ${file.path} | text: ${declaration.kind} ${declaration.qualifiedName} (§${index}/${total}) ${signature}.`;
        const text = `${header} ${bodyText}`;

        return {
            index,
            total,
            startLine: lineAt(starts, first.start),
            endLine: lineAt(starts, Math.max(first.start, last.end - 1)),
            key: chunkKeyOf(text),
            text,
        };
    });
}

/**
 * Split the body at its direct child declarations.
 *
 * Structural first: a nested helper or a block of methods is a better unit than an arbitrary line window, and the
 * prose before the first child and after the last one would otherwise be orphaned. Children keep source order, so
 * the plan is deterministic.
 *
 * A child that gets its own chunks is collapsed to its first line here. Otherwise a class's chunk would contain the
 * full body of every method it owns, and the method's own chunk would contain it again: two vectors for the same
 * code, and two rows for one match. A child too small to be chunked stays whole, because the parent is the only
 * place its code can be embedded at all.
 */
function segmentsOf(
    file: ParsedFile,
    declaration: Declaration,
    start: number,
    end: number,
): Span[] {
    const children = declaration.children
        .filter((child) => child.range.startIndex >= start && child.range.endIndex <= end)
        .filter((child) => child.range.endIndex > child.range.startIndex)
        .toSorted((left, right) => left.range.startIndex - right.range.startIndex);

    const spans: Span[] = [];
    let cursor = start;

    for (const child of children) {
        const { startIndex, endIndex } = child.range;

        if (startIndex > cursor) {
            spans.push({ start: cursor, end: startIndex });
        }

        const childEnd =
            chunksOf(file, child).length > 0
                ? firstLineEnd(file.source, startIndex, end)
                : endIndex;
        const childStart = Math.max(cursor, startIndex);

        if (childEnd > childStart) {
            spans.push({ start: childStart, end: childEnd });
        }

        cursor = Math.max(cursor, endIndex);
    }

    if (cursor < end) {
        spans.push({ start: cursor, end });
    }

    return spans.filter((span) => span.end > span.start);
}

/** Offset just past the first line of a declaration, clamped to the body it sits in. */
function firstLineEnd(source: string, start: number, limit: number): number {
    const newline = source.indexOf("\n", start);

    return Math.min(limit, newline < 0 ? limit : newline + 1);
}

/** Pack spans up to the target, giving any span above the ceiling its own line windows. */
function packSpans(spans: readonly Span[], source: string): ChunkSpans[] {
    const packed: ChunkSpans[] = [];
    let current: Span[] = [];
    let currentChars = 0;

    const flush = (): void => {
        if (current.length > 0) {
            packed.push(current);
            current = [];
            currentChars = 0;
        }
    };

    for (const span of spans) {
        const size = span.end - span.start;

        if (size > CHUNK_MAX_CHARS) {
            flush();

            for (const window of lineWindows(source, span)) {
                packed.push([window]);
            }

            continue;
        }

        if (current.length > 0 && currentChars + size > CHUNK_TARGET_CHARS) {
            flush();
        }

        current.push(span);
        currentChars += size;
    }

    flush();

    return packed;
}

/** Cut one oversized span at line boundaries, repeating a few lines of context in the next window. */
function lineWindows(source: string, span: Span): Span[] {
    const windows: Span[] = [];
    let start = span.start;

    while (start < span.end) {
        const limit = Math.min(span.end, start + CHUNK_MAX_CHARS);
        let cut = limit;

        if (limit < span.end) {
            const newline = source.lastIndexOf("\n", limit);
            cut = newline > start ? newline + 1 : limit;
        }

        const window = { start, end: cut };

        // Trim leading blank space so a window does not begin with the previous one's indentation.
        while (window.start < window.end && /\s/.test(source[window.start] ?? "")) {
            window.start += 1;
        }

        if (window.end > window.start) {
            windows.push(window);
        }

        if (cut >= span.end) {
            break;
        }

        // Overlap: back up a few lines from the cut, but never past this window's start (which would not advance).
        let overlap = cut;

        for (let line = 0; line < CHUNK_OVERLAP_LINES && overlap > window.start; line += 1) {
            const previous = source.lastIndexOf("\n", overlap - 1);

            if (previous < window.start) {
                break;
            }

            overlap = previous;
        }

        start = overlap > start ? overlap : cut;
    }

    return windows;
}

/**
 * Keep at most `MAX_CHUNKS_PER_DECLARATION` chunks.
 *
 * Adjacent chunks merge first, because dropping one silently loses the code it covered; only a declaration whose
 * chunks are each already at the ceiling loses its tail, and its head vector still names it.
 */
function capChunks(chunks: ChunkSpans[]): ChunkSpans[] {
    while (chunks.length > MAX_CHUNKS_PER_DECLARATION) {
        let merged = false;

        for (let index = 0; index < chunks.length - 1; index += 1) {
            const left = chunks[index];
            const right = chunks[index + 1];

            if (left === undefined || right === undefined) {
                continue;
            }

            const combined = [...left, ...right];
            const size = combined.reduce((total, part) => total + (part.end - part.start), 0);

            if (size > CHUNK_MAX_CHARS) {
                continue;
            }

            chunks.splice(index, 2, combined);
            merged = true;

            break;
        }

        if (!merged) {
            chunks.pop();
        }
    }

    return chunks;
}

/** Offsets of every line start, computed once per parsed file. */
const lineStartCache = new WeakMap<ParsedFile, number[]>();

function lineStartsOf(file: ParsedFile): number[] {
    const cached = lineStartCache.get(file);

    if (cached !== undefined) {
        return cached;
    }

    const starts = [0];

    for (let index = 0; index < file.source.length; index += 1) {
        if (file.source[index] === "\n") {
            starts.push(index + 1);
        }
    }

    lineStartCache.set(file, starts);

    return starts;
}

/** 1-based line number of a byte offset. */
function lineAt(starts: readonly number[], offset: number): number {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
        const middle = Math.ceil((low + high) / 2);

        if ((starts[middle] ?? 0) <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low + 1;
}
