import type { CodeChunk } from "./chunks";
import type { Declaration, ParsedFile } from "../types";

/** Below this many name/doc matches, a lexical-led answer may still want a related tail. */
export const TAIL_MIN_LITERAL = 3;

/**
 * Whether the related channel is worth its cost when a *strong* lexical hit already leads.
 *
 * Only for the lexical-led case: a name or phrase match is an answer, so related rows may at most decorate it, and
 * only when the literal pass found little (`TAIL_MIN_LITERAL`) and no prose matched every content word.
 */
export function wantsTail(literalCount: number, docMatches: number): boolean {
    return literalCount < TAIL_MIN_LITERAL && docMatches === 0;
}

/**
 * Whether this query should be answered by similarity first, with the lexical rows after it.
 *
 * A strong lexical hit — a name match (exact, prefix, substring) or the query's own words found adjacent in prose
 * (the doc-phrase and frontmatter-phrase tiers) — is precise evidence, and it stays first no matter what the embedding
 * says. Everything weaker is a guess: a plain doc tier matches every content word *somewhere*, which is not the same
 * as answering the question, and on 18 prose queries over `docs/` the lexical pass put the right section first 11% of
 * the time where similarity ranking did it 61% (MRR 0.212 against 0.706). So for those queries the related rows lead
 * and the lexical ones follow.
 *
 * This costs one query embedding per search with no strong lexical hit — measured 51–69 ms warm on the native runtime
 * — which is why the dense channel is no longer only a tail.
 */
export function leadsWithRelated(strongMatch: boolean): boolean {
    return !strongMatch;
}

/** Rows the related channel may add, which is also the page it leads with. */
export const TAIL_ROWS = 8;

/** Reciprocal-rank-fusion constant; 60 is the value the retrieval literature settles on. */
export const RRF_K = 60;

export interface RankedDeclaration {
    file: ParsedFile;
    declaration: Declaration;
    /** Set when a body chunk, not the declaration's head vector, produced the winning score. */
    chunk?: CodeChunk;
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
