import type { CommentBlock } from "../comment-blocks";
import type { CodeChunk } from "./chunks";
import type { Declaration, ParsedFile } from "../types";

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
 * This costs one query embedding per search — measured 51–69 ms warm on the native runtime. The tail itself is no
 * longer gated on how little the literal pass found: that embedding has already been paid for, and the literal pass
 * cannot see what it missed. So the channel runs on every search, and this function only decides where its rows go.
 */
export function leadsWithRelated(strongMatch: boolean): boolean {
    return !strongMatch;
}

/** Rows the related channel may add, which is also the page it leads with. */
export const TAIL_ROWS = 8;

/**
 * Share of a channel's best score a row must reach to stay in the related list.
 *
 * A sorted list has no floor of its own: the tail used to print positions 1-8 whatever the 8th score was, so a query
 * with one real answer still carried seven rows that shared only a token. 0.65 was calibrated on this repo's `src`
 * (BM25): a query whose answer is one identifier drops from ~0.98 of its top score to ~0.5-0.6 for the rows that
 * share just one of its tokens, while a flat, genuinely related query keeps every row above ~0.9. The measured
 * distributions are recorded in the `outline-tool/search.md` memory rather than here, because a doc comment is
 * searchable and naming those queries would put this constant in their search results.
 *
 * It is a ratio, not an absolute cut, because each channel's scale is its own: BM25 scores move with the corpus and
 * the query length, cosine with the model. Rows are compared only inside the list that produced them.
 */
export const RELATED_FLOOR_RATIO = 0.65;

/** Cosine a dense row needs to enter the related tail. */
export const DENSE_FLOOR = 0.5;

/**
 * A ranked row carrying the score that placed it.
 *
 * Internal to the tail: the floor is applied where the scores exist, and the score itself never reaches a row's
 * renderer, so `RankedDeclaration` stays the identity a caller passes around.
 */
export interface ScoredDeclaration extends RankedDeclaration {
    score: number;
}

/**
 * Drop the rows that trail their channel's best score by more than `RELATED_FLOOR_RATIO`, or below an absolute
 * floor the channel's profile supplies.
 *
 * The list must already be sorted best-first, which both channels produce. A channel with no positive score keeps
 * nothing: an all-zero list is not a ranking. `absoluteFloor` is for a channel whose scale is calibrated — the dense
 * channel passes `DENSE_FLOOR`; BM25 has no comparable calibration and passes none.
 */
export function aboveFloor<T extends { score: number }>(
    ranked: readonly T[],
    absoluteFloor = 0,
): T[] {
    const top = ranked[0]?.score ?? 0;

    if (top <= 0) {
        return [];
    }

    const floor = Math.max(top * RELATED_FLOOR_RATIO, absoluteFloor);

    return ranked.filter((entry) => entry.score >= floor);
}

/** Reciprocal-rank-fusion constant; 60 is the value the retrieval literature settles on. */
export const RRF_K = 60;

export interface RankedDeclaration {
    file: ParsedFile;
    /** Absent only when `comment` names the owner: a comment block no declaration owns. */
    declaration?: Declaration;
    /**
     * Set when the score came from a comment block no declaration owns rather than from the declaration's head.
     *
     * The row then names the block, not the declaration: `declaration` still says what the file's entry point is, so
     * a caller that prints one column can fall back to it.
     */
    comment?: CommentBlock;
    /** Set when a body chunk, not the declaration's head vector, produced the winning score. */
    chunk?: CodeChunk;
}

/** Stable identity for a declaration across rankings: its file and byte start. */
export function declarationKey(file: ParsedFile, declaration: Declaration): string {
    return `${file.path}\u0000${declaration.range.startIndex}`;
}

/** Stable identity for a ranked owner, whether it is a declaration or a comment block. */
export function rankKeyOf(owner: {
    file: ParsedFile;
    declaration?: Declaration;
    comment?: CommentBlock;
}): string {
    if (owner.declaration !== undefined) {
        return declarationKey(owner.file, owner.declaration);
    }

    return `${owner.file.path}\u0000comment\u0000${owner.comment?.startIndex ?? 0}`;
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
            const key = rankKeyOf(entry);
            const current = scores.get(key) ?? { entry, score: 0 };

            current.score += 1 / (k + index + 1);
            scores.set(key, current);
        }
    }

    return Array.from(scores.values())
        .toSorted(
            (left, right) =>
                right.score - left.score ||
                rankKeyOf(left.entry).localeCompare(rankKeyOf(right.entry)),
        )
        .map((scored) => scored.entry);
}
