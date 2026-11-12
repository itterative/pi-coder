import type { ParsedFile } from "../types";
import type { RankedDeclaration } from "./rank";

/** One relevance request over the declarations a search already parsed. */
export interface SemanticQuery {
    query: string;
    /** The resolved root the agent searched, used for the index namespace. */
    root: string;
    /** `local` or `container`: the two filesystem views must not share an index. */
    sourceKind: string;
    files: readonly ParsedFile[];
    /** Set when discovery stopped at the file cap, so `files` is not the whole root. */
    truncated?: boolean;
    /**
     * Rank by similarity alone instead of fusing the lexical channel in.
     *
     * Set for a prose query, where the lexical ranks are guesses that dilute a good similarity ranking: measured on
     * 18 prose queries over `docs/`, similarity ranked the right section first 61% of the time and the fused ranking
     * 33% (MRR 0.706 against 0.471). A query with a name-tier hit never asks for this.
     */
    similarityOnly?: boolean;
}

/**
 * The related channel: relevance ranking for a query that is prose rather than a name.
 *
 * Implemented behind this seam so `runSearch` never knows whether the ranking came from BM25 alone or from a fused
 * embedding channel, and so tests can inject a deterministic stand-in.
 */
export interface SemanticSearch {
    /** Offered in the footer while the embedding channel is not enabled yet. */
    readonly hint?: string;
    rank(request: SemanticQuery, signal?: AbortSignal): Promise<RankedDeclaration[]>;
    /** Kill the warm embedding child. Long-lived sessions do not need it; scripts and tests do. */
    dispose(): void;
}
