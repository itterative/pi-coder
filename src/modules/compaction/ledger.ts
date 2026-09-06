import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { changesCountBasis, contextIsStale } from "./native-request";
import { estimateEntryTokens, outputTokensOf, promptTokensOf } from "./usage";

/**
 * What a body costs, split into the part the session counts and the part nobody does.
 *
 * Every request pi sends is `[system prompt][tool definitions][checkpoint(s)][rows...]`, and the first three are
 * one quantity: a **head** that is in every body, that no row owns, and that the session never stores. Taken
 * separately both halves are estimates - the system prompt is chars/4 of `systemChars`, a checkpoint is chars/4 of
 * its summary or a stage's `usage.output` for text the persisted summary then grew sections onto - but together
 * they fall out of provider counts, because the first reply counted after a fold was charged for exactly
 * `head + rows`:
 *
 * ```
 * head = input(A) - t(fk .. A)        A = first counted reply after the fold, fk = its own firstKeptEntryId
 * ```
 *
 * and `t(fk .. A)` is itself mostly counted: two replies on the same basis bracket everything between them, so
 * `input(next) - input(prev)` is exact no matter what kinds of row sit there. What is left to chars/4 is the
 * stretch before the first counted row and after the last - rows, not context.
 *
 * That is why this module derives a head instead of persisting one, and why a row that changes the count basis - a
 * fold, a model change, a thinking-level change - *restarts* the chain: rows on either side of it were counted
 * against bodies with different heads or different tokenizers, so their difference is not a row count. Two things
 * the derivation cannot do, both refusals rather than approximations:
 *
 * - It needs a counted reply **after** the fold, so the window right after a fold - before anything has replied,
 *   which is when the fit gate decides whether stage 1 runs at all - is not reachable this way. That window is
 *   what a fold row's own persisted `countedBodyTokens`/`fixedPrefixTokens` answer (`native-request.ts`), and the
 *   two are complementary rather than competing: the ledger needs no persisted state and so also works for fold
 *   rows written by older builds.
 * - A head is a property of a request **shape**. The session records a `model_change` or a
 *   `thinking_level_change`, which is why `countBoundary` exists, but it does not record the system prompt's text
 *   moving - pi's own base-versus-override flip changes it by ~12k chars with no row at all. A derived head is
 *   only valid while the shape holds, and only the chain rows in the trace can say whether it did.
 */

/** Tokens of a run of entries, split by how each part was obtained. */
export interface MeasuredTokens {
    tokens: number;
    /** Differences of provider counts, plus the counted replies themselves: no estimate touched these. */
    counted: number;
    /** chars/4: rows no pair of counts bracketed. Includes `checkpoints`. */
    estimated: number;
    /**
     * Of `estimated`, what riding checkpoints cost. Called out because it is the one large estimate here and it is
     * legitimate - a fold row's summary is text now, and no count of *this* body describes it - while the rest of
     * `estimated` is a turn or two of rows.
     */
    checkpoints: number;
    /**
     * Rows the walk broke its chain at: folds, model changes, thinking-level changes - the types `countBoundary`
     * counts. Each is a change of basis, not a rounding, and the number says how much of `counted` is safe to
     * read as one quantity rather than a sum of pieces measured against different bodies.
     */
    restarts: number;
}

/** The head of a body: the system prompt and tool definitions, plus the checkpoint the newest fold put in. */
export interface BodyHead {
    tokens: number;
    /** How much of the range subtracted from a provider count was chars/4, which is the head's whole error. */
    estimatedTokens: number;
    /** Which reply the head was solved from, because the two routes have different error profiles. */
    source: "first-reply" | "after-fold";
    /**
     * The fold whose checkpoint the head carries, when `source` is `after-fold`. Pass it back as
     * `measureEntries`' `headFoldId` when sizing a body that contains that row, or the checkpoint is charged
     * twice - once in the head and once as a row. An older checkpoint that is still riding *is* a row, because
     * nothing else in the body accounts for it: pi hoists only the newest fold to the front and leaves an older
     * summary at its file position.
     */
    foldId?: string;
    /** Index of the reply it was solved from, so a caller can tell a stale head from a current one. */
    replyIndex: number;
}

