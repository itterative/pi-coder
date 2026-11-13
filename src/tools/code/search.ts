import { yieldToEventLoop } from "../../common/async";
import { BODY_ROWS, BODY_ROWS_WHEN_LED, bodyQueryOf, collectBodyHits } from "./body";
import { discoverFiles, filterPathTarget, parsePathTarget, patternWithinTarget } from "./discovery";
import {
    discoveryCapNote,
    filterNote,
    isContainer,
    isFunctionLike,
    kindLabel,
    normalizeSymbol,
    lineRange,
    nextOffsetNote,
    renderWithinBudget,
    shortLine,
    shortSignature,
    withinNote,
    type BudgetedText,
} from "./format";
import { fuzzyLimit, fuzzyNameDistance } from "./fuzzy";
import { DEFAULT_CHAR_LIMIT } from "./languages";
import { loadParsedFiles } from "./load";
import { withinResolution, withinScope, type WithinScope } from "./scope";
import { tokenize } from "./semantic/bm25";
import { stem } from "./stem";
import type { CodeChunk } from "./semantic/chunks";
import { TAIL_ROWS, declarationKey, leadsWithRelated, wantsTail } from "./semantic/rank";
import type { SemanticSearch } from "./semantic/types";
import type { CodeSource } from "./source";
import { declarationDoc, normalizeText } from "./text";
import { CallTiming } from "./timing";
import { isDeclarationKind, type CodeToolParams, type Declaration, type ParsedFile } from "./types";

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
 * Ranking tiers, lowest first. A doc match outranks every approximate name match: prose is where a concept lives
 * when no identifier spells it out, so a plausible guess at an identifier is worse evidence than a documented
 * description.
 *
 * The channels are split again by evidence strength. A contiguous phrase is stronger than the same words scattered
 * through a section — "page table" appeared in 49 sections that merely mentioned pages and tables, and the sections
 * that say "page table" were the answer.
 *
 * Frontmatter sits below a prose phrase and above prose tokens. It is the densest text in a memory tree (a curated
 * `description:`), but its *keys* are boilerplate: query "keep updated" matches `keep_updated: true` in 82 files,
 * so a frontmatter `description:` that explains the field has to outrank them, and only the prose-phrase tier can
 * do that.
 */
const TIER_EXACT = 0;
const TIER_PREFIX = 1;
const TIER_SUBSTRING = 2;
const TIER_DOC_PHRASE = 3;
const TIER_FRONTMATTER_PHRASE = 4;
const TIER_FRONTMATTER = 5;
const TIER_DOC = 6;
/** Literal text found in a declaration body: exact evidence, weaker than prose, stronger than a guess. */
const TIER_BODY = 7;
const TIER_FUZZY = 8;
/** Relevance-tail rows: real declarations, but ranked by meaning rather than by name. */
const TIER_RELATED = 9;

/** Keep near-miss names from flooding the output when a concept word fuzzily matches many identifiers. */
const FUZZY_ROW_LIMIT = 8;

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
    /** Lowercase content-word stems, matched against doc text with every token required. */
    docTokens: string[];
    /** The whole query as one normalized run of words, for phrase adjacency. */
    phrase: string;
    /** Set when the caller quoted the query, which makes the phrase required rather than merely preferred. */
    quoted: boolean;
}

interface SearchHit {
    file: ParsedFile;
    declaration: Declaration;
    /** 0 exact, 1 prefix, 2 substring, 3-6 doc text, 7 body text, 8 approximate, 9 related. */
    tier: number;
    /** Present only for approximate results. */
    distance?: number;
    /** Present only for body-text rows: where the text sits, and how often it occurs. */
    body?: { line: number; text: string; count: number };
    /** Present when a body chunk produced the similarity score, so the row can name the span that matched. */
    chunk?: CodeChunk;
}

