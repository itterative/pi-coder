import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
    chooseSpanCut,
    measureSpanAt,
    type CutInput,
    type CutRejection,
} from "../../../src/modules/compaction/cut";
import { countBoundary } from "../../../src/modules/compaction/native-request";
import { spanSizer } from "../../../src/modules/compaction/ledger";
import { previousFoldWindowStart } from "../../../src/modules/compaction/span-session";
import {
    assistantMessage,
    compactionMarker,
    messageChain,
    postFoldBranch,
    toolResultMessage,
    userMessage,
} from "../../helpers/compaction-doubles";
import { countedUsage } from "../../helpers/agent-doubles";

/**
 * Repairing the cut: choosing where the span ends when the boundary core picked cannot be sent.
 *
 * The counts below are the ones the module reads, so each expectation is arithmetic on a provider number rather
 * than a guess about one. Position by position:
 *
 * ```
 * 0 u0  user
 * 1 a1  assistant  prompt 1,000  total 1,200  (calls c1)
 * 2 t1  toolResult              (answers c1)
 * 3 a2  assistant  prompt 5,000 total 5,300   (calls c2)
 * 4 t2  toolResult              (answers c2)
 * 5 a3  assistant  prompt 20,000 total 20,500
 * 6 u6  user
 * 7 a7  assistant  prompt 21,000 total 21,400
 * ```
 *
 * Two of these positions are traps worth naming in tests: cutting *at* a tool result orphans it, because the
 * call that produced it sits above the cut, and cutting at a user turn measures the span from the reply above it
 * rather than from itself. Both are shape facts the module has to get right for different reasons, and the
 * expectations below were derived from them rather than from observed output.
 */

function rows(): SessionEntry[] {
    return messageChain([
        { id: "u0", message: userMessage("open the module") },
        {
            id: "a1",
            at: "2026-01-01T00:00:01.000Z",
            message: assistantMessage({
                text: "reading",
                calls: [{ id: "c1", name: "read" }],
                usage: countedUsage(1_000, 200),
            }),
        },
        { id: "t1", message: toolResultMessage({ callId: "c1", tool: "read", text: "body" }) },
        {
            id: "a2",
            at: "2026-01-01T00:00:04.000Z",
            message: assistantMessage({
                text: "editing",
                calls: [{ id: "c2", name: "edit" }],
                usage: countedUsage(5_000, 300),
            }),
        },
        { id: "t2", message: toolResultMessage({ callId: "c2", tool: "edit", text: "ok" }) },
        {
            id: "a3",
            at: "2026-01-01T00:00:06.000Z",
            message: assistantMessage({ text: "done here", usage: countedUsage(20_000, 500) }),
        },
        { id: "u6", message: userMessage("next task") },
        {
            id: "a7",
            at: "2026-01-01T00:00:08.000Z",
            message: assistantMessage({ text: "on it", usage: countedUsage(21_000, 400) }),
        },
    ]);
}

function input(overrides: Partial<CutInput> = {}): CutInput {
    const branch = rows();

    return {
        branch,
        proposedFirstKeptEntryId: "u6",
        boundary: countBoundary(branch),
        // The live context as the newest count reports it: through `a7`'s answer.
        liveTokens: 21_400,
        keepRecentTokens: 500,
        contextWindow: 200_000,
        outputBudgetTokens: 4_369,
        instructionTokens: 100,
        ...overrides,
    };
}

function positionOf(id: string): number {
    return rows().findIndex((entry) => entry.id === id);
}

function tally(rejections: Partial<Record<CutRejection, number>>): string {
    return JSON.stringify(rejections);
}

