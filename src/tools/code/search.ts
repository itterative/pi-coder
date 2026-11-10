import { yieldToEventLoop } from "../../common/async";
import { discoverFiles } from "./discovery";
import {
    isContainer,
    isFunctionLike,
    kindLabel,
    normalizeSymbol,
    lineRange,
    nextOffsetNote,
    renderWithinBudget,
    shortSignature,
} from "./format";
import { fuzzyLimit, fuzzyNameDistance } from "./fuzzy";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import type { CodeSource } from "./source";
import type { CodeToolParams, Declaration, ParsedFile } from "./types";

export interface SearchResult {
    text: string;
    files: number;
    parseErrors: number;
    truncated: boolean;
    matches: number;
}

/** Scan this many declarations between event-loop turns while looking for matches. */
const SEARCH_YIELD_INTERVAL = 1_024;

/** Keep only a few recent queries per parsed file; search pagination needs just the current one. */
const FILE_SEARCH_CACHE_LIMIT = 4;

/**
 * Per-file search hits are keyed by the ParsedFile object. The parsed-file cache replaces that object when
 * path + mtime + size changes, so the old hits become unreachable with it.
 */
const fileSearchCache = new WeakMap<ParsedFile, Map<string, SearchHit[]>>();

interface ParsedQuery {
    /** The query as the caller wrote it, trimmed. */
    raw: string;
    /** Lowercase, whitespace-free, dot-to-`::` form used for qualified matching. */
    normalized: string;
    /** The simple name part, or the last component of a qualified query. */
    name: string;
    /** Lowercase qualified prefix, when the query contains `::` or `.`. */
    qualifier?: string;
}

interface SearchHit {
    file: ParsedFile;
    declaration: Declaration;
    /** 0 exact, 1 prefix, 2 substring. */
    tier: number;
    /** Present only for approximate results. */
    distance?: number;
}