export async function runSearch(
    source: CodeSource,
    params: CodeToolParams,
    signal?: AbortSignal,
    semantic?: SemanticSearch,
    timing: CallTiming = new CallTiming(),
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

    const target = parsePathTarget(params.path);
    const root = source.resolvePath(target.base);
    const scope = target.pattern ?? source.displayPath(root);
    const limit = params.limit ?? DEFAULT_CHAR_LIMIT;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));

    await source.assertReadable(root);

    const discovery = await timing.measure("discover", () =>
        discoverFiles(source, root, signal, patternWithinTarget(target)),
    );

    if (discovery.unsupportedRoot) {
        return {
            text: `# search ${quotedForMessage(query)} · unsupported file\n# no supported declarations to search`,
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    if (discovery.files.length === 0) {
        return {
            text: `# search ${quotedForMessage(query)} in ${scope} · ${target.pattern === undefined ? "no supported source files" : "no files match"}`,
            files: 0,
            parseErrors: 0,
            truncated: false,
            matches: 0,
        };
    }

    const targeted = filterPathTarget(discovery.files, source, target);

    if (targeted.files.length === 0) {
        return {
            text: [
                `# search ${quotedForMessage(query)} in ${scope} · no files match`,
                discovery.truncated ? discoveryCapNote() : "",
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: 0,
            parseErrors: 0,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const batch = await timing.measure("parse", () =>
        loadParsedFiles(source, targeted.files, signal),
    );
    timing.recordLoad(batch, targeted.files.length);
    const parsedAll = batch.parsed.toSorted((left, right) => left.path.localeCompare(right.path));
    const resolution =
        params.within === undefined
            ? undefined
            : await withinResolution(source, root, target.pattern, signal, timing);
    const scoped =
        params.within === undefined
            ? undefined
            : await timing.measure("search", () =>
                  withinScope({
                      source,
                      root,
                      raw: params.within ?? "",
                      parsed: parsedAll,
                      files: resolution ?? discovery.files,
                      signal,
                  }),
              );

    if (scoped !== undefined && "error" in scoped) {
        return {
            text: scoped.error,
            files: 0,
            parseErrors: parsedAll.reduce((total, file) => total + file.parseErrors, 0),
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const parsed = scoped?.scope.parsed ?? parsedAll;
    const parseErrors = parsed.reduce((total, file) => total + file.parseErrors, 0);

    if (parsed.length === 0) {
        return {
            text: [
                `# search ${quotedForMessage(query)} in ${scope} · no readable supported files`,
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
    const kind =
        params.kind !== undefined && isDeclarationKind(params.kind) ? params.kind : undefined;
    const matchesKind = (declaration: Declaration): boolean =>
        kind === undefined || declaration.kind === kind;
    const literalAll = await timing.measure("search", () => collectLiteral(parsed, query, signal));
    const literal = literalAll.filter((hit) => matchesKind(hit.declaration));
    const docMatches = literal.reduce((count, hit) => count + (isDocTier(hit.tier) ? 1 : 0), 0);
    // Counted apart from body doc text because the rows are labelled apart: a summary that calls a `[frontmatter]`
    // row "by doc text" describes the same rows with two names.
    const frontmatterMatches = literal.reduce(
        (count, hit) =>
            count + (hit.declaration.kind === "frontmatter" && isDocTier(hit.tier) ? 1 : 0),
        0,
    );
    // Literal body text: exact evidence, gated on query shape rather than on the lexical pass, because a strong
    // name match says nothing about whether the error string the caller remembers lives somewhere else.
    const bodyQuery =
        query.qualifier !== undefined ? undefined : bodyQueryOf(query.raw, query.quoted);
    const bodyAll =
        bodyQuery === undefined
            ? []
            : await timing.measure("search", () => collectBodyHits(parsed, bodyQuery, signal));
    const bodyKept = bodyAll.filter((hit) => matchesKind(hit.declaration));
    // The cap is a budget decision, not an evidence one: when a name or doc row already answers the query, a few
    // body rows show the text exists without spending the page on it.
    const ledByNameOrDoc = literal.length >= 3 || docMatches > 0;
    const bodyCap = ledByNameOrDoc ? BODY_ROWS_WHEN_LED : BODY_ROWS;
    const bodyHits = bodyKept.slice(0, bodyCap);
    const bodyWithheld = bodyKept.length - bodyHits.length;
    const bodyRows: SearchHit[] = bodyHits.map((hit) => ({
        file: hit.file,
        declaration: hit.declaration,
        tier: TIER_BODY,
        body: { ...hit.evidence, count: hit.count },
    }));
    const kindHidden = literalAll.length - literal.length + (bodyAll.length - bodyKept.length);
    const fuzzy =
        literal.length === 0
            ? await timing.measure("search", () => collectFuzzy(parsed, query, signal))
            : undefined;
    const fuzzyHits = (fuzzy?.hits ?? []).filter((hit) => matchesKind(hit.declaration));
    const hiddenTotal = kindHidden + ((fuzzy?.hits.length ?? 0) - fuzzyHits.length);
    // A name or doc-phrase hit is the precise answer and stays first. Anything weaker is prose, which the embedding
    // channel answers better than a doc tier that merely saw every word somewhere, so there its rows lead. Body
    // evidence is literal and keeps its place ahead of the related rows for the same reason.
    const strongMatch =
        literal.some((hit) => hit.tier <= TIER_FRONTMATTER_PHRASE) || bodyRows.length > 0;
    const leads = leadsWithRelated(strongMatch);
    // A typo of an identifier is precise evidence too, so a fuzzy result keeps priority over related rows; a
    // lexical-led answer still takes a related tail when it is thin, exactly as before.
    const wantsRelated =
        fuzzyHits.length === 0 &&
        (leads || wantsTail(literal.length + bodyRows.length, docMatches));
    const related = wantsRelated
        ? (
              await timing.measure("tail", () =>
                  collectRelated(
                      semantic,
                      leads,
                      parsed,
                      source,
                      root,
                      query,
                      discovery.truncated,
                      [...literal, ...bodyRows, ...fuzzyHits],
                      signal,
                  ),
              )
          ).filter((hit) => matchesKind(hit.declaration))
        : [];
    const relatedKeys = new Set(related.map((hit) => declarationKey(hit.file, hit.declaration)));
    const lexicalRest = [...literal, ...bodyRows, ...fuzzyHits].filter(
        (hit) => !relatedKeys.has(declarationKey(hit.file, hit.declaration)),
    );
    const hits = leads ? [...related, ...lexicalRest] : [...lexicalRest, ...related];
    const total = hits.length;
    const approximate = fuzzyHits.length > 0;
    const filter = filterNote({
        path: target.pattern,
        pathHidden: targeted.hidden,
        kind,
        kindHidden: hiddenTotal,
    });
    const within = scoped === undefined ? undefined : withinLine(source, scoped.scope);

    if (total === 0) {
        const reason =
            fuzzy !== undefined
                ? "no declarations or approximate matches"
                : "no declarations match";

        return {
            text: [
                `# ${reason} ${quotedForMessage(query)} in ${scope} · ${fileCount(parsed.length)} · ${languages}`,
                filter ?? "",
                within ?? "",
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
            files: parsed.length,
            parseErrors,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const header = headerFor(
        scope,
        parsed.length,
        languages,
        query,
        total,
        approximate,
        docMatches - frontmatterMatches,
        frontmatterMatches,
        bodyRows.length,
        related.length,
    );
    const rows = hits.map((hit) => renderHit(source, hit));
    const body = rows.join("\n");
    const fitted = renderWithinBudget(header, [body], limit, offset);
    const footer = footerFor({
        approximate,
        query,
        discoveryTruncated: discovery.truncated,
        shown: total,
        approximateTotal: fuzzy?.total ?? 0,
        relatedMatches: related.length,
        bodyMatches: bodyRows.length,
        bodyWithheld,
        filter,
        within,
        more: moreNote(source, hits, rows, fitted),
    });
    const hint = related.length > 0 && semantic?.hint !== undefined ? [semantic.hint] : [];
    const next = nextOffsetNote(fitted);
    const text = [fitted.text, next, ...footer, ...hint]
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

/** The query as the caller wrote it, quoted once: a phrase query already carries its own quotes. */
function quotedForMessage(query: ParsedQuery): string {
    return query.quoted ? query.raw : `"${query.raw}"`;
}

function parseQuery(raw: string): ParsedQuery {
    const trimmed = raw.trim();
    const quoted = trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"');
    const text = quoted ? trimmed.slice(1, -1).trim() : trimmed;
    const doubleColon = text.lastIndexOf("::");
    const dot = text.lastIndexOf(".");
    const separator = Math.max(doubleColon, dot);
    const separatorLength = separator === doubleColon ? 2 : 1;
    const normalized = normalizeSymbol(text).toLowerCase();
    const phrase = normalizeText(text);
    const docTokens = docTokensOf(text);

    if (separator <= 0) {
        return { raw: trimmed, normalized, name: text, docTokens, phrase, quoted };
    }

    return {
        raw: trimmed,
        normalized,
        name: text.slice(separator + separatorLength),
        qualifier: normalizeSymbol(text.slice(0, separator)).toLowerCase(),
        docTokens,
        phrase,
        quoted,
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

            const tier = literalTier(declaration, query) ?? docTier(file, declaration, query);

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
            return TIER_EXACT;
        }

        if (qualified.startsWith(query.normalized)) {
            return TIER_PREFIX;
        }

        return qualified.includes(query.normalized) ? TIER_SUBSTRING : undefined;
    }

    const name = declaration.name.toLowerCase();
    const requested = query.name.toLowerCase();

    if (name === requested) {
        return TIER_EXACT;
    }

    if (name.startsWith(requested)) {
        return TIER_PREFIX;
    }

    return name.includes(requested) ? TIER_SUBSTRING : undefined;
}

/** The doc channel's tiers are weaker evidence than a name match and stronger than a fuzzy one. */
function isDocTier(tier: number): boolean {
    return tier >= TIER_DOC_PHRASE && tier <= TIER_DOC;
}

/**
 * Tier for a match inside the declaration's doc text.
 *
 * This is the channel that answers "where is the thing that does X" when the identifier does not spell X out:
 * `fuzzyLimit` is reachable by "edit distance" only because its comment says so. Tokens are matched in any order,
 * all required, so word order in the query does not matter; a query that also appears *contiguously* ranks above one
 * whose words are merely scattered through the section. A quoted query requires the phrase outright.
 *
 * Qualified queries skip this channel: their qualifier already narrowed the scope, and prose would spend that
 * precision.
 */
function docTier(
    file: ParsedFile,
    declaration: Declaration,
    query: ParsedQuery,
): number | undefined {
    if (query.qualifier !== undefined || query.docTokens.length === 0) {
        return undefined;
    }

    const doc = docTextOf(file, declaration);

    if (doc.normalized.length === 0) {
        return undefined;
    }

    const contiguous = query.phrase.length > 0 && doc.normalized.includes(query.phrase);

    if (!contiguous && query.quoted) {
        return undefined;
    }

    if (!contiguous && !query.docTokens.every((token) => doc.tokens.has(token))) {
        return undefined;
    }

    const frontmatter = declaration.kind === "frontmatter";

    if (contiguous) {
        return frontmatter ? TIER_FRONTMATTER_PHRASE : TIER_DOC_PHRASE;
    }

    return frontmatter ? TIER_FRONTMATTER : TIER_DOC;
}

interface DocText {
    /** Punctuation collapsed and lowercased, for phrase adjacency. */
    normalized: string;
    /** Stems, all-tokens-required, for the token test. */
    tokens: Set<string>;
}

/**
 * Normalized doc text, cached per declaration.
 *
 * The declarations belong to a `ParsedFile`, so a reparse drops these with the file's other WeakMap entries.
 * Collapsing punctuation is what makes "edit distance" match "edit-distance budget" in a comment, and stemming is
 * what makes "spilling" find a comment that says "spill".
 */
const docTextCache = new WeakMap<Declaration, DocText>();

function docTextOf(file: ParsedFile, declaration: Declaration): DocText {
    const cached = docTextCache.get(declaration);

    if (cached !== undefined) {
        return cached;
    }

    const range = declaration.docRange;
    const text = range === undefined ? "" : declarationDoc(file, declaration);
    const doc = { normalized: normalizeText(text), tokens: new Set(docTokensOf(text)) };
    docTextCache.set(declaration, doc);

    return doc;
}

/**
 * The doc tiers' query tokens.
 *
 * The same tokenizer BM25 uses, then the light stemmer: a stopword that is filtered from the lexical rank but kept
 * here would be *required* to appear in the prose, so "strip comment markers from the doc text" would miss a comment
 * that says exactly that. Stemming applies only here, never to identifiers: `list` and `listing` are different names
 * but the same concept in prose.
 */
function docTokensOf(text: string): string[] {
    return tokenize(text).map(stem);
}

async function collectRelated(
    semantic: SemanticSearch | undefined,
    leads: boolean,
    parsed: readonly ParsedFile[],
    source: CodeSource,
    root: string,
    query: ParsedQuery,
    truncated: boolean,
    shown: readonly SearchHit[],
    signal?: AbortSignal,
): Promise<SearchHit[]> {
    if (semantic === undefined) {
        return [];
    }

    // A related-first page skips nothing: its own rows come first, and the lexical ones are filtered after it.
    const shownKeys = new Set(
        leads ? [] : shown.map((hit) => declarationKey(hit.file, hit.declaration)),
    );
    const ranked = await semantic.rank(
        {
            query: query.raw,
            root,
            sourceKind: source.kind,
            files: parsed,
            truncated,
            similarityOnly: leads,
        },
        signal,
    );
    const tail: SearchHit[] = [];

    for (const entry of ranked) {
        const key = declarationKey(entry.file, entry.declaration);

        if (shownKeys.has(key)) {
            continue;
        }

        shownKeys.add(key);
        tail.push({
            file: entry.file,
            declaration: entry.declaration,
            tier: TIER_RELATED,
            chunk: entry.chunk,
        });

        if (tail.length >= TAIL_ROWS) {
            break;
        }
    }

    return tail;
}

async function collectFuzzy(
    parsed: readonly ParsedFile[],
    query: ParsedQuery,
    signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; total: number }> {
    const maxDistance = fuzzyLimit(query.name);

    if (maxDistance === undefined) {
        return { hits: [], total: 0 };
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
                fileHits.push({ file, declaration, tier: TIER_FUZZY, distance });
            }
        }

        storeFileHits(file, key, fileHits);
        hits.push(...fileHits);
    }

    const sorted = hits.toSorted((left, right) => {
        return (
            (left.distance ?? 0) - (right.distance ?? 0) ||
            left.declaration.name.length - right.declaration.name.length ||
            compareHits(left, right)
        );
    });

    return { hits: sorted.slice(0, FUZZY_ROW_LIMIT), total: sorted.length };
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
    const signature =
        declaration.kind === "frontmatter" ? "" : shortSignature(declaration.signature, 240);
    const tag = declarationTag(declaration);
    const channel = channelTag(hit);
    const approximate = hit.distance === undefined ? "" : ` ~${hit.distance}`;

    const columns = [
        location,
        kindLabel(declaration.kind),
        declaration.qualifiedName,
        signature,
    ].filter((column) => column.length > 0);
    const row = `${columns.join("  ")}${tag}${channel}${approximate}`;

    if (hit.body !== undefined) {
        const count = hit.body.count > 1 ? `  ×${hit.body.count}` : "";

        return `${row}\n  :${hit.body.line}  ${shortLine(hit.body.text)}${count}`;
    }

    if (hit.chunk !== undefined) {
        // The declaration range says nothing about which part matched; the chunk span is what `read` should fetch.
        return `${row}\n  §${hit.chunk.index}/${hit.chunk.total}  :${hit.chunk.startLine}-${hit.chunk.endLine}`;
    }

    return row;
}

function channelTag(hit: SearchHit): string {
    if (hit.declaration.kind === "frontmatter" && isDocTier(hit.tier)) {
        return " [frontmatter]";
    }

    if (isDocTier(hit.tier)) {
        return " [doc]";
    }

    if (hit.tier === TIER_BODY) {
        return " [body]";
    }

    return hit.tier === TIER_RELATED ? " [related]" : "";
}

function declarationTag(declaration: Declaration): string {
    if (!isFunctionLike(declaration.kind) && !isContainer(declaration.kind)) {
        return "";
    }

    return declaration.isDefinition ? " [def]" : " [decl]";
}

function headerFor(
    scope: string,
    fileTotal: number,
    languages: string,
    query: ParsedQuery,
    total: number,
    approximate: boolean,
    docMatches: number,
    frontmatterMatches: number,
    bodyMatches: number,
    relatedMatches: number,
): string {
    const summary = matchSummary(
        total,
        docMatches,
        frontmatterMatches,
        bodyMatches,
        approximate,
        relatedMatches,
    );

    return `# search ${quotedForMessage(query)} in ${scope} · ${fileCount(fileTotal)} · ${languages} · ${summary}`;
}

/** Name, doc, body, and relevance channels are counted separately so a reader can tell which one produced a row. */
function matchSummary(
    total: number,
    docMatches: number,
    frontmatterMatches: number,
    bodyMatches: number,
    approximate: boolean,
    relatedMatches: number,
): string {
    const matches = `${total} ${total === 1 ? "match" : "matches"}`;
    const channels: string[] = [];

    if (docMatches > 0) {
        channels.push(`${docMatches} by doc text`);
    }

    if (frontmatterMatches > 0) {
        channels.push(`${frontmatterMatches} by frontmatter`);
    }

    if (bodyMatches > 0) {
        channels.push(`${bodyMatches} by body text`);
    }

    if (relatedMatches > 0) {
        channels.push(`${relatedMatches} related`);
    }

    if (approximate) {
        if (channels.length === 0) {
            return `no name or doc matches · ${total} approximate`;
        }

        channels.push("approximate");
    }

    return channels.length === 0 ? matches : `${matches} · ${channels.join(" · ")}`;
}

function footerFor(options: {
    approximate: boolean;
    query: ParsedQuery;
    discoveryTruncated: boolean;
    shown: number;
    approximateTotal: number;
    relatedMatches: number;
    bodyMatches: number;
    bodyWithheld: number;
    filter: string | undefined;
    within: string | undefined;
    more: string | undefined;
}): string[] {
    const footer: string[] = [];

    if (options.relatedMatches > 0) {
        footer.push(
            "# related: ranked by term overlap and, when the embedding index is warm, similarity — not by name or doc comment; a §i/n :start-end line names the body chunk that matched · outline show to confirm",
        );
    }

    if (options.bodyMatches > 0) {
        footer.push(
            "# body: the declaration that contains the text, not the line · outline show returns it whole · line-level hits, regex, and counts stay with rg",
        );
    }

    if (options.bodyWithheld > 0) {
        footer.push(
            `# body: ${counted(options.bodyWithheld, "more declaration")} withheld; a name or doc match already leads, so the page keeps the strongest rows`,
        );
    }

    if (options.more !== undefined) {
        footer.push(options.more);
    }

    if (options.filter !== undefined) {
        footer.push(options.filter);
    }

    if (options.within !== undefined) {
        footer.push(options.within);
    }

    if (options.approximate) {
        const maxDistance = fuzzyLimit(options.query.name) ?? 0;
        const clipped =
            options.approximateTotal > options.shown
                ? ` · nearest ${options.shown} of ${options.approximateTotal}`
                : "";

        footer.push(
            `# approximate: edit distance ≤ ${maxDistance}${clipped}; use outline show for the exact source`,
        );
    }

    if (options.discoveryTruncated) {
        footer.push(discoveryCapNote());
    }

    return footer;
}

function counted(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Name what a cut page left behind.
 *
 * A row-paged result used to end at `# next: offset=N` with no hint that the best match — the file whose *section*
 * answered the question — was on the next page. Naming the next row's file is enough to tell a caller to keep
 * reading instead of reformulating the query.
 */
function moreNote(
    source: CodeSource,
    hits: readonly SearchHit[],
    rows: readonly string[],
    fitted: BudgetedText,
): string | undefined {
    const onPage = new Set(fitted.text.split("\n"));
    // A body row carries an evidence line under the match, so only its first line is the row's identity.
    const firstLine = (row: string): string => row.split("\n")[0] ?? row;
    const firstUnseen = rows.findIndex((row) => !onPage.has(firstLine(row)));

    if (firstUnseen < 0) {
        return undefined;
    }

    const unseen = rows.filter((row) => !onPage.has(firstLine(row))).length;
    const next = hits[firstUnseen];
    const where = next === undefined ? "" : `, next in ${source.displayPath(next.file.path)}`;

    return `# more: ${unseen} of ${rows.length} match(es) on later pages${where}`;
}

function languagesOf(files: readonly ParsedFile[]): string {
    return Array.from(new Set(files.map((file) => file.language)))
        .toSorted()
        .join(",");
}

function withinLine(source: CodeSource, scope: WithinScope): string {
    return withinNote({
        direction: scope.direction,
        anchor: source.displayPath(scope.anchor),
        files: scope.parsed.length,
        outside: scope.outside,
    });
}

function fileCount(count: number): string {
    return `${count} ${count === 1 ? "file" : "files"}`;
}
