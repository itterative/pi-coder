import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

/**
 * The session's configured thinking level, as pi's own getter types it.
 *
 * `ThinkingLevel` lives in `@earendil-works/pi-agent-core`, which we do not name in `src/` for the reason
 * written below, and pi-ai's entry point does not re-export it either. Deriving it from the getter keeps pi
 * authoritative: a pi-side change to the level set fails here instead of drifting from a hand-copied union.
 */
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/**
 * pi's compaction preparation, derived from the event type rather than imported.
 *
 * `CompactionPreparation`, `AgentMessage`, and the message union live in
 * `@earendil-works/pi-agent-core`, which is a nested dependency of `@earendil-works/pi-coding-agent` and
 * not one of ours: naming it in `src/` would be an undeclared import that only happens to resolve. Going
 * through the exported event type keeps pi authoritative, so a pi-side rename fails here instead of
 * leaving a hand-copied local union behind.
 */
export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

/** What triggered this compaction: `/compact`, the context threshold, or overflow recovery. */
export type SummarizationReason = SessionBeforeCompactEvent["reason"];

/**
 * One context message, including the roles pi keeps out of LLM requests (`bashExecution`, `custom`,
 * `compactionSummary`, `branchSummary`) as well as the plain `user`/`assistant`/`toolResult` trio.
 */
/**
 * Where a request-size number came from, which is how far it can be trusted, best evidence first:
 *
 * - `exact-cut` - the provider's own count of the request whose body *was* this span (the reply sitting at the
 *   cut point), so nothing about this request is estimated at all.
 * - `exact-anchor` - the newest count *inside* the span, with nothing after it left to charge: the whole-turn cut
 *   `[assistant] | [user]`, where the span ends on the counted reply itself.
 * - `usage-anchor` - the same count, plus chars/4 for whatever followed it.
 * - `chars4` - the heuristic over the whole body: the only number available right after a fold, before any
 *   post-fold reply exists.
 *
 * "Exact" in the first two means exact *for the stored body*: the instruction stage 1 appends is always its own
 * chars/4 estimate, because no provider ever counted it, and that is what the 5% band covers rather than 0%.
 *
 * These have measurably different error rates, so a reader has to know which number they are being shown.
 */
export type EstimateSource = "exact-cut" | "exact-anchor" | "usage-anchor" | "chars4";

export type ContextMessage = CompactionPreparation["messagesToSummarize"][number];

/** The span pi is about to discard: the complete turns plus a split-turn prefix, if any. */
export function summarizedSpan(preparation: CompactionPreparation): ContextMessage[] {
    return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}
