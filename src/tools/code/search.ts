import { yieldToEventLoop } from "../../common/async";
import {
    BODY_ROWS,
    BODY_ROWS_WHEN_LED,
    bodyQueryOf,
    collectBodyHits,
    type BodyQuery,
} from "./body";
import type { CommentBlock } from "./comment-blocks";
import { collectCommentHits } from "./comment-search";
import { discoverFiles, filterPathTarget, parsePathTarget, patternWithinTarget } from "./discovery";
import {
    bodyThenFooter,
    declarationKindCounts,
    defaultScopeNote,
    discoveryCapNote,
    filterNote,
    isContainer,
    isDefinitionTagged,
    kindLabel,
    normalizeSymbol,
    lineRange,
    nextOffsetNote,
    renderWithinBudget,
    scopeLabel,
    shortLine,
    shortSignature,
    withinScopeLabel,
    type BudgetedText,
} from "./format";
import { fuzzyLimit, fuzzyNameDistance } from "./fuzzy";
import { DEFAULT_CHAR_LIMIT, SUPPORTED_LANGUAGE_NAMES } from "./languages";
import { loadParsedFiles } from "./load";
import { withinLine, withinResolution, withinScope } from "./scope";
import type { WithinScope } from "./scope";
import { tokenize } from "./semantic/bm25";
import { stem } from "./stem";
import type { CodeChunk } from "./semantic/chunks";
import { TAIL_ROWS, declarationKey, leadsWithRelated, rankKeyOf } from "./semantic/rank";
import type { RankScale } from "./semantic/rank";
import type { SemanticSearch } from "./semantic/types";
import type { CodeSource } from "./source";
import { declarationDoc, normalizeText } from "./text";
import { CallTiming } from "./timing";
import {
    isDeclarationKind,
    matchesDeclarationKind,
    type CodeToolParams,
    type Declaration,
    type ParsedFile,
} from "./types";

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
/** Literal text in a comment block no declaration owns: prose evidence, like a body hit. */
const TIER_COMMENT = 7;
/** Literal text found in a declaration body: exact evidence, weaker than prose, stronger than a guess. */
const TIER_BODY = 8;
const TIER_FUZZY = 9;
/** Relevance-tail rows: real declarations, but ranked by meaning rather than by name. */
const TIER_RELATED = 10;

