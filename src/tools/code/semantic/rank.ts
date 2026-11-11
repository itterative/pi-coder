import type { Declaration, ParsedFile } from "../types";

/** Below this many name/doc matches, the relevance tail may be worth rendering. */
export const TAIL_MIN_LITERAL = 3;

/**
 * Whether the relevance tail is worth its cost for this result.
 *
 * Two conditions, both about evidence rather than count. Fewer than `TAIL_MIN_LITERAL` matches means the literal
 * pass found little; a doc-text match *at all* means it found prose that mentions every content word of the query,
 * which is the strongest cheap signal there is. Each row the tail adds costs a query embedding (measured 0.6–3 s,
 * dominated by the model), so it must not be spent to decorate an answer that is already there.
 */
export function wantsTail(literalCount: number, docMatches: number): boolean {
    return literalCount < TAIL_MIN_LITERAL && docMatches === 0;
}

/** Rows the tail may add, kept small so a good literal answer is not buried. */
export const TAIL_ROWS = 8;

/** Reciprocal-rank-fusion constant; 60 is the value the retrieval literature settles on. */
export const RRF_K = 60;

export interface RankedDeclaration {
    file: ParsedFile;
    declaration: Declaration;
}

/** Stable identity for a declaration across rankings: its file and byte start. */
export function declarationKey(file: ParsedFile, declaration: Declaration): string {
    return `${file.path}\u0000${declaration.range.startIndex}`;
}

/**
 * Fuse ranked lists with reciprocal rank fusion.
 *
 * RRF combines channels without comparing their scores, which matters here because BM25 scores and cosine
 * similarities are not on the same scale. Interleaving is the point: concatenating one list after the other
 * measured worse (R@3 0.77 vs 0.91 on the evaluation corpus).
 */
export function fuseRankings(
    lists: readonly (readonly RankedDeclaration[])[],
    k = RRF_K,
): RankedDeclaration[] {
    const scores = new Map<string, { entry: RankedDeclaration; score: number }>();

    for (const list of lists) {
        for (const [index, entry] of list.entries()) {
            const key = declarationKey(entry.file, entry.declaration);
            const current = scores.get(key) ?? { entry, score: 0 };

            current.score += 1 / (k + index + 1);
            scores.set(key, current);
        }
    }

    return Array.from(scores.values())
        .toSorted(
            (left, right) =>
                right.score - left.score ||
                declarationKey(left.entry.file, left.entry.declaration).localeCompare(
                    declarationKey(right.entry.file, right.entry.declaration),
                ),
        )
        .map((scored) => scored.entry);
}
