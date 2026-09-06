import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { contextIsStale, promptAndTotalTokens } from "./native-request";

/**
 * Choosing where the span ends, instead of accepting wherever pi ended it.
 *
 * Core honors whatever `firstKeptEntryId` this module returns (`agent-session.js:1412-1418`), so the cut is ours
 * to make. It should be, because the constraint that matters here exists only on our side: pi summarizes a
 * serialized text blob it sizes itself, so it has no notion of whether a *re-read of the context* fits a window,
 * and it picks the boundary by accumulating chars/4 estimates against `keepRecentTokens`. Stage 1 re-sends the
 * real messages, so its request is the one that can fail to fit - and today the only answer to "does not fit" is
 * `skipped`, which spends the whole session's history on the capped serialized rung instead.
 *
 * So this is a repair path, not a competing policy. pi's cut is used whenever it is admissible and fits. Only
 * when it does not do we walk **earlier** - smaller span, larger retained tail - which is the one direction that
 * is safe to take from underneath core's preparation: the tail grows, so the keep budget holds by construction,
 * and core's `messagesToSummarize` stays a superset of everything actually dropped, so the file ledger and the
 * split-turn wording cannot under-report anything. A later cut would be the opposite: it would summarize
 * material core never told us about, and would need its own summarized set. Not implemented, on purpose.
 *
 * A candidate also has to be *measurable*: this walk only ever picks a position whose span size is a provider
 * count, never a guess. That is what makes the whole thing decidable in one pass and what keeps the fit gate from
 * being a coin flip dressed as a threshold.
 */

/** Why a position was not chosen. One row per condition, so a rejected session explains itself. */
export type CutRejection =
    | "unmeasurable-live-context"
    | "not-a-countable-boundary"
    | "count-expired-at-fold-or-shape-change"
    | "orphaned-tool-call"
    | "tail-under-keep-budget"
    | "span-does-not-fit";

export interface CutDecision {
    /** Where stage 1 cuts and what core persists. Equal to pi's choice unless `movedEarlier`. */
    firstKeptEntryId: string;
    /** False when we kept core's boundary - the normal case, and the one worth being able to prove later. */
    movedEarlier: boolean;
    /** Rows moved back from pi's choice, newest first, so `movedEarlier` has a magnitude attached. */
    movedRows: number;
    /** Why we moved, or the tally of what stopped us from being able to. */
    reason: string; /** Retained history at the chosen boundary, in tokens: what `keepRecentTokens` is about. */
    tailTokens: number | null;
    /** The size of the span we chose, which is always a count, never an estimate. */
    spanTokens: number | null;
    rejections: Partial<Record<CutRejection, number>>;
}

export interface CutInput {
    /** The branch in pi's own order, as it stands before this compaction is appended. */
    branch: SessionEntry[];
    /** Core's choice: the ceiling this walk is not allowed to rise above. */
    proposedFirstKeptEntryId: string;
    /** Newest fold or shape change, from `countBoundary`: counts at or before it are expired. */
    boundary: number;
    /** `ctx.getContextUsage().tokens`, which is `null` right after a fold - the reason the floor can be unknown. */
    liveTokens: number | null;
    keepRecentTokens: number;
    contextWindow: number;
    /** Stage 1's output budget: what has to fit alongside the re-sent context. */
    outputBudgetTokens: number;
    /** chars/4 of the instruction stage 1 appends, which no provider ever counted. */
    instructionTokens: number;
}

/** Either a measured span, or the reason this boundary cannot be measured. */
export type SpanMeasure =
    { ok: true; tokens: number } | { ok: false; why: "not-countable" | "count-expired" };

/**
 * A boundary's span size, measured by the provider rather than estimated.
 *
 * Two positions give one: a reply at the cut, whose request had exactly this body as its prompt; and a user turn
 * at the cut whose preceding reply is the span's last message row, so that reply's `totalTokens` already reaches
 * the end of the body. Anything else would need a tail estimate, and a cut we are *choosing* is not the place to
 * start guessing. A count that exists but predates a fold or a shape change is reported as expired rather than
 * absent - they are different facts, and only one of them says the session was ever measured.
 */
export function measureSpanAt(
    branch: SessionEntry[],
    cutIndex: number,
    boundary: number,
    instructionTokens: number,
): SpanMeasure {
    const kept = branch[cutIndex];
    if (kept === undefined) {
        return { ok: false, why: "not-countable" };
    }

    const { prompt } = promptAndTotalTokens(kept);
    if (prompt !== null) {
        return contextIsStale(kept, boundary)
            ? { ok: false, why: "count-expired" }
            : { ok: true, tokens: prompt + instructionTokens };
    }

    // The whole-turn case: walk back over the rows that produce no message, and the reply below the cut has to
    // be the span's last content - if any message row sits between it and the cut, the number stops being a
    // count of the body and becomes an anchored guess.
    for (let index = cutIndex - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type !== "message") {
            continue;
        }
        if (entry.message.role !== "assistant") {
            return { ok: false, why: "not-countable" };
        }
        const through = promptAndTotalTokens(entry).total;
        if (through === null) {
            return { ok: false, why: "not-countable" };
        }

        return contextIsStale(entry, boundary)
            ? { ok: false, why: "count-expired" }
            : { ok: true, tokens: through + instructionTokens };
    }

    return { ok: false, why: "not-countable" };
}