describe("span cut selection", () => {
    it("leaves core's boundary alone when it is admissible and fits", () => {
        const decision = chooseSpanCut(input());

        // Cut at a user row, so the span ends on `a3`: 20,500 through that reply plus the instruction, leaving
        // 800 of retained history, which clears a 500 budget and fits the window with room to spare.
        expect(decision).toEqual({
            firstKeptEntryId: "u6",
            movedEarlier: false,
            movedRows: 0,
            reason: "proposed cut fits",
            proposedRejection: null,
            tailTokens: 800,
            spanTokens: 20_600,
            // The count route answered here, and says so: no sizer was passed, and the row at the cut carries a
            // provider count of exactly this body.
            spanBasis: "count",
            liveTokensSource: undefined,
            rejections: {},
        });
    });

    it("walks earlier when core's boundary would retain less than the keep budget asks", () => {
        // 800 retained is under 5,000, and every position *later* retains less, so the budget can only be met by
        // moving back. `a2` at 5,100 leaves 16,300.
        const decision = chooseSpanCut(input({ keepRecentTokens: 5_000 }));

        expect(decision.movedEarlier).toBe(true);
        expect(decision.firstKeptEntryId).toBe("a2");
        expect(decision.spanTokens).toBe(5_100);
        expect(decision.tailTokens).toBe(16_300);
        // Positions 6 and 5 miss the budget, and 4 is a tool result whose call is above the cut - rejected for
        // being an impossible request, not for its size.
        expect(tally(decision.rejections)).toBe(
            tally({ "tail-under-keep-budget": 2, "orphaned-tool-call": 1 }),
        );
    });

    it("walks earlier when core's boundary would not fit the window", () => {
        // The repair this exists for: 20,600 plus stage 1's 4,369-token answer cannot go out a 10,000-token
        // window, while the shorter span fits it with 531 tokens to spare.
        const decision = chooseSpanCut(input({ contextWindow: 10_000 }));

        expect(decision.firstKeptEntryId).toBe("a2");
        expect(decision.movedRows).toBe(3);
        expect(tally(decision.rejections)).toBe(
            tally({ "span-does-not-fit": 2, "orphaned-tool-call": 1 }),
        );
    });

    it("never moves later than core's boundary, whatever would fit", () => {
        // The one-directional rule, stated as a property rather than as a preference: a later cut would summarize
        // material core never put in `messagesToSummarize`, which is the case that would force owning the
        // summarized set. Starting at `t1`, the walk may only consider 1 and 0.
        const decision = chooseSpanCut(
            input({ proposedFirstKeptEntryId: "t1", contextWindow: 6_000, keepRecentTokens: 1 }),
        );

        expect(positionOf(decision.firstKeptEntryId)).toBeLessThanOrEqual(positionOf("t1"));
        expect(decision.movedEarlier).toBe(true);
        expect(decision.firstKeptEntryId).toBe("a1");
        expect(decision.spanTokens).toBe(1_100);
    });

    it("will not cut where a retained tool result lost its call", () => {
        // Positions 4 (`t2`) and 2 (`t1`) both keep a result whose call is above the cut. With a window that
        // cannot take either assistant row between them, the walk has to go all the way to `a1` rather than settle
        // for a boundary that reads as a size and fails as a request.
        const decision = chooseSpanCut(
            input({ proposedFirstKeptEntryId: "t2", contextWindow: 8_000, keepRecentTokens: 1 }),
        );

        expect(decision.firstKeptEntryId).toBe("a1");
        expect(tally(decision.rejections)).toBe(
            tally({ "orphaned-tool-call": 2, "span-does-not-fit": 1 }),
        );
    });

    it("reports a count a fold expired as expired, and a boundary with no count as that", () => {
        const branch = rows();
        const boundary = countBoundary([
            ...branch,
            compactionMarker("fold", { at: "2026-01-01T00:00:09.000Z", firstKeptEntryId: "u6" }),
        ]);

        const decision = chooseSpanCut(input({ branch, boundary }));

        // Every reply in the window predates that fold, so what is left is not a smaller measurement but no
        // measurement - and the two causes stay separately counted, because only one of them says the session was
        // ever sized. Six positions reach an expired count (a user or result row resolves to the reply above it,
        // which expired too); only the very first row has nothing to resolve to at all.
        expect(decision.movedEarlier).toBe(false);
        expect(decision.firstKeptEntryId).toBe("u6");
        expect(decision.rejections).toMatchObject({ "count-expired-at-fold-or-shape-change": 6 });
        expect(decision.rejections).toMatchObject({ "not-a-countable-boundary": 1 });
        expect(decision.reason).toContain("no earlier boundary admissible");
    });

    it("does not move while it cannot see the live size", () => {
        // `getContextUsage()` is null right after a fold, which is also when a repair looks most attractive. A
        // boundary chosen without being able to evaluate the keep budget is how a repair becomes a regression.
        const decision = chooseSpanCut(input({ liveTokens: null, keepRecentTokens: 5_000 }));

        expect(decision.movedEarlier).toBe(false);
        expect(decision.firstKeptEntryId).toBe("u6");
        expect(tally(decision.rejections)).toBe(tally({ "unmeasurable-live-context": 1 }));
    });

    it("keeps core's boundary when the id names no row at all", () => {
        // A defect to report, not to paper over: substituting a position we liked would turn a visible failure
        // into an invisible one, and `cutFound` is the field that says this happened.
        const decision = chooseSpanCut(input({ proposedFirstKeptEntryId: "nope" }));

        expect(decision.reason).toBe("unresolvable cut point");
        expect(decision.firstKeptEntryId).toBe("nope");
        expect(decision.movedEarlier).toBe(false);
    });

    it("is monotone while it has a boundary to choose, and says so when it has none", () => {
        // The walk's termination argument, tested rather than asserted in a comment: if shrinking a span could
        // ever make a request unfit, "keep moving earlier until it fits" would not terminate.
        //
        // The property holds over *chosen* boundaries only. When nothing is admissible the module returns core's
        // id unchanged - which is later than any candidate, and deliberate: leaving the boundary alone keeps the
        // tail floor and the file ledger exactly as core computed them, and lets the fit gate say "skipped" in
        // the same words it has always used. That state is the last case below, not a violation of this one.
        const branch = rows();
        const decide = (window: number) => chooseSpanCut(input({ branch, contextWindow: window }));
        const windows = [200_000, 30_000, 26_000, 25_000, 9_500, 6_000, 5_500];
        const chosen = windows.map(decide).filter((decision) => decision.spanTokens !== null);

        expect(chosen.length).toBe(windows.length);
        for (let index = 1; index < chosen.length; index += 1) {
            expect(positionOf(chosen[index].firstKeptEntryId)).toBeLessThanOrEqual(
                positionOf(chosen[index - 1].firstKeptEntryId),
            );
        }
        expect(chosen.map((decision) => decision.firstKeptEntryId)).toEqual([
            "u6",
            "u6",
            "u6",
            "u6",
            "a2",
            "a1",
            "a1",
        ]);

        // A window no span of this session can fit under: no move, no count, and a reason that says why.
        const hopeless = decide(1_200);
        expect(hopeless.spanTokens).toBeNull();
        expect(hopeless.movedEarlier).toBe(false);
        expect(hopeless.firstKeptEntryId).toBe("u6");
        expect(hopeless.reason).toContain("no earlier boundary admissible");
    });
});