/** A whole body: the head in force, the rows it carries, and anything appended that no reference ever sent. */
export interface MeasuredBody {
    tokens: number;
    /**
     * How much of `tokens` is chars/4 rather than counted, across the head, the rows and `extraTokens`.
     *
     * An upper bound rather than a decomposition: a head is solved by *subtracting* a measured range from a
     * provider count, so where that range and the window overlap, the same chars/4 error enters both terms with
     * opposite signs and cancels in `tokens`. Summing them is the conservative reading, and it is what the
     * refusal in `spanBodyTokens` compares against a share, so a body declines slightly early rather than late.
     */
    estimatedTokens: number;
    head: BodyHead;
    rows: MeasuredTokens;
    extraTokens: number;
}

export interface FoldNet {
    foldId: string;
    /** Index of the fold row in the branch it was derived from. */
    foldIndex: number;
    /**
     * What the fold did to the size of every later body: the checkpoint it put in, less the rows it took out,
     * less any older checkpoint that stopped riding along. Negative for any fold that compressed anything.
     *
     * Not literally `checkpoint - span`, because pi hoists only the *newest* fold and leaves an older summary at
     * its file position (`buildContextEntries`): a checkpoint inside the retained stretch is in both bodies and
     * cancels, while one the new cut leaves behind does not. Measured on a live capture, fold 2 of three kept
     * fold 1's 1,557-token checkpoint in the body and its net came out as exactly `K2 - t(removed)`.
     */
    net: number;
    /** How much of `net` is chars/4 rather than counted: the rows of one turn between two counted replies. */
    estimatedTokens: number;
}

function foldIndexes(branch: readonly SessionEntry[]): number[] {
    return branch.flatMap((entry, index) => (entry.type === "compaction" ? [index] : []));
}

/** The two counts a reply carries, or null when the row is not a reply a provider counted. */
function replyTokens(entry: SessionEntry | undefined): { prompt: number; output: number } | null {
    if (entry === undefined || entry.type !== "message" || entry.message.role !== "assistant") {
        return null;
    }

    const prompt = promptTokensOf(entry.message.usage, entry.message.stopReason);
    if (prompt === null) {
        return null;
    }

    const output = outputTokensOf(entry.message.usage, entry.message.stopReason);

    return { prompt, output: output ?? 0 };
}

/**
 * Tokens of a run of entries, counted wherever two replies bracket them.
 *
 * The range is half-open and charges every row in it, including a counted reply's own output: `input(next) -
 * input(prev)` already covers `prev`'s reply, so the walk only has to add the *last* counted reply's own tokens,
 * which it takes from `usage.output` rather than from chars/4. A row that changes the count basis restarts the
 * chain: a fold is charged as the text it now is, pi's `<summary>` wrapper included (`estimateEntryTokens` renders
 * it the way a provider sees it), while a model or thinking-level change produces no message at all and costs
 * nothing but the bracket it breaks.
 *
 * The restart set is `changesCountBasis`, the same predicate `countBoundary` is built from, because a difference
 * across a basis change is the identical error in both directions: the 2026-09-07 review of this module found
 * that only folds restarted it, so a model change sitting *inside* a range - with a head anchor above it, which
 * is why the head's own staleness guard stayed silent - was charged as `counted` arithmetic across two
 * tokenizers, and `MAX_LEDGER_ESTIMATED_SHARE` cannot see that shape because such a range is almost all counted.
 *
 * `headFoldId` names the one fold row whose checkpoint the caller is accounting for separately, as a head: the
 * walk still restarts at it - dropping the row instead would take a difference across the basis change it marks,
 * which measured 9,236 tokens of nonsense on the capture this was written against - but charges it nothing.
 *
 * `closing` is the entry just past the range, and it is the reason a window's trailing stretch is usually exact
 * rather than guessed. A cut lands on an assistant that consumed a tool result, so the rows in front of it are
 * uncounted; when the cut entry itself carries a count on the same basis, one difference covers them and the last
 * counted reply together. Its own reply is outside the range and is never charged. A basis-changing row between the two
 * leaves `last` unset, so the bracket is declined exactly when the bases differ - which is also what makes a
 * *stale* count usable here: staleness disqualifies a count as the size of a body, never as a difference against
 * another count taken on the same basis.
 */
