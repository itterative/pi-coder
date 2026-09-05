import { describe, expect, it } from "vitest";

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
    evaluateSummarizationResponse,
    type SummarizationAttemptResult,
    summarizeNatively,
    type SummarizationCall,
    type SummarizationStrategy,
} from "../../../src/modules/compaction/summarize";
import {
    failedResponse,
    summaryResponse,
    toolCallResponse,
    truncatedResponse,
} from "../../helpers/compaction-doubles";
import { zeroUsage } from "../../helpers/agent-doubles";
import { stubModel, stubModelRegistry } from "../../helpers/pi-stub";

/**
 * The shared validator behind both strategies.
 *
 * Everything here is a pure function over a response the caller already has, so no provider is contacted: the
 * point is which replies the pipeline is allowed to treat as a summary, and the two rungs deliberately answer
 * that question differently.
 */
const TWO_SECTIONS = "## Goal\n\nCompact the module\n\n## Constraints\n\nNo new dependencies";

/** The numbers a real stage 1 call runs with; `isRecoverableLength` needs the budget the request was sent with. */
const CLASSIFICATION = { contextWindow: 200_000, outputBudgetTokens: 13_107 };

function checked(
    response: Parameters<typeof evaluateSummarizationResponse>[0],
    strategy: SummarizationStrategy,
): SummarizationAttemptResult {
    return evaluateSummarizationResponse(response, strategy, CLASSIFICATION);
}

function rejected(result: SummarizationAttemptResult): string {
    expect(result.ok).toBe(false);

    return result.ok ? "" : result.detail;
}

/** A request that answers from a scripted list, repeating its last entry, and counts its calls. */
function scripted(
    responses: AssistantMessage[],
    options: { signal?: AbortSignal; retries?: number } = {},
) {
    const delays: number[] = [];
    let index = 0;
    const registry = stubModelRegistry(async () => {
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return next;
    });
    const call: SummarizationCall = {
        registry,
        model: stubModel({ maxTokens: 13_107 }),
        maxTokens: 13_107,
        signal: options.signal,
        retry: {
            maxRetries: options.retries ?? 2,
            baseDelayMs: 1000,
            // Records the schedule instead of waiting on it: a test that sleeps is a test that races.
            sleep: async (ms: number) => {
                delays.push(ms);
            },
        },
    };

    return { call, delays, calls: () => index };
}

const CONTEXT: Context = { systemPrompt: "the serialization prompt", messages: [] };

/** Narrow to the failure arm: the success arm carries no cause and no detail to read. */
function failure(
    result: SummarizationAttemptResult,
): Extract<SummarizationAttemptResult, { ok: false }> {
    expect(result.ok).toBe(false);
    if (result.ok) {
        throw new Error("expected the attempt to fail");
    }

    return result;
}
const SERVER_ERROR = "500 internal server error";
const RATE_LIMITED = "429 Too Many Requests";

describe("transient retry budget", () => {
    it("resends a transient failure on an exponential schedule and says how many times", async () => {
        const scriptedCall = scripted([
            failedResponse("error", SERVER_ERROR),
            failedResponse("error", SERVER_ERROR),
            summaryResponse(TWO_SECTIONS),
        ]);

        const result = await summarizeNatively(scriptedCall.call, CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.retries).toBe(2);
        expect(scriptedCall.delays).toEqual([1000, 2000]);
        expect(scriptedCall.calls()).toBe(3);
    });

    it("stops at the budget and leaves the cause on the record", async () => {
        const scriptedCall = scripted([failedResponse("error", SERVER_ERROR)], { retries: 2 });

        const result = failure(await summarizeNatively(scriptedCall.call, CONTEXT));

        expect(result.cause).toBe("transient");
        expect(result.retries).toBe(2);
        expect(scriptedCall.delays).toEqual([1000, 2000]);
    });

    it("sends no resend for a rate limit, whatever the budget allows", async () => {
        const scriptedCall = scripted([failedResponse("error", RATE_LIMITED)]);

        const result = failure(await summarizeNatively(scriptedCall.call, CONTEXT));

        expect(result.cause).toBe("rate-limit");
        expect(result.retries).toBe(0);
        expect(scriptedCall.delays).toEqual([]);
        expect(scriptedCall.calls()).toBe(1);
    });

    it("reports an abort arriving during the backoff as an abort, not as a provider failure", async () => {
        const controller = new AbortController();
        const scriptedCall = scripted([failedResponse("error", SERVER_ERROR)], {
            signal: controller.signal,
        });
        scriptedCall.call.retry = {
            maxRetries: 2,
            baseDelayMs: 1000,
            sleep: async () => {
                controller.abort();
            },
        };

        const result = failure(await summarizeNatively(scriptedCall.call, CONTEXT));

        expect(result.cause).toBe("aborted");
        expect(result.detail).toContain("aborted during the retry backoff");
    });

    it("does not retry a deterministic content rejection", async () => {
        const scriptedCall = scripted([toolCallResponse("bash")]);

        const result = failure(await summarizeNatively(scriptedCall.call, CONTEXT));

        expect(result.cause).toBe("content");
        expect(scriptedCall.calls()).toBe(1);
    });
});