describe("boundary measurement", () => {
    it("reads an assistant at the cut as its prompt and a user turn as the reply above it", () => {
        const branch = rows();
        const index = (id: string) => branch.findIndex((entry) => entry.id === id);
        const boundary = countBoundary(branch);

        // `a3` at the cut: 20,000 of body, its 500-token answer not in it. `u6` at the cut: the span ends on
        // `a3`, so 20,500 - answer included - is the body.
        expect(measureSpanAt(branch, index("a3"), boundary, 100)).toEqual({
            ok: true,
            tokens: 20_100,
            basis: "count",
        });
        expect(measureSpanAt(branch, index("u6"), boundary, 100)).toEqual({
            ok: true,
            tokens: 20_600,
            basis: "count",
        });
    });

    it("counts a boundary whose span ends on a reply, and declines one whose span does not", () => {
        const branch = rows();
        const index = (id: string) => branch.findIndex((entry) => entry.id === id);
        const boundary = countBoundary(branch);

        // Cut at `t1`: the span is [u0, a1], which ends on a counted reply, so 1,200 measures it. Whether that
        // boundary should be *chosen* is a separate question - the surviving result's call sits above the cut -
        // and keeping measurement apart from admissibility is what lets the tallies say one thing each.
        expect(measureSpanAt(branch, index("t1"), boundary, 0)).toEqual({
            ok: true,
            tokens: 1_200,
            basis: "count",
        });
        // Cut at `u0`: nothing above it, so an empty span has no count to read.
        expect(measureSpanAt(branch, index("u0"), boundary, 0)).toEqual({
            ok: false,
            why: "not-countable",
        });
    });

    it("declines a boundary whose only count expired at a fold", () => {
        const branch = rows();
        const boundary = countBoundary([
            ...branch,
            compactionMarker("fold", { at: "2026-01-01T00:00:07.000Z", firstKeptEntryId: "u6" }),
        ]);

        // `a3` was counted before that fold (00:00:06), `a7` after it (00:00:08): expired and live, stated apart.
        // The refusal is still the count route's, because no sizer was offered: C2 adds the second route, it does
        // not quietly replace the first, and a position the session cannot vouch for stays unmeasurable.
        expect(measureSpanAt(branch, 5, boundary, 0)).toEqual({
            ok: false,
            why: "count-expired",
        });
        expect(measureSpanAt(branch, 7, boundary, 0)).toEqual({
            ok: true,
            tokens: 21_000,
            basis: "count",
        });
    });
});

/**
 * What C2 opened: a position below a fold, where every stored count has expired, is now repairable - because the
 * ledger's number is arithmetic over counts rather than a guess at one. `postFoldBranch`'s table is the fixture,
 * and every expectation below is a provider number read straight off it.
 */
