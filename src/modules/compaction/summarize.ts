import type {
    Api,
    AssistantMessage,
    Context,
    Model,
    StopReason,
    Usage,
} from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    type FailureClassificationInput,
    type SummarizationFailureCause,
    UNCLASSIFIED_THROWN_ERROR,
    classifySummarizationFailure,
    summarizationFailureAction,
} from "./failure";
import {
    MIN_CHECKPOINT_SECTIONS,
    SERIALIZATION_SYSTEM_PROMPT,
    checkpointSectionCount,
} from "./prompt";

/**
 * The two summarization strategies, and the shape their caller cascades over.
 *
 * Both are allowed to fail: a provider that ignores `toolChoice`, a summary that comes back empty, a
 * request that turns out too large. Each failure is a value, never an exception, because the handler that
 * owns the cascade must be able to fall through to pi's own compaction rather than abort it.
 */

export type SummarizationStrategy = "native" | "serialized";

/**
 * What one strategy call returns: usable summary text, or the reason it is unusable.
 *
 * `usage` is reported on both arms — a response that ignored `tool_choice` still cost tokens, and that is
 * the evidence the trace wants. So is `stopReason`: the trace cannot tell a complete answer from one the
 * output limit cut off unless the provider's own word for it is carried out of the response.
 *
 * `cause` names *why* it failed, which is what decides whether the cascade may continue: context overflow and
 * exhausted quota both arrive as a failed request, and one is fixed by the next rung while the other is doomed
 * by it. `retries` counts the resends this function's caller performed, so an answer that arrived after two
 * backoffs is not silently reported as a clean one.
 */
export type SummarizationAttemptResult =
    | {
          ok: true;
          strategy: SummarizationStrategy;
          text: string;
          usage: Usage;
          stopReason: StopReason;
          /** An accepted answer failed nothing, so there is no cause to name. */
          retries: number;
      }
    | {
          ok: false;
          strategy: SummarizationStrategy;
          detail: string;
          usage?: Usage;
          stopReason?: StopReason;
          cause: SummarizationFailureCause;
          retries: number;
      };

/**
 * Backoff for the causes a wait can clear.
 *
 * `maxRetries` is attempts *after* the first, so the total is `maxRetries + 1`. `sleep` is overridable because
 * no test should spend real seconds proving a schedule, and because the abort behaviour has to be exercisable
 * without a race.
 */
