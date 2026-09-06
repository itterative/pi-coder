import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
    estimateAnchoredSpanTokens,
    estimateRequestTokens,
    fitRequirementTokens,
} from "../../../src/modules/compaction/native-request";
import {
    assistantMessage,
    messageChain,
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

    it("ranks anchored over reported over heuristic, which is the order the fit gate decides in", () => {
        const context = {
            systemPrompt: "s".repeat(4_000),
            messages: [turnMessage("t".repeat(400_000))],
            tools: [],
        };

        expect(
            fitRequirementTokens({
                anchoredRequestTokens: 5_000,
                reportedContextTokens: 190_000,
                context,
            }),
        ).toBe(5_000);
        expect(
            fitRequirementTokens({
                anchoredRequestTokens: null,
                reportedContextTokens: 190_000,
                context,
            }),
        ).toBe(190_000);
        expect(
            fitRequirementTokens({
                anchoredRequestTokens: undefined,
                reportedContextTokens: null,
                context,
            }),
        ).toBe(estimateRequestTokens(context));
    });
});
