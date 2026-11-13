import { yieldToEventLoop } from "../../common/async";
import { tokenize } from "./semantic/bm25";
import { normalizeText } from "./text";
import type { Declaration, ParsedFile } from "./types";

/**
 * Literal body-text search.
 *
 * The declaration channels read names, doc comments, and frontmatter; this one reads the text between statements —
 * log messages, thrown errors, inline comments, SQL fragments — so a query that no identifier spells out still
 * lands on *a declaration* instead of a line. It is deliberately literal: `[body]` rows are exact text evidence,
 * which is why they rank above the relevance tail and below a doc comment.
 */

/** Rows returned when the name and doc channels found little: a page of candidates, not one row. */
export const BODY_ROWS = 20;

/** Rows returned when a name or doc match already answers the query: enough to show the text exists. */
export const BODY_ROWS_WHEN_LED = 3;

/** Scan this many files between event-loop turns. The per-file scan is microseconds, so yielding by file count was
 * spending more time in `setImmediate` than in the scan itself: 361 files every 8 turns cost ~45 ms of the channel's
 * ~50 ms. A file is capped at `MAX_FILE_BYTES`, so one turn is still short. */
const BODY_FILE_YIELD_INTERVAL = 64;

/** Keep only a few recent queries per parsed file, the same policy the lexical hit cache uses. */
const FILE_BODY_CACHE_LIMIT = 4;

export interface BodyHit {
    file: ParsedFile;
    declaration: Declaration;
    /** The first line inside the declaration that carries a query token, shortened for output. */
    evidence: { line: number; text: string };
    /** Occurrences of the query's anchor token inside this declaration. */
    count: number;
    /** Whether the whole query appears contiguously, which ranks above the same words scattered. */
    phrase: boolean;
}

export interface BodyQuery {
    /** Content words: stopwords dropped, camel humps and separators split. */
    tokens: string[];
    /** The whole query lowercased with punctuation collapsed, for adjacency. */
    phrase: string;
    quoted: boolean;
}

/**
 * The body channel's query, or `undefined` when the query is not text-shaped.
 *
 * A single word is an identifier question — "where is this used" is `usages`, and every declaration whose body
 * mentions `connect` would otherwise flood the result. Text-shaped means at least two whitespace-separated words,
 * which is exactly the shape of an error message, a log line, or a remembered comment.
 */
export function bodyQueryOf(raw: string, quoted: boolean): BodyQuery | undefined {
    const text = quoted ? raw.slice(1, -1).trim() : raw.trim();
    const words = text.split(/\s+/).filter((word) => word.length > 0);

    if (words.length < 2) {
        return undefined;
    }

    const tokens = tokenize(text);

    if (tokens.length === 0) {
        return undefined;
    }

    return { tokens, phrase: normalizeText(text), quoted };
}

/** Lowercase and collapse punctuation, so a phrase matches hyphenated and spaced text alike. */
const bodyHitCache = new WeakMap<ParsedFile, Map<string, BodyHit[]>>();

export async function collectBodyHits(
    parsed: readonly ParsedFile[],
    query: BodyQuery,
    signal?: AbortSignal,
): Promise<BodyHit[]> {
    const hits: BodyHit[] = [];
    const key = `${query.tokens.join(" ")}\u0000${query.phrase}\u0000${query.quoted ? "q" : ""}`;
    const anchor = query.tokens.toSorted((left, right) => right.length - left.length)[0] ?? "";
    let processed = 0;

    for (const file of parsed) {
        // Markdown prose is already the doc channel: a body row would restate a section the doc tier found.
        if (file.language === "markdown") {
            continue;
        }

        const cached = cachedBodyHits(file, key);

        if (cached !== undefined) {
            hits.push(...cached);

            continue;
        }

        const fileHits = bodyHitsForFile(file, query, anchor);

        storeBodyHits(file, key, fileHits);
        hits.push(...fileHits);

        processed += 1;

        if (processed % BODY_FILE_YIELD_INTERVAL === 0) {
            signal?.throwIfAborted();
            await yieldToEventLoop(0, signal);
        }
    }

    return hits.toSorted(compareBodyHits);
}

