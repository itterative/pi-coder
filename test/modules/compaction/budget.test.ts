import type { Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { summarizationBudgetTokens } from "../../../src/modules/compaction/index";
import { nativeRequestFits } from "../../../src/modules/compaction/native-request";

/**
 * The arithmetic of how much room a summarization reply gets.
 *
 * Each case names the failure it exists to prevent, because both rules here were rewritten once already.
 *
 * The shipped rule derived the budget from pi's `reserveTokens` and gave stage 1 a third of it, which capped a live
 * 94-event checkpoint at 4,369 tokens on a route whose model reports 65,536 - truncated, rejected, discarded after
 * 47.6k fresh input and 53 seconds. The `* 0.9` that briefly replaced it was not a margin either: it was hiding a
 * span-only subtraction that left the system prompt and tool schemas unbudgeted. The rule after that used
 * `min(model.maxTokens, room)`, which became the whole window on models whose store entry reports
 * `maxTokens == contextWindow`; the summary ceiling is the third term that bounds it.
 */

/** Empty but structurally real: the gate's `needed` comes from the counts handed to it, not this body. */
const emptyContext = { messages: [] as Message[], systemPrompt: "system" } as Context;

/** Live run 3, as recorded: the request counted at 54,798 tokens on a million-token window. */
const RUN_3 = { modelMaxTokens: 65_536, contextWindow: 1_000_000, requestTokens: 54_798 };

describe("summarizationBudgetTokens", () => {
    it("is bounded by the summary ceiling, not by pi's reserve", () => {
        const budget = summarizationBudgetTokens(RUN_3);

        // 65,536 is the shipped summary ceiling; `qwen3.8-flash` happens to report the same model ceiling in
        // ~/.pi/agent/models-store.json. The old stage-2 number was 13,107 - `0.8 * reserveTokens` - which is a
        // statement about the agent's turn headroom and nothing about this model, and it is what made the
        // truncation above the normal case rather than the exception.
        expect(budget).toBe(65_536);
        expect(budget).toBeGreaterThan(Math.floor(16_384 * 0.8));
    });

    it("lets the window bind when the model reports no ceiling and the room is below the summary cap", () => {
        const budget = summarizationBudgetTokens({
            modelMaxTokens: 0,
            contextWindow: 100_000,
            requestTokens: 54_798,
            marginTokens: 2_000,
        });

        // 43,202 is the window's room, below the 65,536 summary ceiling. A wider window would get the ceiling
        // instead of the room: "no model ceiling" now means "the summary ceiling", not "the whole window".
        expect(budget).toBe(100_000 - 54_798 - 2_000);
    });

    it("never asks for the whole window when the model reports the window as its output ceiling", () => {
        // The live shape: the Cloudflare model store entry reports contextWindow and maxTokens as the same
        // 1,048,576, so `min(modelMaxTokens, room)` resolved to the whole remaining window. Stage 2 asked for
        // 1,035,466 output tokens, the provider counted the request 1,025 tokens above our chars/4 estimate, and
        // the total missed the window by one token (run 01a1775d).
        const budget = summarizationBudgetTokens({
            modelMaxTokens: 1_048_576,
            contextWindow: 1_048_576,
            requestTokens: 12_086,
        });

        expect(budget).toBe(65_536);
        expect(budget).toBeLessThan(1_048_576 - 12_086 - 1_024);
    });

    it("caps a model ceiling that is above the summary ceiling", () => {
        const budget = summarizationBudgetTokens({
            modelMaxTokens: 131_072,
            contextWindow: 1_000_000,
            requestTokens: 54_798,
        });

        expect(budget).toBe(65_536);
    });

    it("reports zero rather than a floor when the window has no room at all", () => {
        const budget = summarizationBudgetTokens({
            modelMaxTokens: 65_536,
            contextWindow: 55_000,
            requestTokens: 54_798,
            marginTokens: 1_500,
        });

        // A minimum on the *budget* would grant room the window does not have, and stage 1's fit gate charges that
        // room back to the request - so a floored budget makes the gate report a fit that cannot be sent. The
        // well-formedness floor belongs on the request, not on the room.
        expect(budget).toBe(0);
    });

    it("keeps the summary ceiling constant while the window's room is larger", () => {
        const budget = (contextWindow: number, marginTokens?: number) =>
            summarizationBudgetTokens({
                ...RUN_3,
                contextWindow,
                modelMaxTokens: 1_000_000,
                ...(marginTokens === undefined ? {} : { marginTokens }),
            });

        // The cap is a statement about a summary, not about the window: a 200k and a million-token window both
        // ask for the same 65,536 tokens, because that is far more than any checkpoint needs. The old `* 0.9`
        // haircut did the opposite and grew with the window it was meant to protect.
        expect(budget(200_000, 1_500)).toBe(65_536);
        expect(budget(1_000_000, 1_500)).toBe(65_536);
        expect(budget(200_000)).toBe(65_536);
        expect(budget(1_000_000)).toBe(65_536);
    });

    it("keeps the fit gate able to fail", () => {
        // Zero margin is the degenerate case worth seeing: the budget consumes the remainder, so the gate reduces
        // to `needed < needed` and refuses a run that fits. Non-zero is the shipped shape.
        const starved = summarizationBudgetTokens({
            ...RUN_3,
            contextWindow: 60_000,
            marginTokens: 0,
        });
        expect(nativeRequestFits(emptyContext, 60_000, starved, null, RUN_3.requestTokens)).toBe(
            false,
        );

        const budget = summarizationBudgetTokens({
            ...RUN_3,
            contextWindow: 60_000,
            marginTokens: 1_500,
        });
        expect(nativeRequestFits(emptyContext, 60_000, budget, null, RUN_3.requestTokens)).toBe(
            true,
        );

        // The gate is `needed < window - output`. A budget that consumed the entire remainder would make it
        // `needed < needed` and refuse every run; one that left nothing at all would make it unfalsifiable. The
        // margin is what sits between those two.
        expect(budget).toBeLessThan(RUN_3.contextWindow - RUN_3.requestTokens);
        expect(
            nativeRequestFits(
                { messages: [] as Message[] } as Context,
                RUN_3.contextWindow,
                budget,
                null,
                RUN_3.requestTokens,
            ),
        ).toBe(true);
        expect(
            nativeRequestFits(
                { messages: [] as Message[] } as Context,
                RUN_3.contextWindow,
                budget + 1,
                null,
                RUN_3.requestTokens,
            ),
        ).toBe(true);
        expect(
            nativeRequestFits(
                { messages: [] as Message[] } as Context,
                60_000,
                budget,
                null,
                59_500,
            ),
        ).toBe(false);
    });
});

describe("nativeRequestFits", () => {
    it("believes a provider's count of this body over a heuristic of the whole context", () => {
        // The counted number is the request we are about to re-send; the reported one counts a retained tail that
        // stage 1 drops. Both matter because the difference decides whether the rung runs.
        expect(nativeRequestFits(emptyContext, 200_000, 8_240, 199_000, 40_000)).toBe(true);
        expect(nativeRequestFits(emptyContext, 200_000, 8_240, 199_000, null)).toBe(false);
    });

    it("requires room for the reply as well as the request", () => {
        const counted = 10_000;

        expect(nativeRequestFits(emptyContext, counted + 4_000 + 1, 4_000, null, counted)).toBe(
            true,
        );
        expect(nativeRequestFits(emptyContext, counted + 4_000, 4_000, null, counted)).toBe(false);
    });

    it("refuses a window it cannot reason about", () => {
        expect(nativeRequestFits(emptyContext, 0, 1_000, null, 100)).toBe(false);
        expect(nativeRequestFits(emptyContext, -1, 1_000, null, 100)).toBe(false);
    });
});