/** Comment rows on a page. The channel is prose evidence, so it stays a handful. */
const COMMENT_ROWS = 6;
const COMMENT_ROWS_WHEN_LED = 2;

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
    /** Absent on a comment row, which names a block of prose no declaration owns. */
    declaration?: Declaration;
    /** Present on a comment row: the block itself, so the row can print its range and lead. */
    comment?: CommentBlock;
    /** 0 exact, 1 prefix, 2 substring, 3-6 doc text, 7 comment text, 8 body text, 9 approximate, 10 related. */
    tier: number;
    /** Present only for approximate results. */
    distance?: number;
    /**
     * The confidence of a related row: its ranker score as an integer percentage of the best row in this result.
     *
     * The channels do not share a scale — a cosine is 0-1, BM25 is unbounded, and a fused RRF sum is around 0.02 —
     * so one rule is applied to all three: the best guess on the page is 100% and the rest are proportional. It says
     * how close a row is to the best guess, not how likely it is to be right. Absent on every exact channel, which
     * matched or did not.
     */
    confidence?: number;
    /** Present for body-text and comment rows: where the text sits, and how often it occurs. */
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
            text: `# search ${quotedForMessage(query)} · unsupported file\n# no supported declarations to search · outline parses ${SUPPORTED_LANGUAGE_NAMES}`,
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
            text: bodyThenFooter(
                [`# search ${quotedForMessage(query)} in ${scope} · no files match`],
                [discovery.truncated ? discoveryCapNote() : ""],
            ),
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
            text: bodyThenFooter(
                [`# search ${quotedForMessage(query)} in ${scope} · no readable supported files`],
                [
                    batch.tooLarge > 0
                        ? `# skipped: ${batch.tooLarge} file(s) above the size limit`
                        : "",
                    ...batch.errors.slice(0, 3).map((error) => `# ${error}`),
                ],
            ),
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
        kind === undefined || matchesDeclarationKind(declaration.kind, kind);
    // A comment row carries no declaration kind, so a kind filter excludes it rather than guessing.
    const ownsKind = (hit: SearchHit): boolean =>
        hit.declaration === undefined ? kind === undefined : matchesKind(hit.declaration);
    const literalAll = await timing.measure("search", () => collectLiteral(parsed, query, signal));
    const literal = literalAll.filter(ownsKind);
    const docMatches = literal.reduce((count, hit) => count + (isDocTier(hit.tier) ? 1 : 0), 0);
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
    const comment = await timing.measure("search", () =>
        commentChannel({
            parsed,
            bodyQuery,
            kindSpecified: kind !== undefined,
            led: ledByNameOrDoc,
            signal,
        }),
    );
    const commentRows = comment.rows;
    const commentWithheld = comment.withheld;
    const commentMatches = commentRows.length;
    const folded = foldBodyRows(literal, bodyRows);
    const literalRows = folded.literal;
    const standaloneBody = folded.body;
    const bodyMatches = standaloneBody.length;
    const kindHidden = literalAll.length - literal.length + (bodyAll.length - bodyKept.length);
    const fuzzy =
        literal.length === 0
            ? await timing.measure("search", () => collectFuzzy(parsed, query, signal))
            : undefined;
    const fuzzyHits = (fuzzy?.hits ?? []).filter(ownsKind);
    const hiddenTotal = kindHidden + ((fuzzy?.hits.length ?? 0) - fuzzyHits.length);
    // A name or doc-phrase hit is the precise answer and stays first. Anything weaker is prose, which the embedding
    // channel answers better than a doc tier that merely saw every word somewhere, so there its rows lead. Body
    // evidence is literal and keeps its place ahead of the related rows for the same reason.
    const strongMatch =
        literalRows.some((hit) => hit.tier <= TIER_FRONTMATTER_PHRASE) ||
        bodyMatches > 0 ||
        commentMatches > 0;
    const leads = leadsWithRelated(strongMatch);
    // A typo of an identifier is precise evidence too, so a fuzzy result keeps priority over related rows; a
    // lexical-led answer still takes a related tail when it is thin, exactly as before.
    // The dense channel runs on every search: a warm query embedding is under 100 ms, and the literal pass cannot know
    // what it failed to find. A name or body hit still leads (`leads`), so the tail only ever decorates an answer that
    // already had evidence.
    const wantsRelated = wantsRelatedChannel(query, fuzzyHits.length);
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
                      [...literalRows, ...standaloneBody, ...commentRows, ...fuzzyHits],
                      signal,
                  ),
              )
          ).filter(ownsKind)
        : [];
    const relatedKeys = new Set(related.map((hit) => hitKey(hit)));
    const lexicalRest = [...literalRows, ...standaloneBody, ...commentRows, ...fuzzyHits].filter(
        (hit) => !relatedKeys.has(hitKey(hit)),
    );
    const ranked = leads ? relatedLedPage(related, lexicalRest) : [...lexicalRest, ...related];
    // One heading per file. A related-led page lists its guesses, then the literal rows, so a file that contributed
    // to both used to head two blocks and the repeat read as a second file. Grouping by first appearance keeps the
    // ranked order of files — the file whose guess led still leads — and keeps the page's row offsets ascending.
    const hits = groupHitsByFile(ranked);
    const total = hits.length;
    // A related row is a guess ranked by similarity, so it must not be counted as a match: "3 matches" over three
    // guesses is the one number in this output an agent will repeat as a fact.
    const literalTotal = hits.filter((hit) => hit.tier !== TIER_RELATED).length;
    // The channel tallies describe the rows the page carries, not the candidates the channels collected: a doc-tier
    // row the related tail also ranked is displayed as a guess, so counting it as a doc match made the summary read
    // `2 matches · 4 by doc text`. The evidence gates above still see the undeduped list.
    const literalOnPage = hits.filter((hit) => hit.tier !== TIER_RELATED);
    const docOnPage = literalOnPage.filter((hit) => isDocTier(hit.tier));
    const frontmatterOnPage = docOnPage.filter(
        (hit) => hit.declaration?.kind === "frontmatter",
    ).length;
    const bodyOnPage = literalOnPage.filter((hit) => hit.tier === TIER_BODY).length;
    const commentOnPage = literalOnPage.filter((hit) => hit.tier === TIER_COMMENT).length;
    const approximate = fuzzyHits.length > 0;
    const filter = filterNote({
        path: target.pattern,
        pathHidden: targeted.hidden,
        kind,
        kindHidden: hiddenTotal,
        kindCounts: kind === undefined ? undefined : declarationKindCounts(parsed),
    });
    const within = scoped === undefined ? undefined : withinLine(source, scoped.scope);
    const withinLabel = headerWithinLabel(source, scoped?.scope);

    if (total === 0) {
        const reason =
            fuzzy !== undefined
                ? "no declarations or approximate matches"
                : "no declarations match";

        return {
            text: bodyThenFooter(
                [
                    `# ${reason} ${quotedForMessage(query)} in ${scope} · ${fileCount(parsed.length)} · ${languages}`,
                ],
                [defaultScopeNote(params.path), filter, within],
            ),
            files: parsed.length,
            parseErrors,
            truncated: discovery.truncated,
            matches: 0,
        };
    }

    const header = headerFor(
        scope,
        withinLabel,
        parsed.length,
        languages,
        query,
        literalTotal,
        approximate,
        docOnPage.length - frontmatterOnPage,
        frontmatterOnPage,
        bodyOnPage,
        commentOnPage,
        related.length,
    );
    const rows = hits.map((hit) => ({
        text: renderHit(hit),
        path: source.displayPath(hit.file.path),
    }));
    const body = groupBlocks(rows);
    const fitted = renderWithinBudget(header, body.blocks, limit, offset, { headings: true });
    const visible = visibleChannels(hits, body.starts, fitted);
    const displaced = displacedNote(
        source,
        leads,
        related.length,
        literalTotal,
        visible.firstHiddenLiteral,
    );
    const footer = footerFor({
        approximate,
        query,
        discoveryTruncated: discovery.truncated,
        shown: total,
        approximateTotal: fuzzy?.total ?? 0,
        relatedMatches: related.length,
        relatedVisible: visible.relatedVisible,
        bodyMatches: bodyOnPage,
        bodyWithheld,
        commentMatches: commentOnPage,
        commentWithheld,
        displacedLiteral: displaced,
        filter,
        within,
        page: pageNote(total, body.starts, fitted),
        more: moreNote(rows, body.starts, fitted),
    });
    const hint = related.length > 0 && semantic?.hint !== undefined ? [semantic.hint] : [];
    const next = nextOffsetNote(fitted, params);
    // Related rows are guesses, not matches: a search with no literal row still needs to say that the default scan
    // skipped ignored paths, or the guesses read as the whole answer.
    const scopeNote = scopeNoteFor(params, literalTotal);
    const text = bodyThenFooter([fitted.text], [next, scopeNote, ...footer, ...hint]);

    return {
        text,
        files: parsed.length,
        parseErrors,
        truncated: discovery.truncated || fitted.truncated,
        matches: literalTotal,
    };
}