export function measureEntries(
    entries: readonly SessionEntry[],
    options: { headFoldId?: string; closing?: SessionEntry } = {},
): MeasuredTokens {
    const walk = createMeasurementWalk({ headFoldId: options.headFoldId });
    for (const entry of entries) {
        walk.add(entry);
    }

    return walk.total(options.closing);
}

/**
 * The same walk, resumable: state in, prefix out.
 *
 * `measureEntries` answers one range, and a caller that wants every prefix of that range would otherwise rescan
 * it once per position. `spanSizer` is exactly that caller - the cut walk asks for a number at each candidate
 * boundary - so the arithmetic lives here once rather than in two places, which is the shape this module's blind
 * spots have historically come from.
 */
function createMeasurementWalk(options: { headFoldId?: string } = {}): {
    add: (entry: SessionEntry) => void;
    total: (closing?: SessionEntry) => MeasuredTokens;
} {
    let counted = 0;
    let estimated = 0;
    let checkpoints = 0;
    let restarts = 0;
    let pending: SessionEntry[] = [];
    let last: { prompt: number; output: number } | null = null;

    function pendingTokens(): number {
        return pending.length === 0 ? 0 : estimateEntryTokens(pending);
    }

    function add(entry: SessionEntry): void {
        if (changesCountBasis(entry)) {
            // Only a fold contributes text; a shape row is charged nothing and exists here to break the chain. The
            // head's own fold is the exception that pays nothing, because the caller already counted it as head.
            const charge =
                entry.type === "compaction" && entry.id !== options.headFoldId
                    ? estimateEntryTokens([entry])
                    : 0;
            // The reply counted before this row is inside the range, and a restart would otherwise drop it.
            if (last !== null) {
                counted += last.output;
            }

            estimated += pendingTokens() + charge;
            checkpoints += charge;
            pending = [];
            last = null;
            restarts += 1;
            return;
        }

        const reply = replyTokens(entry);
        if (reply === null) {
            pending.push(entry);
            return;
        }

        if (last === null) {
            estimated += pendingTokens();
        } else {
            // The whole difference belongs to the range: the previous reply plus every row behind it.
            counted += reply.prompt - last.prompt;
        }

        pending = [];
        last = reply;
    }

    function total(closing?: SessionEntry): MeasuredTokens {
        // Copies only: answering a prefix must not end the walk, and every term below is read from the running
        // state rather than written into it.
        let closedCounted = counted;
        let closedEstimated = estimated;
        const closingReply = replyTokens(closing);
        if (closingReply !== null && last !== null) {
            closedCounted += closingReply.prompt - last.prompt;
        } else {
            if (last !== null) {
                // The last counted reply sits inside the range, and its own tokens are a provider number.
                closedCounted += last.output;
            }
            closedEstimated += pendingTokens();
        }

        return {
            tokens: closedCounted + closedEstimated,
            counted: closedCounted,
            estimated: closedEstimated,
            checkpoints,
            restarts,
        };
    }

    return { add, total };
}

/** Index of the first entry at or after `from` whose reply a provider counted, or -1. */
function firstCountedFrom(branch: readonly SessionEntry[], from: number, to: number): number {
    for (let index = from; index < to; index += 1) {
        if (replyTokens(branch[index]) !== null) {
            return index;
        }
    }

    return -1;
}

/** Index of the last entry before `to` whose reply a provider counted, or -1. */
function lastCountedBefore(branch: readonly SessionEntry[], from: number, to: number): number {
    let found = -1;
    for (let index = from; index < to; index += 1) {
        if (replyTokens(branch[index]) !== null) {
            found = index;
        }
    }

    return found;
}

