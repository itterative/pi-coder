import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { spanBodyTokens } from "../../../src/modules/compaction/ledger";
import {
    countBoundary,
    countSpanTokens,
    estimateAnchoredSpanTokens,
    estimateRequestTokens,
    fitRequirementTokens,
} from "../../../src/modules/compaction/native-request";
import type { ContextMessage } from "../../../src/modules/compaction/types";
import {
    assistantMessage,
    compactionMarker,
    messageChain,
    modelChangeMarker,
    toolResultMessage,
    userMessage,
} from "../../helpers/compaction-doubles";
import { countedUsage } from "../../helpers/agent-doubles";

/** A wire message, typed the way `Context` wants it rather than the session's wider transcript union. */
function turnMessage(text: string): Message {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/**
 * Span sizing from the numbers the session already carries.
 *
 * Every assistant entry holds the provider's count for the request that produced it, which covered the system
 * prompt, the tool definitions and every message before it - so a span that contains such a reply does not need
 * a heuristic for its own bulk, only for what arrived after that reply and for the instruction we append. These
 * tests pin which entry is trusted, what happens when none can be, and the order the gate reads its evidence in.
 */
describe("compaction span sizing", () => {
    it("sizes a span from its newest provider count plus the instruction, with no tail to guess over", () => {
        const entries = messageChain([
            { id: "u1", message: userMessage("the first ask") },
            {
                id: "a1",
                message: assistantMessage({
                    text: "the answer that was counted",
                    usage: countedUsage(4_000, 1_000, 20_000),
                }),
            },
        ]);

        // prompt (4k) + reply (1k) + cache (20k) is the context through that reply; the instruction is added
        // verbatim in tokens, and nothing else is estimated.
        expect(estimateAnchoredSpanTokens(entries, 12)).toBe(25_012);
    });

    it("estimates only what followed the anchor", () => {
        const anchored = messageChain([
            { id: "u1", message: userMessage("ask") },
            {
                id: "a1",
                message: assistantMessage({
                    text: "counted",
                    usage: countedUsage(10_000, 500),
                }),
            },
        ]);
        const withTail = messageChain([
            { id: "u1", message: userMessage("ask") },
            {
                id: "a1",
                message: assistantMessage({
                    text: "counted",
                    usage: countedUsage(10_000, 500),
                }),
            },
            {
                id: "t1",
                message: toolResultMessage({ callId: "c1", tool: "read", text: "x".repeat(400) }),
            },
        ]);

        const base = estimateAnchoredSpanTokens(anchored, 0);
        const tail = estimateAnchoredSpanTokens(withTail, 0);

        expect(base).toBe(10_500);
        // The 400-character tool output is the only uncounted content, and it is nowhere near the 10.5k anchor.
        expect(tail ?? 0).toBeGreaterThan(10_500);
        expect(tail ?? 0).toBeLessThan(11_000);
    });

    it("refuses to anchor on a reply that was aborted, errored, or reported no usage", () => {
        const entries = messageChain([
            {
                id: "a1",
                message: assistantMessage({
                    text: "the one that counted",
                    usage: countedUsage(3_000, 200),
                }),
            },
            {
                id: "a2",
                message: assistantMessage({
                    text: "half a reply",
                    usage: countedUsage(900_000, 10),
                    stopReason: "error",
                }),
            },
        ]);

        // A newer row exists and carries a huge number, but an errored turn is not a measurement of a context
        // that still exists, so the older anchor is the honest one: the total stays near 3.2k plus the small
        // trailing row rather than near 900k.
        const anchored = estimateAnchoredSpanTokens(entries, 0) ?? 0;
        expect(anchored).toBeGreaterThan(3_000);
        expect(anchored).toBeLessThan(4_000);
    });

    it("says there is no anchor when nothing in the span was ever counted", () => {
        const fresh = messageChain([
            { id: "u1", message: userMessage("first request") },
            { id: "u2", message: userMessage("second request") },
        ]);

        expect(estimateAnchoredSpanTokens(fresh, 50)).toBeNull();
    });

    it("calls a count with nothing left to estimate what it is: an exact anchor", () => {
        // The whole-turn cut, `[assistant] | [user]`: the span ends on the counted reply, so the tier reading it
        // has no tail term at all. That is a measurement of the entire body, and it used to be reported as a
        // guess because one label covered both cases.
        const wholeTurn = messageChain([
            { id: "u1", message: userMessage("the ask") },
            {
                id: "a1",
                message: assistantMessage({ text: "the answer", usage: countedUsage(20_000, 497) }),
            },
        ]);
        const withTail = messageChain([
            { id: "u1", message: userMessage("the ask") },
            {
                id: "a1",
                message: assistantMessage({ text: "the answer", usage: countedUsage(20_000, 497) }),
            },
            {
                id: "t1",
                message: toolResultMessage({
                    callId: "c1",
                    tool: "read",
                    text: "and then this landed",
                }),
            },
        ]);

        expect(countSpanTokens({ spanEntries: wholeTurn, extraTokens: 0 })).toEqual({
            tokens: 20_497,
            source: "exact-anchor",
            staleAnchors: 0,
            foldCorrected: 0,
        });
        expect(countSpanTokens({ spanEntries: withTail, extraTokens: 0 }).source).toBe(
            "usage-anchor",
        );

        // Trailing rows that produce no message are not a tail: a metadata row after the anchor adds nothing a
        // provider would receive, so the number stays exact.
        const metadataTail = [
            ...wholeTurn,
            modelChangeMarker("meta", { at: "1970-01-01T00:00:00.000Z" }),
        ];
        expect(countSpanTokens({ spanEntries: metadataTail, extraTokens: 0 }).source).toBe(
            "exact-anchor",
        );
    });

    it("ranks counted over reported over heuristic, which is the order the fit gate decides in", () => {
        const context = {
            systemPrompt: "s".repeat(4_000),
            messages: [turnMessage("t".repeat(400_000))],
            tools: [],
        };

        expect(
            fitRequirementTokens({
                countedRequestTokens: 5_000,
                reportedContextTokens: 190_000,
                context,
            }),
        ).toBe(5_000);
        expect(
            fitRequirementTokens({
                countedRequestTokens: null,
                reportedContextTokens: 190_000,
                context,
            }),
        ).toBe(190_000);
        expect(
            fitRequirementTokens({
                countedRequestTokens: undefined,
                reportedContextTokens: null,
                context,
            }),
        ).toBe(estimateRequestTokens(context));
    });

    it("charges a trailing row by its wire shape, not by what the harness stored beside it", () => {
        const withBookkeeping = messageChain([
            {
                id: "a1",
                message: assistantMessage({ text: "counted", usage: countedUsage(10_000, 500) }),
            },
            {
                id: "t1",
                message: toolResultMessage({
                    callId: "c1",
                    tool: "read",
                    text: "x".repeat(400),
                    // What pi actually keeps for a truncated read: a second full copy of the output.
                    details: { truncation: { content: "y".repeat(20_000) } },
                }),
            },
        ]);
        const withoutBookkeeping = messageChain([
            {
                id: "a1",
                message: assistantMessage({ text: "counted", usage: countedUsage(10_000, 500) }),
            },
            {
                id: "t1",
                message: toolResultMessage({ callId: "c1", tool: "read", text: "x".repeat(400) }),
            },
        ]);

        // Charged through the stored row, the 20k-character `details` would put this span near three times its
        // size; the provider never receives it, and neither does the estimate.
        expect(estimateAnchoredSpanTokens(withBookkeeping, 0)).toBe(
            estimateAnchoredSpanTokens(withoutBookkeeping, 0),
        );
        const anchored = estimateAnchoredSpanTokens(withBookkeeping, 0) ?? 0;
        expect(anchored).toBeGreaterThan(10_400);
        expect(anchored).toBeLessThan(10_800);
    });
});

/**
 * Sizing from counts the session already carries, in the order their evidence applies to the body being sent.
 *
 * The reply sitting *at* the cut point was produced by a request whose body was exactly the span - the retained
 * tail starts with that reply - so its prompt half is a measurement of this request rather than a proxy for it.
 * The fold boundary is what keeps that measurement honest: after a compaction the surviving rows still carry
 * pre-fold counts, and a pre-fold count is inflated by everything the fold reclaimed.
 */
describe("compaction span counting", () => {
    /** A span ending at the cut, with a reply at the cut whose prompt the provider counted. */
    function spanWithKeptReply(
        overrides: {
            keptUsage?: ReturnType<typeof countedUsage>;
            keptStopReason?: "stop" | "error" | "aborted";
            keptAt?: string;
            spanAnchorAt?: string;
        } = {},
    ) {
        const span = messageChain([
            { id: "u1", message: userMessage("the ask") },
            {
                id: "a1",
                at: overrides.spanAnchorAt ?? "2026-01-01T00:00:00.000Z",
                message: assistantMessage({
                    text: "in-span reply",
                    usage: countedUsage(6_000, 300, 14_000),
                }),
            },
            // A row *behind* the anchor, so the anchored tier still has something to estimate. Without it the tail
            // is empty and the tier correctly reports a count of the whole body instead of a count plus a guess -
            // true about the span, and a broken test of the guessing path.
            {
                id: "t1",
                at: overrides.spanAnchorAt ?? "2026-01-01T00:00:00.000Z",
                message: toolResultMessage({
                    callId: "c1",
                    tool: "read",
                    text: "what the anchor did not cover",
                }),
            },
        ]);
        const kept = messageChain([
            {
                id: "a2",
                at: overrides.keptAt ?? "2026-01-02T00:00:00.000Z",
                message: assistantMessage({
                    text: "the reply at the cut",
                    usage: overrides.keptUsage ?? countedUsage(9_000, 400, 23_000),
                    stopReason: overrides.keptStopReason,
                }),
            },
        ])[0];

        return { span, kept };
    }

    it("takes the cut point's own count, which needs no estimate of this body at all", () => {
        const { span, kept } = spanWithKeptReply();

        const counted = countSpanTokens({
            spanEntries: span,
            keptEntry: kept,
            extraTokens: 50,
        });

        // prompt = input + cacheRead + cacheWrite = 32_000, plus the instruction. The reply's own 400 output
        // tokens are deliberately absent: they are not part of what stage 1 re-sends.
        expect(counted).toEqual({
            tokens: 32_050,
            source: "exact-cut",
            staleAnchors: 0,
            foldCorrected: 0,
        });
    });

    it("prefers the cut point's count over guessing from an anchor inside the span", () => {
        const { span, kept } = spanWithKeptReply();
        const anchored = countSpanTokens({ spanEntries: span, extraTokens: 50 });

        // The span carries a row behind its anchor, so this is the guessing tier, and it disagrees with the count
        // of the whole body - which is what the ranking is for.
        expect(anchored.source).toBe("usage-anchor");
        expect(
            countSpanTokens({ spanEntries: span, keptEntry: kept, extraTokens: 50 }).tokens,
        ).not.toBe(anchored.tokens);
    });

    it("falls to the anchor when the kept entry cannot say it", () => {
        const { span, kept } = spanWithKeptReply();
        const notAReply = messageChain([
            { id: "u9", message: userMessage("a user turn opens here") },
        ])[0];

        expect(
            countSpanTokens({ spanEntries: span, keptEntry: notAReply, extraTokens: 50 }).source,
        ).toBe("usage-anchor");
        expect(
            countSpanTokens({
                spanEntries: span,
                keptEntry: kept,
                extraTokens: 50,
            }).source,
        ).toBe("exact-cut");
        // An errored or aborted reply is not a measurement of a body that still exists, and a row that
        // reported no prompt reported nothing.
        expect(
            countSpanTokens({
                spanEntries: span,
                keptEntry: spanWithKeptReply({ keptStopReason: "error" }).kept,
                extraTokens: 50,
            }).source,
        ).toBe("usage-anchor");
        expect(
            countSpanTokens({
                spanEntries: span,
                keptEntry: spanWithKeptReply({ keptUsage: countedUsage(0, 0) }).kept,
                extraTokens: 50,
            }).source,
        ).toBe("usage-anchor");
    });

    it("expires every count that predates a fold, and says that was the reason", () => {
        const { span, kept } = spanWithKeptReply({
            spanAnchorAt: "2026-01-01T00:00:00.000Z",
            keptAt: "2026-01-02T00:00:00.000Z",
        });
        const fold = compactionMarker("c1", {
            at: "2026-01-03T00:00:00.000Z",
            firstKeptEntryId: "a2",
        });
        const boundary = countBoundary([...span, kept, fold]);

        const counted = countSpanTokens({
            spanEntries: span,
            keptEntry: kept,
            boundary,
            extraTokens: 50,
        });

        // Both counts are real numbers, and both describe a context this fold already replaced. Believing the
        // kept reply would over-size the request by the whole reclaim, which is the direction that costs stage 1.
        expect(counted.tokens).toBeNull();
        expect(counted.source).toBe("none");
        expect(counted.staleAnchors).toBe(2);
    });

    it("keeps counting from the rows that landed after the fold", () => {
        const { span } = spanWithKeptReply({ spanAnchorAt: "2026-01-04T00:00:00.000Z" });
        const fold = compactionMarker("c1", {
            at: "2026-01-03T00:00:00.000Z",
            firstKeptEntryId: "a2",
        });

        const counted = countSpanTokens({
            spanEntries: span,
            boundary: countBoundary([fold]),
            extraTokens: 50,
        });

        expect(counted.source).toBe("usage-anchor");
        expect(counted.staleAnchors).toBe(0);
    });

    it("treats a model change as expiring counts too, because it replaced the prompt and the tools", () => {
        const { span } = spanWithKeptReply({ spanAnchorAt: "2026-01-01T00:00:00.000Z" });
        const changed = modelChangeMarker("m1", { at: "2026-01-02T00:00:00.000Z" });

        const counted = countSpanTokens({
            spanEntries: span,
            boundary: countBoundary([changed]),
            extraTokens: 50,
        });

        expect(counted.tokens).toBeNull();
        expect(counted.staleAnchors).toBe(1);
    });

    it("sees no boundary in a session that has never folded or switched model", () => {
        const { span } = spanWithKeptReply();

        expect(countBoundary(span)).toBe(Number.NEGATIVE_INFINITY);
        // Without a boundary nothing is stale, and an untouched count is not reported as a rejected one.
        expect(countSpanTokens({ spanEntries: span, extraTokens: 0 }).staleAnchors).toBe(0);
    });
});

describe("rescuing the counts a fold expired", () => {
    /**
     * A counted reply, then a fold that expired exactly that measurement.
     *
     * The rescue exists for this window: the fold has replaced a known number of tokens with a known number of
     * others, and nothing newer has been counted, which is the state `countSpanTokens` otherwise answers `none`
     * for - right after a fold, before any post-fold reply lands, when the fit gate is deciding whether stage 1
     * runs at all. The fold row is excluded from the chars/4 tail because its counted summary is already added.
     */
    function anchoredThenFolded(
        counted: { input: number; output: number },
        fold: {
            at: string;
            countedBodyTokens?: number;
            fixedPrefixTokens?: number;
            summaryTokens?: number;
        },
    ) {
        const entries = messageChain([
            { id: "u1", message: userMessage("the ask") },
            {
                id: "a1",
                message: assistantMessage({
                    text: "the answer",
                    usage: countedUsage(counted.input, counted.output),
                }),
            },
        ]);

        return [
            ...entries,
            compactionMarker("f1", {
                at: fold.at,
                firstKeptEntryId: "u1",
                countedBodyTokens: fold.countedBodyTokens,
                fixedPrefixTokens: fold.fixedPrefixTokens,
                summaryTokens: fold.summaryTokens,
            }),
        ];
    }

    it("subtracts what the fold removed and adds what it put back", () => {
        const entries = anchoredThenFolded(
            { input: 20_000, output: 497 },
            {
                at: "1970-01-01T00:00:01.000Z",
                countedBodyTokens: 20_000,
                fixedPrefixTokens: 8_000,
                summaryTokens: 2_000,
            },
        );

        // 20_497 counted, minus the 12_000 the fold removed (20_000 counted request less the 8_000 prefix inside
        // it, which the fold leaves standing), plus 2_000 of summary back in, nothing left to estimate.
        expect(
            countSpanTokens({
                spanEntries: entries,
                extraTokens: 0,
                boundary: countBoundary(entries),
            }),
        ).toEqual({
            tokens: 10_497,
            source: "usage-anchor",
            staleAnchors: 1,
            foldCorrected: 1,
        });
    });

    it("carries every fold between the anchor and the cut, not just the newest", () => {
        const entries = [
            ...messageChain([
                { id: "u1", message: userMessage("the ask") },
                {
                    id: "a1",
                    message: assistantMessage({
                        text: "the answer",
                        usage: countedUsage(20_000, 497),
                    }),
                },
            ]),
            compactionMarker("f1", {
                at: "1970-01-01T00:00:01.000Z",
                firstKeptEntryId: "u1",
                countedBodyTokens: 20_000,
                fixedPrefixTokens: 8_000,
                summaryTokens: 2_000,
            }),
            compactionMarker("f2", {
                at: "1970-01-01T00:00:02.000Z",
                firstKeptEntryId: "u1",
                countedBodyTokens: 5_000,
                fixedPrefixTokens: 2_000,
                summaryTokens: 1_500,
            }),
        ];

        expect(
            countSpanTokens({
                spanEntries: entries,
                extraTokens: 0,
                boundary: countBoundary(entries),
            }).tokens,
        ).toBe(20_497 - 12_000 + 2_000 - 3_000 + 1_500);
        expect(
            countSpanTokens({
                spanEntries: entries,
                extraTokens: 0,
                boundary: countBoundary(entries),
            }).foldCorrected,
        ).toBe(2);
    });

    it("refuses when the fold cannot vouch for both halves of the arithmetic", () => {
        // Every row written before `spanTokens` existed, and every fold whose span was never exactly counted.
        for (const fold of [
            { at: "1970-01-01T00:00:01.000Z" },
            { at: "1970-01-01T00:00:01.000Z", countedBodyTokens: 20_000 },
            { at: "1970-01-01T00:00:01.000Z", fixedPrefixTokens: 8_000 },
            { at: "1970-01-01T00:00:01.000Z", summaryTokens: 2_000 },
            // Both operands present and equal: the fold claims it removed nothing, which cannot be true of a fold
            // that summarized anything, so it is refused rather than read as a zero-cost correction.
            {
                at: "1970-01-01T00:00:01.000Z",
                countedBodyTokens: 8_000,
                fixedPrefixTokens: 8_000,
                summaryTokens: 2_000,
            },
        ]) {
            const entries = anchoredThenFolded({ input: 20_000, output: 497 }, fold);

            expect(
                countSpanTokens({
                    spanEntries: entries,
                    extraTokens: 0,
                    boundary: countBoundary(entries),
                }),
            ).toEqual({ tokens: null, source: "none", staleAnchors: 1, foldCorrected: 0 });
        }
    });

    it("refuses a correction that says the context shrank below zero", () => {
        const entries = anchoredThenFolded(
            { input: 4_000, output: 500 },
            {
                at: "1970-01-01T00:00:01.000Z",
                countedBodyTokens: 20_000,
                fixedPrefixTokens: 8_000,
                summaryTokens: 2_000,
            },
        );

        // A removal larger than the body that was counted means the two numbers describe different bodies, and a
        // number that disagrees with its own arithmetic is worse than the heuristic it replaces.
        expect(
            countSpanTokens({
                spanEntries: entries,
                extraTokens: 0,
                boundary: countBoundary(entries),
            }),
        ).toEqual({ tokens: null, source: "none", staleAnchors: 1, foldCorrected: 0 });
    });

    it("leaves a live anchor alone", () => {
        const entries = messageChain([
            { id: "u1", message: userMessage("the ask") },
            {
                id: "a1",
                message: assistantMessage({ text: "the answer", usage: countedUsage(20_000, 497) }),
            },
        ]);

        // No boundary at all: nothing expired, so nothing is rescued and the tier answers from the anchor directly.
        expect(countSpanTokens({ spanEntries: entries, extraTokens: 0 })).toEqual({
            tokens: 20_497,
            source: "exact-anchor",
            staleAnchors: 0,
            foldCorrected: 0,
        });
    });
});

/**
 * The head ledger as a tier: what it answers, and what outranks it.
 *
 * The shape it exists for is a cut that sits *below* the newest fold's row - the window the `hosted-head-ledger`
 * capture recorded as `chars4` with 14 stale anchors and priced 8.8% high. Every count inside the span predates
 * that fold, so no anchor tier can answer, while the fold's own first counted reply sits in the retained tail and
 * solves the head. The ledger is handed in rather than computed here because it walks the file-order branch and
 * the window `stageOneSpanEntries` chose, and this function is given neither.
 */
describe("the head ledger tier", () => {
    /**
     * A fold, a count below it that the fold expired, an uncounted cut, and the reply after the fold that solves
     * the head. `fold` decides whether the persisted-fields rescue could also answer, which is what the ordering
     * cases turn on.
     */
    function foldedWithATailReply(
        fold: { countedBodyTokens?: number; fixedPrefixTokens?: number } = {},
        extraRows: Array<{ id: string; message: ContextMessage; at?: string }> = [],
    ) {
        return [
            ...messageChain([
                { id: "u1", message: userMessage("the ask") },
                {
                    id: "a1",
                    message: assistantMessage({
                        text: "y".repeat(40),
                        usage: countedUsage(20_000, 500),
                    }),
                },
            ]),
            compactionMarker("f1", {
                at: "1970-01-01T00:00:01.000Z",
                firstKeptEntryId: "u1",
                summaryTokens: 800,
                ...fold,
            }),
            ...messageChain([
                { id: "u2", message: userMessage("and again"), at: "1970-01-01T00:00:02.000Z" },
                ...extraRows,
                {
                    id: "u3",
                    message: userMessage("the cut lands here"),
                    at: "1970-01-01T00:00:02.000Z",
                },
                {
                    id: "a2",
                    message: assistantMessage({
                        text: "w".repeat(40),
                        usage: countedUsage(3_000, 100),
                    }),
                    at: "1970-01-01T00:00:03.000Z",
                },
            ]),
        ];
    }

    /** The window stage 1 would copy: the previous fold's boundary up to the cut. */
    function ledgerFor(entries: SessionEntry[], cutId: string) {
        return spanBodyTokens(entries, { windowStartId: "u1", cutId, extraTokens: 0 });
    }

    it("answers when a fold expired every count in the span", () => {
        const entries = foldedWithATailReply();
        const boundary = countBoundary(entries);
        const ledger = ledgerFor(entries, "u3");

        expect(ledger).not.toBeNull();
        expect(
            countSpanTokens({ spanEntries: entries.slice(0, 4), boundary, extraTokens: 0, ledger }),
        ).toEqual({
            tokens: ledger?.tokens,
            source: "head-ledger",
            // The count the fold expired is still reported: the tier says where the number came from, not that
            // nothing was rejected on the way to it.
            staleAnchors: 1,
            foldCorrected: 0,
        });

        // And without a ledger number the same span has nothing: this is the window that used to answer `none`
        // and fall through to whole-body chars/4.
        expect(
            countSpanTokens({ spanEntries: entries.slice(0, 4), boundary, extraTokens: 0 }).source,
        ).toBe("none");
    });

    it("outranks the persisted-fields rescue, which needs state the ledger does not", () => {
        const entries = foldedWithATailReply({
            countedBodyTokens: 20_000,
            fixedPrefixTokens: 8_000,
        });
        const boundary = countBoundary(entries);
        const spanEntries = entries.slice(0, 4);

        // Both can answer this span. The ledger is a difference of provider counts over this session; the rescue
        // reads two numbers a fold row persisted about a request it made, and only builds from this one write it.
        const rescued = countSpanTokens({ spanEntries, boundary, extraTokens: 0 });
        expect(rescued.source).toBe("usage-anchor");
        expect(rescued.foldCorrected).toBe(1);

        const withLedger = countSpanTokens({
            spanEntries,
            boundary,
            extraTokens: 0,
            ledger: ledgerFor(entries, "u3"),
        });
        expect(withLedger.source).toBe("head-ledger");
        expect(withLedger.foldCorrected).toBe(0);
    });

    it("leaves a live anchor in the span alone, because that count is of this body", () => {
        // A counted reply inside the window, after the fold: the anchored tier has a measurement of a prefix of
        // the very body being sent, which beats a head solved from a reply in the retained tail.
        const entries = foldedWithATailReply({}, [
            {
                id: "a1b",
                message: assistantMessage({
                    text: "v".repeat(40),
                    usage: countedUsage(2_500, 60),
                }),
                at: "1970-01-01T00:00:02.000Z",
            },
        ]);
        const boundary = countBoundary(entries);

        const counted = countSpanTokens({
            spanEntries: entries.slice(0, 5),
            boundary,
            extraTokens: 0,
            ledger: ledgerFor(entries, "u3"),
        });

        // The anchor is the span's last row, so nothing follows it to guess at and the tier says so. Which anchor
        // label it gets is not the point: a count of this body outranks a head solved from a reply that sits in
        // the retained tail, and the ledger's number is not used.
        expect(counted.source).toBe("exact-anchor");
        expect(counted.tokens).toBe(2_500 + 60);
    });
});