/**
 * Comment blocks: the prose no declaration owns — a file header, a note between statements.
 *
 * Gated like the body channel, because a single word is an identifier question, and suppressed under a kind filter,
 * which has no comment kind to name.
 */
async function commentChannel(options: {
    parsed: readonly ParsedFile[];
    bodyQuery: BodyQuery | undefined;
    kindSpecified: boolean;
    led: boolean;
    signal?: AbortSignal;
}): Promise<{ rows: SearchHit[]; withheld: number }> {
    const { bodyQuery } = options;

    if (bodyQuery === undefined || options.kindSpecified) {
        return { rows: [], withheld: 0 };
    }

    const hits = await collectCommentHits(options.parsed, bodyQuery, options.signal);
    const kept = hits.slice(0, options.led ? COMMENT_ROWS_WHEN_LED : COMMENT_ROWS);

    return {
        rows: kept.map((hit) => ({
            file: hit.file,
            comment: hit.block,
            tier: TIER_COMMENT,
            body: { ...hit.evidence, count: hit.count },
        })),
        withheld: hits.length - kept.length,
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

/**
 * A related-led page, with one slot kept for the strongest literal row.
 *
 * Similarity leads when the lexical pass has no precise evidence, because a doc tier that merely saw every content
 * word somewhere is not an answer. But a full `TAIL_ROWS` of guesses can push the query's *only* literal match onto
 * the next page, and the `# more:` note then points at the one row that was evidence. Reserving a slot costs the tail
 * its weakest row and only applies when it would otherwise fill the leading page.
 */
function relatedLedPage(
    related: readonly SearchHit[],
    lexicalRest: readonly SearchHit[],
): SearchHit[] {
    if (lexicalRest.length === 0 || related.length < TAIL_ROWS) {
        return [...related, ...lexicalRest];
    }

    return [...related.slice(0, TAIL_ROWS - 1), ...lexicalRest, ...related.slice(TAIL_ROWS - 1)];
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
    const shownKeys = new Set(leads ? [] : shown.map((hit) => hitKey(hit)));
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
    const best = ranked[0]?.score ?? 0;

    for (const entry of ranked) {
        const key = rankKeyOf(entry);

        if (shownKeys.has(key)) {
            continue;
        }

        shownKeys.add(key);
        tail.push({
            file: entry.file,
            declaration: entry.declaration,
            comment: entry.comment,
            tier: TIER_RELATED,
            chunk: entry.chunk,
            confidence: confidencePercent(entry.score, best, entry.scale),
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
            (left.declaration?.name.length ?? 0) - (right.declaration?.name.length ?? 0) ||
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
        hitStartLine(left) - hitStartLine(right) ||
        (left.declaration?.qualifiedName ?? "").localeCompare(
            right.declaration?.qualifiedName ?? "",
        )
    );
}

/**
 * Stable identity for a row: a declaration's byte start, or a comment block's.
 *
 * A comment names no declaration, so it needs its own key for the dedupe between the lexical and related channels.
 */
function hitKey(hit: SearchHit): string {
    if (hit.declaration !== undefined) {
        return declarationKey(hit.file, hit.declaration);
    }

    return `${hit.file.path}\u0000comment\u0000${hit.comment?.startIndex ?? 0}`;
}

function hitStartLine(hit: SearchHit): number {
    return hit.declaration?.range.startLine ?? hit.comment?.startLine ?? 0;
}

/** The line span a row names, whether it is a declaration or a comment block. */
function hitRange(hit: SearchHit): string {
    if (hit.comment !== undefined) {
        const { startLine, endLine } = hit.comment;

        return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    }

    return hit.declaration === undefined ? "" : lineRange(hit.declaration.range);
}

/**
 * One rendered row and the file it came from.
 *
 * The path is carried beside the text rather than inside it: a search names the same file on almost every row, so
 * the path is printed once as a heading and the rows are its subitems.
 */
interface RenderedRow {
    text: string;
    path: string;
}

/** The page body: one block per file, its path as the first line and its rows indented under it. */
function groupBlocks(rows: readonly RenderedRow[]): { blocks: string[]; starts: number[] } {
    const blocks: string[] = [];
    const starts: number[] = [];
    let current: string | undefined;
    let blockStart = 0;
    let lines: string[] = [];

    // Blocks are separated by a blank line, so `flattenBlocks` advances a block start by its line count plus one.
    const flush = (): void => {
        if (lines.length === 0) {
            return;
        }

        blocks.push(lines.join("\n"));
        blockStart += lines.length + 1;
        lines = [];
    };

    for (const row of rows) {
        if (row.path !== current) {
            flush();
            current = row.path;
            lines.push(row.path);
        }

        starts.push(blockStart + lines.length);

        for (const line of row.text.split("\n")) {
            lines.push(`  ${line}`);
        }
    }

    flush();

    return { blocks, starts };
}

/**
 * The page's rows, one block per file.
 *
 * A related-led page lists its guesses, then the literal rows, so a file that contributed to both headed two blocks
 * and the repeated path read as a second file. Grouping by first appearance keeps the ranked order of files — the
 * file whose guess led still leads — while every row for a file sits under one heading and the block offsets used for
 * paging stay ascending.
 */
function groupHitsByFile(hits: readonly SearchHit[]): SearchHit[] {
    const byPath = new Map<string, SearchHit[]>();

    for (const hit of hits) {
        const rows = byPath.get(hit.file.path);

        if (rows === undefined) {
            byPath.set(hit.file.path, [hit]);

            continue;
        }

        rows.push(hit);
    }

    return Array.from(byPath.values()).flat();
}

function renderHit(hit: SearchHit): string {
    const location = `:${hitRange(hit)}`;

    // A comment row names a block of prose that `show` cannot return, so it prints its own range and evidence inside
    // it: a bare `comment :1-9` would tell a caller where to look but not whether it is worth the read.
    if (hit.comment !== undefined) {
        const channel = channelTag(hit);
        const evidence = hit.body;

        if (evidence === undefined) {
            return `${location}  comment  "${hit.comment.lead}"${channel}`;
        }

        const count = evidence.count > 1 ? `  (×${evidence.count} in block)` : "";

        return `${location}  comment${channel}${count}\n  :${evidence.line}  ${shortLine(undecoratedComment(evidence.text))}`;
    }

    const declaration = hit.declaration;

    if (declaration === undefined) {
        return location;
    }

    const tag = declarationTag(declaration);
    const channel = channelTag(hit);
    const approximate = hit.distance === undefined ? "" : ` ~${hit.distance}`;
    const columns = rowColumns(declaration, location).filter((column) => column.length > 0);
    const row = `${columns.join("  ")}${tag}${channel}${approximate}`;

    if (hit.body !== undefined) {
        const count = hit.body.count > 1 ? `  (×${hit.body.count} in body)` : "";

        return `${row}\n  :${hit.body.line}  ${shortLine(hit.body.text)}${count}`;
    }

    if (hit.chunk !== undefined) {
        // The declaration range says nothing about which part matched; the chunk span is what `read` should fetch.
        return `${row}\n  §${hit.chunk.index}/${hit.chunk.total}  :${hit.chunk.startLine}-${hit.chunk.endLine}`;
    }

    return row;
}

/**
 * The columns a row prints.
 *
 * A block is named by the call that opened it and the title it was given: `block  outline flow::caps one scope's
 * rows and counts the rest  it("caps one scope's rows and counts the rest")` says one thing three times, and the
 * `::` path reads as a C++ qualifier on prose. The parent scope stays, in parentheses, because two suites may share
 * a title.
 */
function rowColumns(declaration: Declaration, location: string): string[] {
    const callee = declaration.blockCallee;

    if (callee !== undefined) {
        const qualified = declaration.qualifiedName;
        const separator = qualified.lastIndexOf("::");
        const parent = separator === -1 ? "" : qualified.slice(0, separator);

        return [
            location,
            callee,
            `"${declaration.name}"`,
            parent.length === 0 ? "" : `(${parent})`,
        ];
    }

    const signature =
        declaration.kind === "frontmatter" ? "" : shortSignature(declaration.signature, 240);

    // A heading's literal text is its name. `Parent::Parent::Child` repeats a chain a digest map already shows by
    // indentation, and the signature column prints the heading itself, so the chain is dropped rather than said twice.
    if (declaration.kind === "heading") {
        return [
            location,
            kindLabel(declaration.kind),
            signature.length > 0 ? signature : declaration.qualifiedName,
        ];
    }

    return [location, kindLabel(declaration.kind), declaration.qualifiedName, signature];
}

/**
 * Which channels the fitted page actually shows.
 *
 * The related legend and the `# also:` note describe rows the caller can read, so they are decided from the page the
 * character budget produced, not from the result the channels collected.
 */
function visibleChannels(
    hits: readonly SearchHit[],
    starts: readonly number[],
    fitted: BudgetedText,
): { relatedVisible: boolean; firstHiddenLiteral: SearchHit | undefined } {
    const end = fitted.nextOffset ?? Number.POSITIVE_INFINITY;
    const onPage = (index: number): boolean => {
        const start = starts[index] ?? -1;

        return start >= fitted.offset && start < end;
    };
    const relatedVisible = hits.some((hit, index) => hit.tier === TIER_RELATED && onPage(index));
    const literalVisible = hits.some((hit, index) => hit.tier !== TIER_RELATED && onPage(index));

    return {
        relatedVisible,
        // A literal row on the page needs no note: naming a row the caller can already see repeats it.
        firstHiddenLiteral: literalVisible
            ? undefined
            : hits.find((hit) => hit.tier !== TIER_RELATED),
    };
}

/**
 * A literal row the related-led page pushed below its guesses.
 *
 * The related-led order is a measured decision (a plain doc tier answers prose queries worse than similarity does), so
 * it stays. What must not happen is the one row with real evidence being paged out unseen, so the footer names it —
 * but only when the page really cannot show it: a row the caller can already read needs no second mention.
 */
function displacedNote(
    source: CodeSource,
    leads: boolean,
    relatedTotal: number,
    literalTotal: number,
    firstHiddenLiteral: SearchHit | undefined,
): string | undefined {
    // "Literal rows follow the related guesses" is false when the tail came back empty — a prose query does that
    // whenever every candidate falls below the floor — and a note about guesses the page cannot show is noise.
    if (!leads || relatedTotal === 0 || literalTotal === 0 || firstHiddenLiteral === undefined) {
        return undefined;
    }

    return displacedLiteral(source, literalTotal, firstHiddenLiteral);
}

function displacedLiteral(
    source: CodeSource,
    count: number,
    first: SearchHit | undefined,
): string | undefined {
    if (first === undefined) {
        return undefined;
    }

    const where = `${source.displayPath(first.file.path)}:${hitRange(first)}`;
    const noun = count === 1 ? "literal row follows" : `${count} literal rows follow`;

    if (first.comment !== undefined) {
        return `# also: ${noun} the related guesses · ${where} comment "${first.comment.lead}"${channelTag(first)}`;
    }

    const declaration = first.declaration;

    if (declaration === undefined) {
        return undefined;
    }

    const label = declaration.blockCallee ?? kindLabel(declaration.kind);
    // The same rule the row follows: a heading is named by its literal text, not by the chain it sits under.
    const name =
        declaration.kind === "heading" && declaration.signature.length > 0
            ? declaration.signature
            : declaration.qualifiedName;

    return `# also: ${noun} the related guesses · ${where} ${label} ${name}${channelTag(first)}`;
}

/**
 * Body rows merged into the rows that already list their declaration.
 *
 * A body row names the declaration that contains the text. When that declaration is on the page by name, the row
 * restates it (`deps.test.ts:49-63` appeared twice, once with evidence), so the evidence moves onto the listed row.
 * When the evidence instead belongs to a *descendant* that is listed, the row would put a case's line under its
 * suite's heading, so it goes. Both need the file as well as the line: line 3 of another file is not inside this one.
 */
function foldBodyRows(
    literal: readonly SearchHit[],
    bodyRows: readonly SearchHit[],
): { literal: SearchHit[]; body: SearchHit[] } {
    const listed = new Map(
        literal
            .filter(hasDeclaration)
            .map((hit) => [declarationKey(hit.file, hit.declaration), { ...hit }]),
    );
    const kept: SearchHit[] = [];

    for (const row of bodyRows) {
        const declaration = row.declaration;

        if (declaration === undefined) {
            kept.push(row);

            continue;
        }

        const own = listed.get(declarationKey(row.file, declaration));

        if (own !== undefined) {
            own.body ??= row.body;

            continue;
        }

        const line = row.body?.line;
        const insideListed =
            line !== undefined &&
            Array.from(listed.values()).some(
                (hit) =>
                    hit.file.path === row.file.path &&
                    (hit.declaration?.range.startLine ?? 0) <= line &&
                    line <= (hit.declaration?.range.endLine ?? 0),
            );

        if (!insideListed) {
            kept.push(row);
        }
    }

    return { literal: Array.from(listed.values()), body: kept };
}

/**
 * A comment's evidence line without its decoration.
 *
 * The block's text is stripped, but the evidence line is read from the source, so a `*` or `//` prefix would be the
 * first thing the row shows on a row that is about prose.
 */
function undecoratedComment(text: string): string {
    return text.replace(/^\s*(?:\/\*+|\*\/+|\*|\/\/+)\s?/, "").trim();
}

function hasDeclaration(hit: SearchHit): hit is SearchHit & { declaration: Declaration } {
    return hit.declaration !== undefined;
}

function channelTag(hit: SearchHit): string {
    const related = `[related${scoreLabel(hit)}]`;

    if (hit.comment !== undefined) {
        // The row's kind column already says `comment`, so only the guess tag is left to add: a block reached by
        // similarity is still a guess, and the "guesses are not matches" rule has to hold.
        return hit.tier === TIER_RELATED ? ` ${related}` : "";
    }

    if (hit.declaration?.kind === "frontmatter" && isDocTier(hit.tier)) {
        return " [frontmatter]";
    }

    if (isDocTier(hit.tier)) {
        return " [doc]";
    }

    if (hit.tier === TIER_BODY) {
        return " [body]";
    }

    return hit.tier === TIER_RELATED ? ` ${related}` : "";
}

/**
 * The ranked channel's score, on the tag of the row it placed.
 *
 * A bare `[related]` says the row is a guess but not whether it is the best guess or the last one over the floor.
 * Three significant digits keep a fused RRF sum (`0.0167`) and a BM25 score (`12.4`) both readable.
 */
/**
 * A ranker score as an integer percentage on the row.
 *
 * The embedding channel's cosine is already 0-1, so its percentage is the score itself and 71% means 0.71 of
 * similarity. BM25 is unbounded and a fused RRF sum sits near 0.02, so those two are divided by the best row in the
 * same result: 100% means "best guess here", not "certain".
 */
function confidencePercent(score: number, best: number, scale: RankScale): number {
    const value = scale === "cosine" ? score * 100 : best > 0 ? (score / best) * 100 : 0;

    return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreLabel(hit: SearchHit): string {
    return hit.confidence === undefined ? "" : ` ${hit.confidence}%`;
}

function declarationTag(declaration: Declaration): string {
    // A block always has a body, so `[def]` on every suite and case would be noise where a class's tag is a fact.
    if (declaration.kind === "block") {
        return "";
    }

    if (!isDefinitionTagged(declaration.kind) && !isContainer(declaration.kind)) {
        return "";
    }

    return declaration.isDefinition ? " [def]" : " [decl]";
}

/**
 * Whether the dense channel runs for this query.
 *
 * Every query runs it: a warm query embedding is 51–69 ms, and the literal channels cannot see what they missed. Two
 * shapes are not questions and skip it — a typo of an identifier (the corrected name is the answer, and precise
 * evidence outranks a similarity guess) and a one-character query (a substring request, not a topic).
 */
function scopeNoteFor(params: CodeToolParams, literalTotal: number): string | undefined {
    return literalTotal === 0 ? defaultScopeNote(params.path) : undefined;
}

function wantsRelatedChannel(query: ParsedQuery, fuzzyCount: number): boolean {
    return fuzzyCount === 0 && query.raw.replace(/"/g, "").length > 1;
}

/**
 * The compact scope phrase for the header, or nothing when the call is not scoped.
 *
 * The header is read before the footer, and `search "x" in src` over six imports is the same misreading the
 * `# within:` line exists to prevent.
 */
function headerWithinLabel(source: CodeSource, scope: WithinScope | undefined): string | undefined {
    if (scope === undefined) {
        return undefined;
    }

    return withinScopeLabel({
        direction: scope.direction,
        anchor: source.displayPath(scope.anchor),
        relativeTo: scope.relativeTo,
    });
}

function headerFor(
    scope: string,
    within: string | undefined,
    fileTotal: number,
    languages: string,
    query: ParsedQuery,
    total: number,
    approximate: boolean,
    docMatches: number,
    frontmatterMatches: number,
    bodyMatches: number,
    commentMatches: number,
    relatedMatches: number,
): string {
    const summary = matchSummary(
        total,
        docMatches,
        frontmatterMatches,
        bodyMatches,
        commentMatches,
        approximate,
        relatedMatches,
    );

    return `# search ${quotedForMessage(query)} in ${scopeLabel(scope)}${within === undefined ? "" : ` within ${within}`} · ${fileCount(fileTotal)} · ${languages} · ${summary}`;
}

/**
 * Name, doc, body, comment, and relevance channels are counted separately so a reader can tell which one produced a
 * row.
 *
 * `literal` excludes the related rows on purpose. Counting them made `3 matches` out of three similarity guesses, and
 * a caller reads that number as "the identifier exists"; with no literal row the summary says so instead.
 */
function matchSummary(
    literal: number,
    docMatches: number,
    frontmatterMatches: number,
    bodyMatches: number,
    commentMatches: number,
    approximate: boolean,
    relatedMatches: number,
): string {
    const matches =
        literal === 0 ? "no literal matches" : `${literal} ${literal === 1 ? "match" : "matches"}`;
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

    if (commentMatches > 0) {
        channels.push(`${commentMatches} by comment text`);
    }

    if (relatedMatches > 0) {
        channels.push(`${relatedMatches} related guess${relatedMatches === 1 ? "" : "es"}`);
    }

    if (approximate) {
        if (channels.length === 0) {
            return `no name or doc matches · ${literal} approximate`;
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
    /** Whether a related row is on this page: a legend for rows the page does not show is noise. */
    relatedVisible: boolean;
    bodyMatches: number;
    bodyWithheld: number;
    commentMatches: number;
    commentWithheld: number;
    displacedLiteral: string | undefined;
    filter: string | undefined;
    within: string | undefined;
    page: string | undefined;
    more: string | undefined;
}): string[] {
    const footer: string[] = [];

    if (options.relatedMatches > 0 && options.relatedVisible) {
        footer.push(
            "# related: guesses, not matches · % = similarity (embedding) or share of the best guess (BM25/fused) · §i/n :start-end = matched chunk",
        );
    }

    if (options.bodyMatches > 0) {
        footer.push(
            "# body: the row names the declaration; the line under it is the one the query hits, and ×N counts the word in that body · outline show returns the declaration whole · line-level hits, regex, and counts stay with rg",
        );
    }

    if (options.bodyWithheld > 0) {
        footer.push(
            `# body: ${counted(options.bodyWithheld, "more declaration")} withheld; a name or doc match already leads, so the page keeps the strongest rows`,
        );
    }

    if (options.commentMatches > 0) {
        const withheld =
            options.commentWithheld > 0
                ? ` · ${counted(options.commentWithheld, "more block")} withheld`
                : "";

        footer.push(
            `# comment: prose no declaration owns — a file header or a note between statements · the line under the row is the one the query hits, and ×N counts the word in that block${withheld}`,
        );
    }

    if (options.displacedLiteral !== undefined) {
        footer.push(options.displacedLiteral);
    }

    if (options.more !== undefined) {
        footer.push(options.more);
    }

    if (options.page !== undefined) {
        footer.push(options.page);
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

    // One character is a substring request, not a name: 155 rows is the answer to a different question.
    if (options.query.raw.replace(/"/g, "").length === 1) {
        footer.push(
            "# note: a one-character query matches by substring only; widen it before trusting the row count",
        );
    }

    return footer;
}

function counted(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The rows this page actually shows.
 *
 * The header counts the whole result: the channels are a fact about everything the query matched, and the page is a
 * character budget. Without this line `38 matches · 5 by doc text` over eight rows reads as a contradiction, and the
 * caller cannot tell a short result from a shortened one.
 */
function pageNote(
    total: number,
    starts: readonly number[],
    fitted: BudgetedText,
): string | undefined {
    const end = fitted.nextOffset;

    if (end === undefined && fitted.offset === 0) {
        return undefined;
    }

    const limit = end ?? Number.POSITIVE_INFINITY;
    const shown = starts.filter((start) => start >= fitted.offset && start < limit).length;

    if (shown === 0) {
        return `# page: no rows at this offset · ${counted(total, "row")} in the result`;
    }

    const first = starts.findIndex((start) => start >= fitted.offset);
    const start = (first < 0 ? 0 : first) + 1;

    return `# page: rows ${start}-${start + shown - 1} of ${total} · the header counts the whole result`;
}

/**
 * Name the file the next page resumes in, when it is not the file this page ended on.
 *
 * A row-paged result used to end at the offset with no hint that the best match — the file whose *section* answered
 * the question — was on the next page. The line count is not repeated here: `# next:` already carries it, and two
 * counters a line apart read as two different remaining amounts. The row starts are exact line indices, so this
 * does not guess from the rendered text.
 */
function moreNote(
    rows: readonly RenderedRow[],
    starts: readonly number[],
    fitted: BudgetedText,
): string | undefined {
    const end = fitted.nextOffset;

    if (end === undefined) {
        return undefined;
    }

    const firstUnseen = starts.findIndex((start) => start >= end);
    const lastShown = firstUnseen - 1;

    if (firstUnseen < 0 || lastShown < 0) {
        return undefined;
    }

    // The signal is "content from another file is still unread", not "the cut landed exactly between two files":
    // a page boundary inside a long first file would otherwise never mention the file behind it.
    const shownPath = rows[lastShown]?.path;
    const crossing = rows.slice(firstUnseen).find((row) => row.path !== shownPath);

    if (crossing === undefined) {
        return undefined;
    }

    return `# more: later rows continue in ${crossing.path}`;
}

function languagesOf(files: readonly ParsedFile[]): string {
    return Array.from(new Set(files.map((file) => file.language)))
        .toSorted()
        .join(",");
}

function fileCount(count: number): string {
    return `${count} ${count === 1 ? "file" : "files"}`;
}