describe("measuring a boundary the counts cannot answer for", () => {
    function sizerFor(branch: SessionEntry[]) {
        return spanSizer(branch, {
            windowStartId: previousFoldWindowStart(branch),
            boundary: countBoundary(branch),
        });
    }

    it("sizes a position whose only count a fold expired, and only when the sizer is offered", () => {
        const branch = postFoldBranch();
        const boundary = countBoundary(branch);
        const sizer = sizerFor(branch);
        const index = (id: string) => branch.findIndex((entry) => entry.id === id);

        // `a1` was counted before the fold, so the count route has nothing: this is the refusal that, before C2,
        // ended the walk's interest in the whole stretch below a fold.
        expect(measureSpanAt(branch, index("a1"), boundary, 100)).toEqual({
            ok: false,
            why: "count-expired",
        });

        // Head alone (4,800) plus the instruction: a span that ends at the window's own first row carries no rows.
        expect(measureSpanAt(branch, index("a1"), boundary, 100, sizer)).toEqual({
            ok: true,
            tokens: 4_900,
            basis: "ledger",
        });

        // The fold row at index 2 carries no usage of its own, and the reply above it is expired - the shape pi's
        // backwards scan over metadata rows can hand a caller. The ledger answers it at 4,800 + 200 = 5,000, which
        // is exactly `a2`'s prompt: the two routes measured the same body and agree to the token.
        expect(measureSpanAt(branch, index("f1"), boundary, 0)).toEqual({
            ok: false,
            why: "count-expired",
        });
        expect(measureSpanAt(branch, index("f1"), boundary, 0, sizer)).toEqual({
            ok: true,
            tokens: 5_000,
            basis: "ledger",
        });
    });

    it("refuses a cut below the window even though the ledger could price the rows", () => {
        const branch = postFoldBranch();
        const boundary = countBoundary(branch);
        const sizer = sizerFor(branch);

        // `stageOneSpanEntries` begins at the newest fold's `firstKeptEntryId`, so a boundary under `u0`... is not
        // a smaller span, it is a body nobody can assemble. Expiry used to keep the walk out of here by accident;
        // a route that can size expired positions has to be told the window's edge explicitly.
        expect(sizer?.windowStartIndex).toBe(1);
        expect(measureSpanAt(branch, 0, boundary, 100, sizer)).toEqual({
            ok: false,
            why: "outside-window",
        });
        // And the tally the walk records for it is the window's, not the count route's - the last route asked is
        // the route that says no.
        const decision = chooseSpanCut(
            input({
                branch,
                proposedFirstKeptEntryId: "a1",
                boundary,
                liveTokens: 8_400,
                keepRecentTokens: 4_000,
                instructionTokens: 100,
                sizer,
            }),
        );

        expect(decision.rejections).toMatchObject({ "outside-span-window": 1 });
    });

    it("repairs post-fold where the count-only walk abstained, and says which route answered", () => {
        const branch = postFoldBranch();
        const boundary = countBoundary(branch);
        const sizer = sizerFor(branch);
        const shared = {
            branch,
            proposedFirstKeptEntryId: "a2",
            boundary,
            liveTokens: 8_400,
            keepRecentTokens: 3_400,
            contextWindow: 200_000,
            outputBudgetTokens: 1_024,
            instructionTokens: 100,
        };

        // Core's boundary keeps 3,300 of the 3,400 asked for, so the walk must go earlier - and everywhere earlier
        // is below the fold. Without the sizer that is the end of it: the count route is blind to the whole
        // stretch, and the run ships core's under-keeping cut.
        const blind = chooseSpanCut({ ...shared, sizer: null });
        expect(blind.movedEarlier).toBe(false);
        expect(blind.rejections).toMatchObject({
            "tail-under-keep-budget": 1,
            "count-expired-at-fold-or-shape-change": 2,
            "not-a-countable-boundary": 1,
        });

        // With it, the same branch repairs itself two rows back, on the ledger's number, and names both facts.
        const repaired = chooseSpanCut({ ...shared, sizer });
        expect(repaired).toMatchObject({
            firstKeptEntryId: "a1",
            movedEarlier: true,
            movedRows: 2,
            spanBasis: "ledger",
            spanTokens: 4_900,
            tailTokens: 3_500,
            proposedRejection: "tail-under-keep-budget",
            rejections: { "tail-under-keep-budget": 2 },
        });
        expect(repaired.reason).toBe(
            "moved back 2 rows: core's boundary was tail-under-keep-budget",
        );
    });

    it("sizes the whole live context where pi's own hybrid returns null", () => {
        const branch = postFoldBranch();
        const sizer = sizerFor(branch);

        // 4,800 head + 200 (a1's reply) + 300 (a2's reply) + the 3,000 of rows between them + 400 (a4's reply):
        // the ledger's live is `a4`'s own totalTokens, which is what the provider charged for that body.
        expect(sizer?.live().tokens).toBe(8_400);
        expect(sizer?.live().rows.estimated).toBe(0);
    });
});