export async function runSearch(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
): Promise<SearchResult> {
    const query = parseQuery(params.query ?? "");

    if (query.raw.length === 0) {
        return {
            text: '# search needs a query, e.g. outline(action="search", query="connect")',
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const root = source.resolvePath(params.path ?? ".");
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));

    await source.assertReadable(root);

    const discovery = await discoverFiles(source, root, signal);

    if (discovery.unsupportedRoot) {
        return {
            text: `# search "${query.raw}" · unsupported file\n# no supported declarations to search`,
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    if (discovery.files.length === 0) {
        return {
            text: `# search "${query.raw}" in ${source.displayPath(root)} · no supported source files`,
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const batch = await loadParsedFiles(source, discovery.files, signal);
    const parsed = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const parseErrors = parsed.reduce((total, file) => total + file.parseErrors, 0);

    if (parsed.length === 0) {
        return {
            text: [
                `# search "${query.raw}" in ${source.displayPath(root)} · no readable supported files`,
                batch.tooLarge > 0
                    ? `# skipped: ${batch.tooLarge} file(s) above the size limit`
                    : "",
                ...batch.errors.slice(0, 3).map((error) => `# ${error}`),
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: 0,
            parseErrors,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const languages = languagesOf(parsed);
    const literal = await collectLiteral(parsed, query, signal);
    const approximate = literal.length === 0;
    const hits = approximate ? await collectFuzzy(parsed, query, signal) : literal;
    const total = hits.length;

    if (total === 0) {
        const kind = approximate
            ? "no declarations or approximate matches"
            : "no declarations match";

        return {
            text: `# ${kind} "${query.raw}" in ${source.displayPath(root)} · ${fileCount(parsed.length)} · ${languages}`,
            files: parsed.length,
            parseErrors,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const header = headerFor(source, root, parsed.length, languages, query, total, approximate);
    const body = hits.map((hit) => renderHit(source, hit)).join("\n");
    const fitted = renderWithinBudget(header, [body], limit, offset);
    const footer = footerFor(approximate, query, discovery.truncated);
    const next = nextOffsetNote(fitted.nextOffset);
    const text = [fitted.text, next, ...footer]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n");

    return {
        text,
        files: parsed.length,
        parseErrors,
        truncated: discovery.truncated || fitted.truncated,
        matches: total,
    };
}

function parseQuery(raw: string): ParsedQuery {
    const trimmed = raw.trim();
    const doubleColon = trimmed.lastIndexOf("::");
    const dot = trimmed.lastIndexOf(".");
    const separator = Math.max(doubleColon, dot);
    const separatorLength = separator === doubleColon ? 2 : 1;
    const normalized = normalizeSymbol(trimmed).toLowerCase();

    if (separator <= 0) {
        return { raw: trimmed, normalized, name: trimmed };
    }

    return {
        raw: trimmed,
        normalized,
        name: trimmed.slice(separator + separatorLength),
        qualifier: normalizeSymbol(trimmed.slice(0, separator)).toLowerCase(),
    };
}

async function collectLiteral(
    parsed: readonly ParsedFile[],
    query: ParsedQuery,
    signal?: AbortSignal,
): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const key = `literal:${query.normalized}`;
    let processed = 0;

    for (const file of parsed) {
        const cached = cachedFileHits(file, key);

        if (cached !== undefined) {
            hits.push(...cached);

            continue;
        }

        const fileHits: SearchHit[] = [];

        for (const declaration of file.all) {
            processed += 1;

            if (processed % SEARCH_YIELD_INTERVAL === 0) {
                signal?.throwIfAborted();
                await yieldToEventLoop(0, signal);
            }

            const tier = literalTier(declaration, query);

            if (tier !== undefined) {
                fileHits.push({ file, declaration, tier });
            }
        }

        storeFileHits(file, key, fileHits);
        hits.push(...fileHits);
    }

    return hits.toSorted(compareHits);
}

function literalTier(declaration: Declaration, query: ParsedQuery): number | undefined {
    if (query.qualifier !== undefined) {
        const qualified = normalizeSymbol(declaration.qualifiedName).toLowerCase();

        if (qualified === query.normalized) {
            return 0;
        }

        if (qualified.startsWith(query.normalized)) {
            return 1;
        }

        return qualified.includes(query.normalized) ? 2 : undefined;
    }

    const name = declaration.name.toLowerCase();
    const requested = query.name.toLowerCase();

    if (name === requested) {
        return 0;
    }

    if (name.startsWith(requested)) {
        return 1;
    }

    return name.includes(requested) ? 2 : undefined;
}

async function collectFuzzy(
    parsed: readonly ParsedFile[],
    query: ParsedQuery,
    signal?: AbortSignal,
): Promise<SearchHit[]> {
    const maxDistance = fuzzyLimit(query.name);

    if (maxDistance === undefined) {
        return [];
    }

    const hits: SearchHit[] = [];
    const key = `fuzzy:${query.normalized}`;
    let processed = 0;

    for (const file of parsed) {
        const cached = cachedFileHits(file, key);

        if (cached !== undefined) {
            hits.push(...cached);

            continue;
        }

        const fileHits: SearchHit[] = [];

        for (const declaration of file.all) {
            processed += 1;

            if (processed % SEARCH_YIELD_INTERVAL === 0) {
                signal?.throwIfAborted();
                await yieldToEventLoop(0, signal);
            }

            if (
                query.qualifier !== undefined &&
                !normalizeSymbol(declaration.qualifiedName).toLowerCase().includes(query.qualifier)
            ) {
                continue;
            }

            const distance = fuzzyNameDistance(query.name, declaration.name, maxDistance);

            if (distance !== undefined) {
                fileHits.push({ file, declaration, tier: 3, distance });
            }
        }

        storeFileHits(file, key, fileHits);
        hits.push(...fileHits);
    }

    return hits.toSorted((left, right) => {
        return (
            (left.distance ?? 0) - (right.distance ?? 0) ||
            left.declaration.name.length - right.declaration.name.length ||
            compareHits(left, right)
        );
    });
}

function cachedFileHits(file: ParsedFile, key: string): SearchHit[] | undefined {
    const cache = fileSearchCache.get(file);
    const hits = cache?.get(key);

    if (cache === undefined || hits === undefined) {
        return undefined;
    }

    // Refresh insertion order so the current query is the last candidate for eviction.
    cache.delete(key);
    cache.set(key, hits);

    return hits;
}

function storeFileHits(file: ParsedFile, key: string, hits: SearchHit[]): void {
    let cache = fileSearchCache.get(file);

    if (cache === undefined) {
        cache = new Map();
        fileSearchCache.set(file, cache);
    }

    cache.delete(key);
    cache.set(key, hits);

    while (cache.size > FILE_SEARCH_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        cache.delete(oldest);
    }
}

function compareHits(left: SearchHit, right: SearchHit): number {
    return (
        left.tier - right.tier ||
        left.file.path.localeCompare(right.file.path) ||
        left.declaration.range.startLine - right.declaration.range.startLine ||
        left.declaration.qualifiedName.localeCompare(right.declaration.qualifiedName)
    );
}

function renderHit(source: CodeSource, hit: SearchHit): string {
    const declaration = hit.declaration;
    const location = `${source.displayPath(hit.file.path)}:${lineRange(declaration.range)}`;
    const signature = shortSignature(declaration.signature, 240);
    const tag = declarationTag(declaration);
    const approximate = hit.distance === undefined ? "" : ` ~${hit.distance}`;

    return `${location}  ${kindLabel(declaration.kind)}  ${declaration.qualifiedName}  ${signature}${tag}${approximate}`;
}

function declarationTag(declaration: Declaration): string {
    if (!isFunctionLike(declaration.kind) && !isContainer(declaration.kind)) {
        return "";
    }

    return declaration.isDefinition ? " [def]" : " [decl]";
}

function headerFor(
    source: CodeSource,
    root: string,
    fileTotal: number,
    languages: string,
    query: ParsedQuery,
    total: number,
    approximate: boolean,
): string {
    const matches = approximate
        ? `no exact matches · ${total} approximate`
        : `${total} ${total === 1 ? "match" : "matches"}`;

    return `# search "${query.raw}" in ${source.displayPath(root)} · ${fileCount(fileTotal)} · ${languages} · ${matches}`;
}

function footerFor(
    approximate: boolean,
    query: ParsedQuery,
    discoveryTruncated: boolean,
): string[] {
    const footer: string[] = [];

    if (approximate) {
        const maxDistance = fuzzyLimit(query.name) ?? 0;

        footer.push(
            `# approximate: edit distance ≤ ${maxDistance}; use outline show for the exact source`,
        );
    }

    if (discoveryTruncated) {
        footer.push("# note: file discovery was capped; scan a narrower path");
    }

    return footer;
}

function languagesOf(files: readonly ParsedFile[]): string {
    return Array.from(new Set(files.map((file) => file.language)))
        .toSorted()
        .join(",");
}

function fileCount(count: number): string {
    return `${count} ${count === 1 ? "file" : "files"}`;
}
