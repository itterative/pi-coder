import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { SizedSpan, SpanSizer } from "./ledger";
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
 * A candidate has to be *measurable*, and since C2 that means measured rather than counted: a provider's own
 * count of the body if one exists at the boundary, and otherwise the session's arithmetic over the counts that
 * bracket its rows - which is what opens the window below a fold, where every stored count has expired and the
 * old rule refused the position outright. Neither route guesses at a span, and that distinction is what keeps
 * the whole thing decidable in one pass and keeps the fit gate from being a coin flip dressed as a threshold.
 */

/** Why a position was not chosen. One row per condition, so a rejected session explains itself. */
export type CutRejection =
    | "unmeasurable-live-context"
    | "not-a-countable-boundary"
    | "count-expired-at-fold-or-shape-change"
    | "outside-span-window"
    | "ledger-too-estimated"
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
    reason: string;
    /**
     * The condition that refused core's own boundary, or null when nothing did. Non-null exactly when
     * `movedEarlier`, and the only field that says *why* a run summarized a different row set from the one pi
     * chose: the two boundary ids cannot separate "core's cut was unmeasurable" from "core's cut retained less
     * than the user asked for", and those two have opposite answers.
     */
    proposedRejection: CutRejection | null;
    /** Retained history at the chosen boundary, in tokens: what `keepRecentTokens` is about. */
    tailTokens: number | null;
    /** The size of the span we chose: a provider's count of that body, or the session's arithmetic over two. */
    spanTokens: number | null;
    /** Which route answered for the chosen span. Absent when nothing was chosen, never a zero. */
    spanBasis: MeasureBasis | null;
    /** Echo of the input: which instrument sized the whole live context this tail came out of. */
    liveTokensSource?: "ledger" | "context-usage";
    rejections: Partial<Record<CutRejection, number>>;
}

export interface CutInput {
    /** The branch in pi's own order, as it stands before this compaction is appended. */
    branch: SessionEntry[];
    /** Core's choice: the ceiling this walk is not allowed to rise above. */
    proposedFirstKeptEntryId: string;
    /** Newest fold or shape change, from `countBoundary`: counts at or before it are expired. */
    boundary: number;
    /**
     * The whole live context, from `liveContextSize`: the ledger's head-plus-rows when it can solve one, and
     * `ctx.getContextUsage().tokens` otherwise. Null only when neither can, which is what leaves the keep budget
     * unevaluable - and why the walk refuses to move rather than choose a boundary it cannot check.
     */
    liveTokens: number | null;
    keepRecentTokens: number;
    contextWindow: number;
    /** Stage 1's output budget: what has to fit alongside the re-sent context. */
    outputBudgetTokens: number;
    /** chars/4 of the instruction stage 1 appends, which no provider ever counted. */
    instructionTokens: number;
    /**
     * Every candidate's span sized from the session's own counts, when that derivation is available. Absent (or
     * null) leaves the walk with the rule it had before C2: a position with no provider count at the boundary,
     * or whose count a fold expired, is simply not repairable.
     */
    sizer?: SpanSizer | null;
    /**
     * Which measurement `liveTokens` came from, so a tail taken against a ledger live can be told from one where
     * both sides are provider numbers. Recorded on the decision because the trace reads the decision, and "the
     * two sides of this subtraction came from different instruments" is a fact about the choice, not the input.
     */
    liveTokensSource?: "ledger" | "context-usage";
}

/** Either a measured span, or the reason this boundary cannot be measured. */
export type SpanMeasure =
    { ok: true; tokens: number; basis: MeasureBasis } | { ok: false; why: MeasureFailure };

/** What answered for a span: a provider's own count of that body, or a difference of two of them. */
export type MeasureBasis = "count" | "ledger";

/**
 * Why a position cannot be sized, from whichever route was asked last.
 *
 * Four reasons, two per route, and the pairs say different things: `not-countable` and `count-expired` are about
 * the row sitting at the cut, while `outside-window` and `too-estimated` are about the span the ledger would have
 * to answer for.
 */
type MeasureFailure = "not-countable" | "count-expired" | "outside-window" | "too-estimated";

/**
 * A boundary's span size: what a provider counted for that very body if it can, the session's arithmetic over two
 * such counts if it cannot.
 *
 * The count route answers at two positions: a reply at the cut, whose request had exactly this body as its prompt;
 * and a user turn at the cut whose preceding reply is the span's last message row, so that reply's `totalTokens`
 * already reaches the end of the body. Anything else needed a tail estimate, and a cut we are *choosing* is not
 * the place to start guessing - which is what the ledger route is for: it is arithmetic over counts rather than a
 * guess at one, and it makes a position below a fold, or one whose row carries no usage at all, admissible
 * instead of invisible.
 *
 * The window is checked before either route, for both. Until C2 the expiry rule was doing that job by accident:
 * a count under the newest fold is expired, so no count-bearing position existed below the window start, and a
 * route that can size those positions has to be told where the span stops being buildable. `stageOneSpanEntries`
 * begins its window at the newest fold's `firstKeptEntryId` for exactly this reason - a cut below it is not a
 * smaller span, it is a body nobody can assemble.
 *
 * A count that exists but predates a fold or a shape change is reported as expired rather than absent: they are
 * different facts, and only one of them says the session was ever measured.
 */