describe("evaluateSummarizationResponse", () => {
    it("accepts a reply that carries the required sections, and reports how it ended", () => {
        const result = checked(summaryResponse(TWO_SECTIONS), "native");

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.text).toBe(TWO_SECTIONS);
        expect(result.stopReason).toBe("stop");
    });

    it("trims whitespace without changing the answer", () => {
        const result = checked(summaryResponse(`\n  ${TWO_SECTIONS}  \n`), "serialized");

        expect(result.ok && result.text).toBe(TWO_SECTIONS);
    });

    it("rejects a provider error and keeps its message", () => {
        expect(rejected(checked(failedResponse("error", "upstream 500"), "native"))).toContain(
            "upstream 500",
        );
    });

    it("rejects a reply that tried to keep working instead of summarizing", () => {
        expect(rejected(checked(toolCallResponse("read"), "native"))).toContain('called "read"');
    });

    it("rejects an empty reply", () => {
        expect(rejected(checked(summaryResponse("   "), "native"))).toContain("empty summary");
    });

    // The 2026-09-05 run answered with 35 tokens of "I don't have any prior thinking to reproduce", which is
    // fluent, non-empty, and useless as the session's memory.
    it("rejects an apology that carries no checkpoint sections", () => {
        expect(
            rejected(
                checked(summaryResponse("I don't have any prior thinking to reproduce."), "native"),
            ),
        ).toContain("carried 0 of 2 required sections");
    });

    it("reports the section count it saw when a single-heading answer fails", () => {
        const detail = rejected(checked(summaryResponse("## Goal\n\nCompact it"), "serialized"));

        expect(detail).toContain("carried 1 of 2 required sections");
    });

    /**
     * Stage 1's checkpoint is stage 2's input, so a section lost to the cut is lost from the session's memory
     * for good, and the surviving headings still satisfy the guard. Stage 1 is also the cheap rung, its context
     * already being cached, so refusing costs nearly nothing.
     */
    it("rejects a truncated stage 1 answer that still looks well-formed", () => {
        // Output at the budget is a genuine cut. Stopping far short of it is context pressure, and the two are
        // named differently below because the cascade's next move depends on which one it was.
        const usage = { ...zeroUsage(), output: 13_107 };
        const detail = rejected(
            checked(
                truncatedResponse(TWO_SECTIONS, usage),
                "native" satisfies SummarizationStrategy,
            ),
        );

        expect(detail).toContain("hit the output limit after 13107 output tokens");
        expect(
            failure(
                evaluateSummarizationResponse(
                    truncatedResponse(TWO_SECTIONS, usage),
                    "native",
                    CLASSIFICATION,
                ),
            ).cause,
        ).toBe("truncated");
    });

    it("names a `length` stop far short of the budget as context pressure instead", () => {
        const result = failure(
            evaluateSummarizationResponse(
                truncatedResponse(TWO_SECTIONS, { ...zeroUsage(), output: 12 }),
                "native",
                CLASSIFICATION,
            ),
        );

        expect(result.cause).toBe("overflow");
        expect(result.detail).toContain("reads as context pressure rather than a long answer");
    });

    // Rejecting stage 2 would hand the session to pi's own compaction, which re-summarizes from scratch under
    // no section contract at all. Keeping the truncated text and letting the report flag it is the better trade.
    it("accepts a truncated stage 2 answer but carries the stop reason out for the trace", () => {
        const result = checked(
            truncatedResponse(TWO_SECTIONS, { ...zeroUsage(), output: 1200 }),
            "serialized",
        );

        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("length");
    });
});
