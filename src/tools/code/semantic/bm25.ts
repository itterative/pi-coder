import { commentBlocksOf, type CommentBlock } from "../comment-blocks";
import { pairKey } from "../format";
import { declarationDoc } from "../text";
import type { Declaration, ParsedFile } from "../types";

export interface Bm25Hit {
    file: ParsedFile;
    /** Absent when `comment` names the owner: a comment block no declaration owns. */
    declaration?: Declaration;
    comment?: CommentBlock;
    score: number;
}

/** The identifier is the strongest signal a declaration carries, so its terms count three times. */
const NAME_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;

/**
 * Filler words that inflate a concept query's matched-document set without carrying meaning.
 *
 * The list is deliberately small and English-only: a long stoplist would start deleting words that are
 * meaningful in code (`key`, `value`, `type`, `name`), which is the opposite of what this channel needs.
 */
const STOPWORDS = new Set([
    "a",
    "about",
    "after",
    "all",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "before",
    "by",
    "can",
    "could",
    "do",
    "does",
    "for",
    "from",
    "has",
    "have",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "may",
    "me",
    "my",
    "no",
    "not",
    "of",
    "on",
    "one",
    "or",
    "our",
    "should",
    "so",
    "some",
    "than",
    "that",
    "the",
    "their",
    "then",
    "there",
    "these",
    "they",
    "this",
    "to",
    "up",
    "us",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
]);

/**
 * Split text at camel humps, acronym runs, digits, and separators.
 *
 * `HTTPServer` becomes `http server` rather than `httpserver`, and `parse2Ids` becomes `parse 2 ids`, so an
 * identifier matches the words a query uses for it.
 */
export function tokenize(text: string): string[] {
    return text
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])([0-9])/g, "$1 $2")
        .replace(/([0-9])([A-Za-z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((token) => (token.length > 1 || /^[0-9]+$/.test(token)) && !STOPWORDS.has(token));
}

interface DocEntry {
    file: ParsedFile;
    declaration?: Declaration;
    comment?: CommentBlock;
    key: string;
    tfName: Map<string, number>;
    tfDoc: Map<string, number>;
    tfSignature: Map<string, number>;
    length: number;
}

const entryCache = new WeakMap<ParsedFile, DocEntry[]>();

function counts(tokens: readonly string[]): Map<string, number> {
    const tf = new Map<string, number>();

    for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    return tf;
}

function entriesFor(file: ParsedFile): DocEntry[] {
    const cached = entryCache.get(file);

    if (cached !== undefined) {
        return cached;
    }

    const entries: DocEntry[] = file.all.map((declaration) => {
        const docTokens = tokenize(declarationDoc(file, declaration));

        return {
            file,
            declaration,
            key: pairKey(declaration),
            tfName: counts(tokenize(declaration.qualifiedName)),
            tfDoc: counts(docTokens),
            tfSignature: counts(tokenize(declaration.signature)),
            length: docTokens.length,
        };
    });

    // A comment block competes on its prose alone: it has no identifier to weight three times, and inventing one from
    // its lead sentence would let a header outrank the function whose name answers the query.
    for (const comment of commentBlocksOf(file)) {
        const docTokens = tokenize(comment.text);

        entries.push({
            file,
            comment,
            key: `${file.path}\u0000comment\u0000${comment.startIndex}`,
            tfName: new Map(),
            tfDoc: counts(docTokens),
            tfSignature: new Map(),
            length: docTokens.length,
        });
    }

    entryCache.set(file, entries);

    return entries;
}

function isDefinition(entry: DocEntry): boolean {
    return entry.declaration?.isDefinition ?? false;
}

function ownerStartLine(entry: { declaration?: Declaration; comment?: CommentBlock }): number {
    return entry.declaration?.range.startLine ?? entry.comment?.startLine ?? 0;
}

/**
 * Keep one entry per header/definition pair.
 *
 * A C++ method carries a `[decl]` in the header and a `[def]` in the source; both would otherwise occupy a
 * row and split their term counts. The definition wins because it is what `show` returns.
 */
function preferredEntries(files: readonly ParsedFile[]): DocEntry[] {
    const byKey = new Map<string, DocEntry>();

    for (const file of files) {
        for (const entry of entriesFor(file)) {
            const current = byKey.get(entry.key);

            if (current === undefined || (isDefinition(entry) && !isDefinition(current))) {
                byKey.set(entry.key, entry);
            }
        }
    }

    return Array.from(byKey.values());
}

/**
 * Rank declarations by lexical relevance to `query`.
 *
 * BM25 over a weighted term frequency: identifiers 3x, doc comment and signature 1x. Length normalization uses
 * the doc-comment length only, because the identifier and signature are structural rather than prose and would
 * otherwise make a long signature look like a long document.
 */
export function rankBm25(files: readonly ParsedFile[], query: string, limit: number): Bm25Hit[] {
    const entries = preferredEntries(files);
    const queryTerms = Array.from(new Set(tokenize(query)));

    if (entries.length === 0 || queryTerms.length === 0) {
        return [];
    }

    const df = new Map<string, number>();

    for (const entry of entries) {
        for (const term of queryTerms) {
            const present =
                entry.tfName.has(term) || entry.tfDoc.has(term) || entry.tfSignature.has(term);

            if (present) {
                df.set(term, (df.get(term) ?? 0) + 1);
            }
        }
    }

    const total = entries.length;
    const averageLength =
        entries.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, total);
    const idf = (term: string): number => {
        const frequency = df.get(term) ?? 0;

        return Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
    };

    const hits: Bm25Hit[] = [];

    for (const entry of entries) {
        let score = 0;

        for (const term of queryTerms) {
            const weight =
                NAME_WEIGHT * (entry.tfName.get(term) ?? 0) +
                (entry.tfDoc.get(term) ?? 0) +
                (entry.tfSignature.get(term) ?? 0);

            if (weight === 0) {
                continue;
            }

            const normalization = 1 - B + (B * entry.length) / Math.max(1, averageLength);

            score += idf(term) * ((weight * (K1 + 1)) / (weight + K1 * normalization));
        }

        if (score > 0) {
            hits.push({
                file: entry.file,
                declaration: entry.declaration,
                comment: entry.comment,
                score,
            });
        }
    }

    return hits
        .toSorted(
            (left, right) =>
                right.score - left.score ||
                left.file.path.localeCompare(right.file.path) ||
                ownerStartLine(left) - ownerStartLine(right) ||
                (left.declaration?.qualifiedName ?? "").localeCompare(
                    right.declaration?.qualifiedName ?? "",
                ),
        )
        .slice(0, limit);
}
