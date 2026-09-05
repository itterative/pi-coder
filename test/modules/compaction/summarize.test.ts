import { describe, expect, it } from "vitest";

import {
    evaluateSummarizationResponse,
    type SummarizationStrategy,
} from "../../../src/modules/compaction/summarize";
import {
    failedResponse,
    summaryResponse,
    toolCallResponse,
    truncatedResponse,
} from "../../helpers/compaction-doubles";
import { zeroUsage } from "../../helpers/agent-doubles";

/**
 * The shared validator behind both strategies.
 *
 * Everything here is a pure function over a response the caller already has, so no provider is contacted: the
 * point is which replies the pipeline is allowed to treat as a summary, and the two rungs deliberately answer
 * that question differently.
 */
const TWO_SECTIONS = "## Goal\n\nCompact the module\n\n## Constraints\n\nNo new dependencies";

function rejected(result: ReturnType<typeof evaluateSummarizationResponse>): string {
    expect(result.ok).toBe(false);

    return result.ok ? "" : result.detail;
}

describe("evaluateSummarizationResponse", () => {
    it("accepts a reply that carries the required sections, and reports how it ended", () => {
        const result = evaluateSummarizationResponse(summaryResponse(TWO_SECTIONS), "native");

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.text).toBe(TWO_SECTIONS);
        expect(result.stopReason).toBe("stop");
    });

    it("trims whitespace without changing the answer", () => {
        const result = evaluateSummarizationResponse(
            summaryResponse(`\n  ${TWO_SECTIONS}  \n`),
            "serialized",
        );

        expect(result.ok && result.text).toBe(TWO_SECTIONS);
    });

    it("rejects a provider error and keeps its message", () => {
        expect(
            rejected(
                evaluateSummarizationResponse(failedResponse("error", "upstream 500"), "native"),
            ),
        ).toContain("upstream 500");
    });

    it("rejects a reply that tried to keep working instead of summarizing", () => {
        expect(
            rejected(evaluateSummarizationResponse(toolCallResponse("read"), "native")),
        ).toContain('called "read"');
    });

    it("rejects an empty reply", () => {
        expect(rejected(evaluateSummarizationResponse(summaryResponse("   "), "native"))).toContain(
            "empty summary",
        );
    });

    // The 2026-09-05 run answered with 35 tokens of "I don't have any prior thinking to reproduce", which is
    // fluent, non-empty, and useless as the session's memory.
    it("rejects an apology that carries no checkpoint sections", () => {
        expect(
            rejected(
                evaluateSummarizationResponse(
                    summaryResponse("I don't have any prior thinking to reproduce."),
                    "native",
                ),
            ),
        ).toContain("carried 0 of 2 required sections");
    });

    it("reports the section count it saw when a single-heading answer fails", () => {
        const detail = rejected(
            evaluateSummarizationResponse(summaryResponse("## Goal\n\nCompact it"), "serialized"),
        );

        expect(detail).toContain("carried 1 of 2 required sections");
    });

    /**
     * Stage 1's checkpoint is stage 2's input, so a section lost to the cut is lost from the session's memory
     * for good, and the surviving headings still satisfy the guard. Stage 1 is also the cheap rung, its context
     * already being cached, so refusing costs nearly nothing.
     */
    it("rejects a truncated stage 1 answer that still looks well-formed", () => {
        const usage = { ...zeroUsage(), output: 8000 };
        const detail = rejected(
            evaluateSummarizationResponse(
                truncatedResponse(TWO_SECTIONS, usage),
                "native" satisfies SummarizationStrategy,
            ),
        );

        expect(detail).toContain("hit the output limit after 8000 output tokens");
    });

    // Rejecting stage 2 would hand the session to pi's own compaction, which re-summarizes from scratch under
    // no section contract at all. Keeping the truncated text and letting the report flag it is the better trade.
    it("accepts a truncated stage 2 answer but carries the stop reason out for the trace", () => {
        const result = evaluateSummarizationResponse(
            truncatedResponse(TWO_SECTIONS, { ...zeroUsage(), output: 1200 }),
            "serialized",
        );

        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("length");
    });
});
