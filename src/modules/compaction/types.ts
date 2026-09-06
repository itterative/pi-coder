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
export type ContextMessage = CompactionPreparation["messagesToSummarize"][number];

/** The span pi is about to discard: the complete turns plus a split-turn prefix, if any. */
export function summarizedSpan(preparation: CompactionPreparation): ContextMessage[] {
    return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}