/**
 * The head of the body in force at `atIndex`, or null when the session cannot solve for it.
 *
 * Solved from the first reply a provider counted under that head, which is the first counted reply after the
 * newest fold before `atIndex` - or, with no fold yet, the session's first counted reply, whose body is the bare
 * prefix plus a row or two and which is therefore the well-conditioned measurement of `P` alone (96 tokens of
 * chars/4 on the capture this was written against, against a ~7.6k answer). That reply may sit *after* `atIndex`:
 * a head is a property of the shape epoch the fold opened, so a body built before the first reply was counted
 * still carries it, and this is how the head becomes known at all.
 *
 * Null means no counted reply exists under that head: the fold wrote the tip and nothing has run since, or a later
 * fold moved the head before any reply landed. Both are refusals, not zeros.
 */
export function headAt(branch: readonly SessionEntry[], atIndex: number): BodyHead | null {
    const folds = foldIndexes(branch).filter((index) => index < atIndex);
    const foldIndex = folds.at(-1);

    if (foldIndex === undefined) {
        return barePrefix(branch, atIndex);
    }

    return headAfterFold(branch, foldIndex);
}

/** `P` on its own: the head of a body no fold has touched yet. */
function barePrefix(branch: readonly SessionEntry[], atIndex: number): BodyHead | null {
    const replyIndex = firstCountedFrom(branch, 0, atIndex);
    const reply = replyTokens(branch[replyIndex]);
    if (reply === null) {
        return null;
    }

    const rows = measureEntries(branch.slice(0, replyIndex), {
        closing: branch[replyIndex],
    });

    return {
        tokens: reply.prompt - rows.tokens,
        estimatedTokens: rows.estimated,
        source: "first-reply",
        replyIndex,
    };
}

/**
 * The head a fold left behind: `P` plus the checkpoint it wrote.
 *
 * The fold's own row is not one of the rows measured here, because that row *is* the checkpoint being solved for:
 * pi hoists it to the front of every later context, so charging it as a row and subtracting it would leave the
 * head holding `P` alone and put the checkpoint in the wrong half of the split. It stays in the walk as a restart,
 * and an older fold's row inside the same stretch stays a row - it rides along at its file position - which is
 * what `MeasuredTokens.checkpoints` reports.
 *
 * The search for the reply stops at the next fold, because a reply counted after that was charged a different
 * head; a fold with no counted reply before the next one has no head this session can solve for.
 */
function headAfterFold(branch: readonly SessionEntry[], foldIndex: number): BodyHead | null {
    const fold = branch[foldIndex];
    if (fold === undefined || fold.type !== "compaction") {
        return null;
    }

    const keptFrom = branch.findIndex((entry) => entry.id === fold.firstKeptEntryId);
    if (keptFrom < 0 || keptFrom >= foldIndex) {
        return null;
    }

    const nextFold = foldIndexes(branch).find((index) => index > foldIndex);
    const replyIndex = firstCountedFrom(branch, foldIndex + 1, nextFold ?? branch.length);
    const reply = replyTokens(branch[replyIndex]);
    if (reply === null) {
        return null;
    }

    const rows = measureEntries(branch.slice(keptFrom, replyIndex), {
        headFoldId: fold.id,
        closing: branch[replyIndex],
    });

    return {
        tokens: reply.prompt - rows.tokens,
        estimatedTokens: rows.estimated,
        source: "after-fold",
        foldId: fold.id,
        replyIndex,
    };
}

/**
 * What one fold did to the body, or null when the session cannot bracket it.
 *
 * ```
 * input(A_first) = head_after  + t(fk .. A_first)      the first reply counted after the fold
 * input(B_last)  = head_before + t(fk .. B_last)       the last reply counted before it
 * t(fk .. A_first) = t(fk .. B_last) + gap(B_last .. A_first)
 * ----------------------------------------------------------------
 * net = head_after - head_before = input(A_first) - input(B_last) - gap
 * ```
 *
 * The gap is one turn: the earlier reply's own output, which is counted, plus the rows behind it - whatever the
 * user said next. It excludes every fold row on purpose, because a fold row is a head term and not a row: this
 * fold's checkpoint is the `K` the net exists to measure, and an older one that starts riding here belongs to the
 * head difference too. Everything about the head cancels, which is the point: a session never has to know how big
 * its own system prompt is to know what a fold did to it.
 *
 * Null is the honest answer whenever a cut is missing: no reply counted after the fold (the fold wrote the tip, or
 * a later fold moved the head first), no counted reply inside the retained stretch to bracket its start, or a fold
 * row that is not on this branch. Each case would leave a term to guess, and the caller then falls back to what it
 * had - a fold row's own persisted counts, or chars/4.
 */