/**
 * Every tool result below `cutIndex` whose call is above it, computed for all positions in one pass.
 *
 * The naive test - "is the first kept row a `toolResult`?" - is a proxy, and it is wrong in both directions: a
 * call's result can land after a user row when the tool outlives the interruption, which leaves an orphaned id
 * two rows into the tail with a perfectly legal first kept row, and pi's own backwards scan over metadata entries
 * can hand us a cut at a row that produces no message at all. Orphaned ids are the failure a provider refuses
 * outright, so the check resolves ids and nothing else.
 */
function orphanedByPosition(branch: SessionEntry[]): boolean[] {
    const callIndex = new Map<string, number>();
    for (const [index, entry] of branch.entries()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }
        for (const block of entry.message.content) {
            if (block.type === "toolCall") {
                callIndex.set(block.id, index);
            }
        }
    }

    const orphaned = new Array<boolean>(branch.length).fill(false);
    let earliestCallSeen = Number.POSITIVE_INFINITY;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type === "message" && entry.message.role === "toolResult") {
            const made = callIndex.get(entry.message.toolCallId);
            // A result whose call is missing entirely is orphaned from every position, like one above any cut.
            earliestCallSeen = Math.min(earliestCallSeen, made ?? -1);
        }
        orphaned[index] = earliestCallSeen < index;
    }

    return orphaned;
}

/**
 * The cut stage 1 should use: pi's own choice when it is admissible and fits, otherwise the latest earlier
 * boundary that is.
 *
 * Both remaining conditions are monotone as the cut moves earlier - the tail only grows and the span only
 * shrinks - so the first position that satisfies them is the latest one that fits, which is also the one that
 * reclaims the most. That monotonicity is the whole reason this is a walk rather than a search, and the property
 * `cut-invariants.test.ts` pins.
 */
export function chooseSpanCut(input: CutInput): CutDecision {
    const { branch, proposedFirstKeptEntryId } = input;
    const piIndex = branch.findIndex((entry) => entry.id === proposedFirstKeptEntryId);
    if (piIndex < 0) {
        return {
            firstKeptEntryId: proposedFirstKeptEntryId,
            movedEarlier: false,
            movedRows: 0,
            // Nothing to repair against: the id named no row, which `cutFound` already reports as its own
            // failure. Moving to a position we invented would replace a visible defect with an invisible one.
            reason: "unresolvable cut point",
            tailTokens: null,
            spanTokens: null,
            rejections: {},
        };
    }

    const orphaned = orphanedByPosition(branch);
    const rejections: Partial<Record<CutRejection, number>> = {};
    const reject = (why: CutRejection) => {
        rejections[why] = (rejections[why] ?? 0) + 1;
    };

    for (let index = piIndex; index >= 0; index -= 1) {
        if (input.liveTokens === null) {
            // The keep budget cannot be evaluated without a live size, and a boundary chosen while blind is how
            // a repair becomes a regression. `getContextUsage()` is null exactly here: right after a fold.
            reject("unmeasurable-live-context");
            break;
        }

        const measure = measureSpanAt(branch, index, input.boundary, input.instructionTokens);
        if (!measure.ok) {
            // Two different absences, kept apart because only one of them says the session was ever measured:
            // a boundary with no count at all, and a boundary whose count a fold or a model change expired.
            reject(
                measure.why === "count-expired"
                    ? "count-expired-at-fold-or-shape-change"
                    : "not-a-countable-boundary",
            );
            continue;
        }
        const span = measure.tokens;

        const kept = branch[index];
        if (orphaned[index]) {
            reject("orphaned-tool-call");
            continue;
        }

        const tail = input.liveTokens - span;
        if (tail < input.keepRecentTokens) {
            reject("tail-under-keep-budget");
            continue;
        }

        if (span + input.outputBudgetTokens >= input.contextWindow) {
            reject("span-does-not-fit");
            continue;
        }

        return {
            firstKeptEntryId: kept.id,
            movedEarlier: index !== piIndex,
            movedRows: piIndex - index,
            reason:
                index === piIndex
                    ? "proposed cut fits"
                    : `proposed cut did not fit; moved back ${String(piIndex - index)} rows`,
            tailTokens: tail,
            spanTokens: span,
            rejections,
        };
    }

    return {
        firstKeptEntryId: proposedFirstKeptEntryId,
        movedEarlier: false,
        movedRows: 0,
        reason: `no earlier boundary admissible (${describe(rejections)})`,
        tailTokens: null,
        spanTokens: null,
        rejections,
    };
}

function describe(rejections: Partial<Record<CutRejection, number>>): string {
    const parts = Object.entries(rejections).map(([why, count]) => `${String(count)}${why}`);
    if (parts.length === 0) {
        return "nothing considered";
    }

    return parts.join(",");
}