function bodyHitsForFile(file: ParsedFile, query: BodyQuery, anchor: string): BodyHit[] {
    // One case-insensitive pass over the file rejects the common case: no declaration body can match if the file
    // does not hold every token at all.
    const lower = file.source.toLowerCase();

    if (!query.tokens.every((token) => lower.includes(token))) {
        return [];
    }

    // Slicing the already-lowercased text avoids lowercasing every body again; the ranges stay valid as long as the
    // case mapping is length-preserving, which is true for the source this indexes and checked rather than assumed.
    const offsetsSafe = lower.length === file.source.length;
    const matches: BodyHit[] = [];

    for (const declaration of file.all) {
        const range = declaration.bodyRange;

        if (range === undefined) {
            continue;
        }

        const body = file.source.slice(range.startIndex, range.endIndex);
        const lowerBody = offsetsSafe
            ? lower.slice(range.startIndex, range.endIndex)
            : body.toLowerCase();

        if (!query.tokens.every((token) => lowerBody.includes(token))) {
            continue;
        }

        const phrase = query.phrase.length > 0 && normalizeText(lowerBody).includes(query.phrase);
        const evidence = evidenceFor(body, range.startLine, anchor, query.tokens);

        if (evidence === undefined) {
            continue;
        }

        matches.push({
            file,
            declaration,
            evidence,
            count: countOccurrences(lowerBody, anchor),
            phrase,
        });
    }

    return innermostOnly(matches);
}

/** The matched line to show, and the line it is on, so the row can name where the text sits. */
function evidenceFor(
    body: string,
    startLine: number,
    anchor: string,
    tokens: readonly string[],
): BodyHit["evidence"] | undefined {
    const lines = body.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const lower = line.toLowerCase();

        if (tokens.some((token) => lower.includes(token))) {
            return { line: startLine + index, text: line.replace(/\s+/g, " ").trim() };
        }
    }

    return undefined;
}

/**
 * Drop a match whose range contains another match's range.
 *
 * A class body contains every method body, so a phrase found in one method would otherwise be reported twice: once
 * for the method and once for the class. The innermost declaration is the one `show` should return.
 */
function innermostOnly(matches: readonly BodyHit[]): BodyHit[] {
    return matches.filter(
        (hit) =>
            !matches.some(
                (other) => other !== hit && containsRange(hit.declaration, other.declaration),
            ),
    );
}

function containsRange(outer: Declaration, inner: Declaration): boolean {
    return (
        outer.range.startIndex <= inner.range.startIndex &&
        inner.range.endIndex <= outer.range.endIndex &&
        (outer.range.startIndex < inner.range.startIndex ||
            inner.range.endIndex < outer.range.endIndex)
    );
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) {
        return 0;
    }

    let count = 0;
    let index = haystack.indexOf(needle);

    while (index >= 0) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }

    return count;
}

function compareBodyHits(left: BodyHit, right: BodyHit): number {
    return (
        Number(right.phrase) - Number(left.phrase) ||
        right.count - left.count ||
        spanOf(left.declaration) - spanOf(right.declaration) ||
        left.file.path.localeCompare(right.file.path) ||
        left.declaration.range.startLine - right.declaration.range.startLine
    );
}

function spanOf(declaration: Declaration): number {
    return declaration.range.endIndex - declaration.range.startIndex;
}

function cachedBodyHits(file: ParsedFile, key: string): BodyHit[] | undefined {
    const cache = bodyHitCache.get(file);
    const hits = cache?.get(key);

    if (cache === undefined || hits === undefined) {
        return undefined;
    }

    cache.delete(key);
    cache.set(key, hits);

    return hits;
}

function storeBodyHits(file: ParsedFile, key: string, hits: BodyHit[]): void {
    let cache = bodyHitCache.get(file);

    if (cache === undefined) {
        cache = new Map();
        bodyHitCache.set(file, cache);
    }

    cache.delete(key);
    cache.set(key, hits);

    while (cache.size > FILE_BODY_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        cache.delete(oldest);
    }
}