export function foldNet(branch: readonly SessionEntry[], foldIndex: number): FoldNet | null {
    const fold = branch[foldIndex];
    if (fold === undefined || fold.type !== "compaction") {
        return null;
    }

    const keptFrom = branch.findIndex((entry) => entry.id === fold.firstKeptEntryId);
    if (keptFrom < 0 || keptFrom >= foldIndex) {
        return null;
    }

    // A later fold row ends the body this reply was counted against, so the search stops at it.
    const folds = foldIndexes(branch);
    const nextFold = folds.find((index) => index > foldIndex);
    const limit = nextFold ?? branch.length;

    // The reply bracketing the fold's start must sit under the head this fold changed, which means after the
    // previous fold's row. A reply counted before that was charged a body the earlier fold has since rewritten,
    // and bracketing with it would fold that fold's net into this one - twice over, once `foldNets` sums them.
    // Refusing is the alternative, and it is the honest one: the caller keeps the fallback it had.
    const previousFold = folds.findLast((index) => index < foldIndex);
    const bracketFrom = Math.max(keptFrom, (previousFold ?? -1) + 1);

    const before = lastCountedBefore(branch, bracketFrom, foldIndex);
    if (before < 0) {
        return null;
    }

    const after = firstCountedFrom(branch, foldIndex + 1, limit);
    if (after < 0) {
        return null;
    }

    const from = replyTokens(branch[before]);
    const to = replyTokens(branch[after]);
    if (from === null || to === null) {
        return null;
    }

    // The gap is what the body gained between the two replies, and it excludes every fold row on purpose: this
    // fold's own checkpoint is the head term the net exists to measure, and an older one riding along is in both
    // bodies. Charging either would count a head as a row, and the error is the size of a summary.
    const gap = measureEntries(
        branch.slice(before + 1, after).filter((entry) => entry.type !== "compaction"),
    );

    return {
        foldId: fold.id,
        foldIndex,
        net: to.prompt - from.prompt - from.output - gap.tokens,
        estimatedTokens: gap.estimated,
    };
}

/** Every fold the branch can account for, oldest first. */
export function foldNets(branch: readonly SessionEntry[]): FoldNet[] {
    return foldIndexes(branch)
        .flatMap((index) => {
            const net = foldNet(branch, index);

            return net === null ? [] : [net];
        })
        .toSorted((left, right) => left.foldIndex - right.foldIndex);
}

/**
 * A whole body, sized from the head in force plus the rows it carries.
 *
 * `atIndex` picks the head and `[from, to)` picks the rows, and they are separate parameters on purpose: a stage-1
 * span ends at a cut that can sit *below* the fold whose checkpoint it carries, so the head in force is the one at
 * the time of the request, not the one implied by the range. The head's own fold row is charged once, in the head
 * (see `BodyHead.foldId`). `extraTokens` is whatever the caller appends that no reference ever sent, stage 1's
 * instruction, and is charged as the estimate it is.
 */
export function bodyTokens(
    branch: readonly SessionEntry[],
    input: { atIndex: number; from: number; to: number; extraTokens?: number },
): MeasuredBody | null {
    const head = headAt(branch, input.atIndex);
    if (head === null) {
        return null;
    }

    const extraTokens = input.extraTokens ?? 0;
    const rows = measureEntries(branch.slice(input.from, input.to), {
        headFoldId: head.foldId,
        closing: branch[input.to],
    });

    return {
        tokens: head.tokens + rows.tokens + extraTokens,
        estimatedTokens: head.estimatedTokens + rows.estimated + extraTokens,
        head,
        rows,
        extraTokens,
    };
}