export interface SummarizationRetryPolicy {
    maxRetries: number;
    baseDelayMs: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface SummarizationCall {
    registry: ModelRegistry;
    model: Model<Api>;
    maxTokens: number;
    signal?: AbortSignal;
    /** Session id for provider affinity. Omitted on one-off requests that can never reuse a cache. */
    sessionId?: string;
    /**
     * Inspects the assembled request body before it is sent. Returning undefined leaves it unchanged, which
     * is all the compaction trace ever does; used to compare our rebuilt prefix against the parent's.
     */
    onPayload?: (payload: unknown) => void;
    /** Absent means no retries, which is what a caller that has not decided on a budget should get. */
    retry?: SummarizationRetryPolicy;
}

function responseText(response: AssistantMessage): string {
    return response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function attemptedToolCall(response: AssistantMessage): string | undefined {
    const call = response.content.find((block) => block.type === "toolCall");
    if (!call || call.type !== "toolCall") {
        return undefined;
    }
    return call.name;
}

/**
 * Turn a provider response into summary text, rejecting anything that tried to keep working.
 *
 * We sit outside the agent loop, so a tool call in this response would never execute. That is not a
 * failure to paper over: a model that ignored `toolChoice: "none"` is a model that will also ignore the
 * rest of the directive, so the caller should cascade to the strategy that sends no tools at all.
 */
export function evaluateSummarizationResponse(
    response: AssistantMessage,
    strategy: SummarizationStrategy,
    classification: FailureClassificationInput,
): SummarizationAttemptResult {
    const { stopReason, usage } = response;
    if (stopReason === "error" || stopReason === "aborted") {
        const cause = classifySummarizationFailure(response, classification);
        return {
            ok: false,
            strategy,
            usage,
            stopReason,
            cause,
            retries: 0,
            detail: response.errorMessage ?? `summarization ${strategy} call ${stopReason}`,
        };
    }
    const tool = attemptedToolCall(response);
    if (tool) {
        return {
            ok: false,
            strategy,
            usage,
            stopReason,
            cause: "content",
            retries: 0,
            detail: `model called "${tool}" instead of summarizing; this provider does not honor tool_choice none`,
        };
    }
    // A reply cut off by the output limit is missing its tail, and for stage 1 that is the worst place to
    // discover it: the checkpoint is stage 2's input, so a section lost to the cut is lost from the session's
    // memory permanently, and the section guard cannot see it (the surviving headings still count). Stage 1 is
    // also the cheap rung - its context is cached - so cascading costs almost nothing. Stage 2 keeps the
    // truncated text, because the alternative is pi's own compaction, which re-summarizes from scratch under
    // no section contract at all; the trace records the stop reason so the report can flag it instead.
    if (stopReason === "length" && strategy === "native") {
        // Which of the two a `length` stop means is pi-ai's call, not ours: producing the budget it asked for is
        // a truncation, while stopping far short of it means the provider had nowhere left to write. The first
        // says the answer is incomplete, the second says the request was too big, and the cascade reads the
        // difference as `truncated` versus `overflow`.
        const cause = classifySummarizationFailure(response, classification);
        return {
            ok: false,
            strategy,
            usage,
            stopReason,
            cause,
            retries: 0,
            detail:
                cause === "overflow"
                    ? `summarization native call stopped at length after ${String(usage.output)} of ` +
                      `${String(classification.outputBudgetTokens)} requested output tokens, which reads as ` +
                      "context pressure rather than a long answer"
                    : `summarization native call hit the output limit after ${String(usage.output)} ` +
                      "output tokens; a truncated checkpoint loses the sections after the cut",
        };
    }
    const text = responseText(response).trim();
    if (!text) {
        return {
            ok: false,
            strategy,
            usage,
            stopReason,
            cause: "content",
            retries: 0,
            detail: "summarization returned an empty summary",
        };
    }

    // A reply that carries the demanded sections is the only thing the rest of the pipeline can use: the
    // headings are what `sections.ts` reads, so this is a usability check rather than a style one. It exists
    // because a real 2026-09-05 run answered with 35 tokens of "I don't have any prior thinking to
    // reproduce" - non-empty, fluent, and useless as the session's memory - and was accepted on that basis.
    // Rejecting cascades to the serialized strategy, the rung that can still produce something.
    const sections = checkpointSectionCount(text);
    if (sections < MIN_CHECKPOINT_SECTIONS) {
        return {
            ok: false,
            strategy,
            usage,
            stopReason,
            cause: "content",
            retries: 0,
            detail:
                `summarization ${strategy} answer carried ${String(sections)} of ` +
                `${String(MIN_CHECKPOINT_SECTIONS)} required sections: ${text.slice(0, 120)}`,
        };
    }

    return { ok: true, strategy, text, usage, stopReason, retries: 0 };
}

/**
 * Sleep that gives up when the signal fires.
 *
 * Resolves rather than rejecting on abort: the caller then reads `signal.aborted` and turns the attempt into an
 * `aborted` failure, which keeps the exit path a value like every other failure in this module.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }

        // Both bindings exist before either callback can fire, so each may name the other.
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** The delay before retry `index` (0-based), doubling from the policy's base. */
function backoffDelayMs(policy: SummarizationRetryPolicy, index: number): number {
    return policy.baseDelayMs * 2 ** index;
}

async function attemptOnce(
    call: SummarizationCall,
    context: Context,
    options: Record<string, unknown>,
    strategy: SummarizationStrategy,
): Promise<SummarizationAttemptResult> {
    const classification: FailureClassificationInput = {
        contextWindow: call.model.contextWindow,
        outputBudgetTokens: call.maxTokens,
    };

    try {
        const response = await call.registry.complete(call.model, context, options);
        return evaluateSummarizationResponse(response, strategy, classification);
    } catch (error) {
        // No response at all, so there is no stop reason to report either. pi-ai normalizes provider failures
        // into an `AssistantMessage`, so reaching this arm means something threw before or after the wire —
        // which is why its cause stays `unknown` and the policy that follows from it sends no blind resend.
        return {
            ok: false,
            strategy,
            cause: UNCLASSIFIED_THROWN_ERROR,
            retries: 0,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Ask the provider once, or as often as the cause and the budget justify.
 *
 * Only `transient` failures are resent: every other cause is deterministic in something we cannot change by
 * trying again — the bytes we sent, the window, the credentials, the account's balance. The schedule is
 * exponential from the policy's base delay, and an abort arriving during the wait ends the attempt as
 * `aborted` rather than as a provider failure, because that is what it was.
 */
async function callForSummary(
    call: SummarizationCall,
    context: Context,
    options: Record<string, unknown>,
    strategy: SummarizationStrategy,
): Promise<SummarizationAttemptResult> {
    const policy = call.retry;
    const maxRetries = policy?.maxRetries ?? 0;
    let retries = 0;

    for (;;) {
        const result = await attemptOnce(call, context, options, strategy);
        if (result.ok) {
            return { ...result, retries };
        }

        if (summarizationFailureAction(result.cause).retry && policy && retries < maxRetries) {
            await (policy.sleep ?? abortableSleep)(backoffDelayMs(policy, retries), call.signal);
            retries++;

            if (call.signal?.aborted) {
                return {
                    ...result,
                    cause: "aborted",
                    retries,
                    detail: `aborted during the retry backoff: ${result.detail}`,
                };
            }
            continue;
        }

        return { ...result, retries };
    }
}

/** Continue the live conversation with a summarize instruction and no usable tools. */
export async function summarizeNatively(
    call: SummarizationCall,
    context: Context,
): Promise<SummarizationAttemptResult> {
    return callForSummary(
        call,
        context,
        {
            maxTokens: call.maxTokens,
            signal: call.signal,
            ...(call.onPayload
                ? {
                      onPayload: (payload: unknown) => {
                          call.onPayload?.(payload);
                          return undefined;
                      },
                  }
                : {}),
            // The field every capable provider understands; the instruction message is the backstop for
            // the ones that do not, and a tool call in the response cascades us off this path.
            toolChoice: "none",
            ...(call.sessionId ? { sessionId: call.sessionId } : {}),
        },
        "native",
    );
}

export interface SerializedTranscriptInput {
    /** The minimized transcript, built by the caller so the trace can see the same text that is sent. */
    conversationText: string;
    /** The complete request text: transcript, prior summary, format, and focus. */
    requestText: string;
}

/** One-off standalone request over a minimized transcript: no cache prefix to protect, no tools to forbid. */
export async function summarizeSerializedTranscript(
    call: SummarizationCall,
    input: SerializedTranscriptInput,
): Promise<SummarizationAttemptResult> {
    const context: Context = {
        systemPrompt: SERIALIZATION_SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: input.requestText }],
                timestamp: Date.now(),
            },
        ],
    };
    return callForSummary(
        call,
        context,
        {
            maxTokens: call.maxTokens,
            signal: call.signal,
            cacheRetention: "none",
            sessionId: uuidv7(),
        },
        "serialized",
    );
}
