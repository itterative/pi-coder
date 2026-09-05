import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SERIALIZATION_SYSTEM_PROMPT } from "./prompt";

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
 * the evidence the trace wants.
 */
export type SummarizationAttemptResult =
    | { ok: true; strategy: SummarizationStrategy; text: string; usage: Usage }
    | { ok: false; strategy: SummarizationStrategy; detail: string; usage?: Usage };

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
): SummarizationAttemptResult {
    if (response.stopReason === "error" || response.stopReason === "aborted") {
        return {
            ok: false,
            strategy,
            usage: response.usage,
            detail:
                response.errorMessage ?? `summarization ${strategy} call ${response.stopReason}`,
        };
    }
    const tool = attemptedToolCall(response);
    if (tool) {
        return {
            ok: false,
            strategy,
            usage: response.usage,
            detail: `model called "${tool}" instead of summarizing; this provider does not honor tool_choice none`,
        };
    }
    const text = responseText(response).trim();
    if (!text) {
        return {
            ok: false,
            strategy,
            usage: response.usage,
            detail: "summarization returned an empty summary",
        };
    }
    return { ok: true, strategy, text, usage: response.usage };
}

async function callForSummary(
    call: SummarizationCall,
    context: Context,
    options: Record<string, unknown>,
    strategy: SummarizationStrategy,
): Promise<SummarizationAttemptResult> {
    try {
        const response = await call.registry.complete(call.model, context, options);
        return evaluateSummarizationResponse(response, strategy);
    } catch (error) {
        return {
            ok: false,
            strategy,
            detail: error instanceof Error ? error.message : String(error),
        };
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