/**
 * The largest chars/4 share of a body this module will let a caller gate on.
 *
 * A head is solved from a provider count and most rows are bracketed by two of them, so the share is normally
 * small - 1.8% to 27% across the three stage-1 requests in the capture this was written against, which predicted
 * them within 1%. What it looks like when the derivation has nothing to work with is the second reply of a
 * session, where 91% of the range is unbracketed and the answer came out 7.29% **low** - the one direction a fit
 * gate must not be wrong in, because it grants room the window does not have. Refusing above a half leaves that
 * case to the tiers that were already answering it, so a decline costs nothing that was there before.
 */
export const MAX_LEDGER_ESTIMATED_SHARE = 0.5;

/** How much of a measured body is chars/4 rather than counted. */
export function estimatedShare(body: MeasuredBody): number {
    if (body.tokens <= 0) {
        return 1;
    }

    return body.estimatedTokens / body.tokens;
}

export interface SpanBodyInput {
    /**
     * Where the window starts: the entry the previous fold kept first, or nothing for a session's first fold.
     * `previousFoldWindowStart` answers it, and it is the same window `stageOneSpanEntries` copies.
     */
    windowStartId?: string;
    /** Where the span ends: the boundary core chose, or the one the repair walk moved it to. */
    cutId: string;
    /** chars/4 of the instruction stage 1 appends, which no reference ever sent. */
    extraTokens: number;
    /**
     * `countBoundary()` over the branch: the newest fold or shape change. A head solved from a reply that
     * predates it describes a prompt or a tool set that no longer exists, and nothing in the session says so -
     * pi records a model or thinking change as a row, but its own base-versus-override prompt flip moves
     * ~12k chars with no row at all. Declining is the honest answer; the caller keeps the tier it had.
     */
    boundary?: number;
}

/**
 * The size of the body stage 1 is about to send, or null when the session cannot derive one worth gating on.
 *
 * The checkpoint that request carries is accounted for in the head rather than as a row, which is why the window
 * and the head are separate inputs: `stageOneSpanEntries` appends the newest fold row when the slice lacks it and
 * pi hoists it to the front, so it is the head's checkpoint whether or not the window's indexes reach it. An
 * older fold's row inside the same window stays a row.
 *
 * `atIndex` is the branch length because the call happens before this compaction's own fold row exists, so the
 * newest row in the branch *is* the previous fold and its checkpoint is the one in force. A test that replays a
 * recorded session has to pass that fold's own index instead, since the file already holds every later fold -
 * `ledger.test.ts` does, and the two are the same choice made at different moments.
 */
export function spanBodyTokens(
    branch: readonly SessionEntry[],
    input: SpanBodyInput,
): MeasuredBody | null {
    const to = branch.findIndex((entry) => entry.id === input.cutId);
    if (to < 0) {
        // A cut naming no row is `cutFound: false` territory, where the span came back as the whole transcript.
        return null;
    }

    const from =
        input.windowStartId === undefined
            ? 0
            : branch.findIndex((entry) => entry.id === input.windowStartId);
    if (from < 0 || from > to) {
        return null;
    }

    const body = bodyTokens(branch, {
        atIndex: branch.length,
        from,
        to,
        extraTokens: input.extraTokens,
    });
    if (body === null || body.tokens <= 0) {
        return null;
    }

    // The head inherits its anchor reply's shape, so a reply a model or thinking change has since passed makes
    // the whole derivation describe a request nobody will send.
    const boundary = input.boundary ?? Number.NEGATIVE_INFINITY;
    if (contextIsStale(branch[body.head.replyIndex] as SessionEntry, boundary)) {
        return null;
    }

    return estimatedShare(body) > MAX_LEDGER_ESTIMATED_SHARE ? null : body;
}

/** One candidate boundary's answer from a `SpanSizer`. */
export type SizedSpan =
    { ok: true; body: MeasuredBody } | { ok: false; why: "outside-window" | "too-estimated" };