export function measureSpanAt(
    branch: SessionEntry[],
    cutIndex: number,
    boundary: number,
    instructionTokens: number,
    sizer?: SpanSizer | null,
): SpanMeasure {
    // The window, checked here and again inside `SpanSizer.spanAt`. Deliberate, and the redundancy is the point of
    // this comment: the sizer owns where its own window begins, so deleting this line changes no behavior (a
    // mutation of it survives the whole suite, which is how it was found). What it buys is the *reason* at the
    // decision site - `outside-window` named before any array index is read, instead of a refusal that arrives from
    // inside the derivation. The authority is `spanAt`; this is the label.
    if (sizer !== undefined && sizer !== null && cutIndex < sizer.windowStartIndex) {
        return { ok: false, why: "outside-window" };
    }

    const counted = measureSpanByCount(branch, cutIndex, boundary, instructionTokens);
    if (counted.ok) {
        return counted;
    }

    if (sizer === undefined || sizer === null) {
        return counted;
    }

    // The route's own refusal names, typed at the boundary between the two modules: `SpanSizer` owns where its
    // window begins, and its reasons arrive here unchanged.
    const sized: SizedSpan = sizer.spanAt(cutIndex);
    if (!sized.ok) {
        return { ok: false, why: sized.why };
    }

    // The instruction is charged the same way on both routes: it is text no provider has ever counted, and the
    // tail comparison inherits that bias deliberately, because moving the boundary is the conservative direction.
    return { ok: true, tokens: sized.body.tokens + instructionTokens, basis: "ledger" };
}

/** The count route on its own: a provider's number for this body, or the reason no such number exists. */
function measureSpanByCount(
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
            : { ok: true, tokens: prompt + instructionTokens, basis: "count" };
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
            : { ok: true, tokens: through + instructionTokens, basis: "count" };
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
            proposedRejection: null,
            tailTokens: null,
            spanTokens: null,
            spanBasis: null,
            liveTokensSource: input.liveTokensSource,
            rejections: {},
        };
    }

    const orphaned = orphanedByPosition(branch);
    const rejections: Partial<Record<CutRejection, number>> = {};
    let proposedRejection: CutRejection | null = null;
    const reject = (why: CutRejection, at: number) => {
        rejections[why] = (rejections[why] ?? 0) + 1;
        if (at === piIndex) {
            proposedRejection = why;
        }
    };

    for (let index = piIndex; index >= 0; index -= 1) {
        if (input.liveTokens === null) {
            // The keep budget cannot be evaluated without a live size, and a boundary chosen while blind is how
            // a repair becomes a regression. C2 narrows this to "neither route could size the context": the
            // ledger answers where `getContextUsage()` is null, which is right after a fold.
            reject("unmeasurable-live-context", index);
            break;
        }

        const measure = measureSpanAt(
            branch,
            index,
            input.boundary,
            input.instructionTokens,
            input.sizer,
        );
        if (!measure.ok) {
            reject(rejectionFor(measure.why), index);
            continue;
        }
        const span = measure.tokens;

        const kept = branch[index];
        if (orphaned[index]) {
            reject("orphaned-tool-call", index);
            continue;
        }

        const tail = input.liveTokens - span;
        if (tail < input.keepRecentTokens) {
            reject("tail-under-keep-budget", index);
            continue;
        }

        if (span + input.outputBudgetTokens >= input.contextWindow) {
            reject("span-does-not-fit", index);
            continue;
        }

        return {
            firstKeptEntryId: kept.id,
            movedEarlier: index !== piIndex,
            movedRows: piIndex - index,
            // The cause, named rather than assumed: three of the six conditions can send us here, and "did not
            // fit" was only ever true of the last of them - which is why every move in the trace before this
            // line was written could not be attributed.
            reason:
                index === piIndex
                    ? "proposed cut fits"
                    : `moved back ${String(piIndex - index)} rows: core's boundary was ${String(proposedRejection)}`,
            proposedRejection,
            tailTokens: tail,
            spanTokens: span,
            spanBasis: measure.basis,
            liveTokensSource: input.liveTokensSource,
            rejections,
        };
    }

    return {
        firstKeptEntryId: proposedFirstKeptEntryId,
        movedEarlier: false,
        movedRows: 0,
        reason: `no earlier boundary admissible (${describe(rejections)})`,
        proposedRejection,
        tailTokens: null,
        spanTokens: null,
        spanBasis: null,
        liveTokensSource: input.liveTokensSource,
        rejections,
    };
}

/**
 * Which measurement failure became which recorded rejection.
 *
 * Four names for four facts, kept apart because the remedies differ: `not-a-countable-boundary` says the row at
 * the cut carries no usage, `count-expired-at-fold-or-shape-change` says it carries one a later fold or model
 * change invalidated, `outside-span-window` says the span builder could not assemble a body ending there, and
 * `ledger-too-estimated` says the derivation refused to vouch for that much chars/4. The first two are about the
 * row; the last two are about the range.
 */
function rejectionFor(why: MeasureFailure): CutRejection {
    if (why === "count-expired") {
        return "count-expired-at-fold-or-shape-change";
    }
    if (why === "not-countable") {
        return "not-a-countable-boundary";
    }
    if (why === "outside-window") {
        return "outside-span-window";
    }

    return "ledger-too-estimated";
}

function describe(rejections: Partial<Record<CutRejection, number>>): string {
    const parts = Object.entries(rejections).map(([why, count]) => `${String(count)}${why}`);
    if (parts.length === 0) {
        return "nothing considered";
    }

    return parts.join(",");
}