/**
 * Every prefix of stage 1's window, sized once instead of once per question.
 *
 * The cut walk needs a span size at each candidate boundary, and asking `spanBodyTokens` for each one rescans
 * the window every time - quadratic on a long branch, in the one path (a repair) that already walks furthest.
 * The head is identical for every candidate, because all of them describe the request about to be sent, so it is
 * solved once here and its refusals with it: no head, or a head a shape change has passed, and there is nothing
 * for any position to measure.
 *
 * What a caller must not read into it: this is the same derivation `spanBodyTokens` performs, declined under the
 * same rules, and `ledger.test.ts` proves the agreement position by position rather than trusting the reuse.
 */
export interface SpanSizer {
    /** Where the window begins, so a caller can name a refused cut as outside it. */
    readonly windowStartIndex: number;
    /** The body a span ending at `cutIndex` would carry: head plus rows `[windowStart, cutIndex)`. */
    spanAt(cutIndex: number): SizedSpan;
    /** The whole live context on that same basis: head plus every retained row to the tip. */
    live(): MeasuredBody;
}

export function spanSizer(
    branch: readonly SessionEntry[],
    input: { windowStartId?: string; boundary?: number },
): SpanSizer | null {
    const from =
        input.windowStartId === undefined
            ? 0
            : branch.findIndex((entry) => entry.id === input.windowStartId);
    if (from < 0) {
        return null;
    }

    const head = headAt(branch, branch.length);
    if (head === null) {
        return null;
    }

    const boundary = input.boundary ?? Number.NEGATIVE_INFINITY;
    if (contextIsStale(branch[head.replyIndex] as SessionEntry, boundary)) {
        return null;
    }

    const walk = createMeasurementWalk({ headFoldId: head.foldId });
    const prefixes: MeasuredTokens[] = [];
    for (let index = from; index < branch.length; index += 1) {
        // Answered before the row is added: a span that ends *at* the cut does not carry the cut.
        prefixes.push(walk.total(branch[index]));
        walk.add(branch[index] as SessionEntry);
    }

    // The last prefix is the whole live context: nothing follows the tip, so its trailing stretch stays open.
    const liveRows = walk.total();
    const liveBody = compose(head, liveRows);

    return {
        windowStartIndex: from,
        spanAt(cutIndex: number): SizedSpan {
            if (cutIndex < from || cutIndex > branch.length) {
                return { ok: false, why: "outside-window" };
            }

            const rows = cutIndex === branch.length ? liveRows : prefixes[cutIndex - from];
            if (rows === undefined) {
                return { ok: false, why: "outside-window" };
            }

            const body = compose(head, rows);
            if (estimatedShare(body) > MAX_LEDGER_ESTIMATED_SHARE) {
                return { ok: false, why: "too-estimated" };
            }

            return { ok: true, body };
        },
        live(): MeasuredBody {
            return liveBody;
        },
    };
}

function compose(head: BodyHead, rows: MeasuredTokens): MeasuredBody {
    return {
        tokens: head.tokens + rows.tokens,
        estimatedTokens: head.estimatedTokens + rows.estimated,
        head,
        rows,
        extraTokens: 0,
    };
}

/**
 * The same body, corrected across every fold that came after it was counted.
 *
 * Additive because each fold's `net` is a change to the head of the body, and folds do not overlap: the rows one
 * fold removed are gone from every later body. A count taken before several folds needs all of them, which is what
 * `afterIndex` selects.
 */
export function correctAcrossFolds(
    branch: readonly SessionEntry[],
    promptTokens: number,
    afterIndex: number,
): { tokens: number; folds: number; estimatedTokens: number } | null {
    const nets = foldNets(branch).filter((net) => net.foldIndex > afterIndex);
    if (nets.length === 0) {
        return null;
    }

    const estimatedTokens = nets.reduce((total, net) => total + net.estimatedTokens, 0);
    const tokens = promptTokens + nets.reduce((total, net) => total + net.net, 0);
    if (tokens <= 0) {
        return null;
    }

    return { tokens, folds: nets.length, estimatedTokens };
}
