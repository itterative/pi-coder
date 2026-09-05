import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SERIALIZATION_SYSTEM_PROMPT, serializedSummarizationRequest } from "./prompt";

/**
 * The two summarization strategies, and the shape their caller cascades over.
 *
 * Both are allowed to fail: a provider that ignores `toolChoice`, a summary that comes back empty, a
 * request that turns out too large. Each failure is a value, never an exception, because the handler that
 * owns the cascade must be able to fall through to pi's own compaction rather than abort it.
 */

export type SummarizationStrategy = "native" | "serialized";

export interface SummarizationAttempt {
    ok: boolean;
    strategy: SummarizationStrategy;
    /** Why this attempt is unusable; surfaced in the UI notice when the whole cascade fails. */
    detail?: string;
    result?: CompactionResult;
}

export interface FailedAttempt extends SummarizationAttempt {
    ok: false;
}

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface SummarizationCall {
    registry: ModelRegistry;
    model: Model<Api>;
    maxTokens: number;
    signal?: AbortSignal;
    /** Session id for provider affinity. Omitted on one-off requests that can never reuse a cache. */
    sessionId?: string;
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
): { ok: true; text: string; usage: Usage } | FailedAttempt {
    if (response.stopReason === "error" || response.stopReason === "aborted") {
        return {
            ok: false,
            strategy,
            detail:
                response.errorMessage ?? `summarization ${strategy} call ${response.stopReason}`,
        };
    }
    const tool = attemptedToolCall(response);
    if (tool) {
        return {
            ok: false,
            strategy,
            detail: `model called "${tool}" instead of summarizing; this provider does not honor tool_choice none`,
        };
    }
    const text = responseText(response).trim();
    if (!text) {
        return { ok: false, strategy, detail: "summarization returned an empty summary" };
    }
    return { ok: true, text, usage: response.usage };
}

async function callForSummary(
    call: SummarizationCall,
    context: Context,
    options: Record<string, unknown>,
    strategy: SummarizationStrategy,
): Promise<{ ok: true; text: string; usage: Usage } | FailedAttempt> {
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
): Promise<{ ok: true; text: string; usage: Usage } | FailedAttempt> {
    return callForSummary(
        call,
        context,
        {
            maxTokens: call.maxTokens,
            signal: call.signal,
            // The field every capable provider understands; the instruction message is the backstop for
            // the ones that do not, and a tool call in the response cascades us off this path.
            toolChoice: "none",
            ...(call.sessionId ? { sessionId: call.sessionId } : {}),
        },
        "native",
    );
}

export interface SerializedTranscriptInput {
    conversationText: string;
    previousSummary?: string;
    customInstructions?: string;
}

/** One-off standalone request over a minimized transcript: no cache prefix to protect, no tools to forbid. */
export async function summarizeSerializedTranscript(
    call: SummarizationCall,
    input: SerializedTranscriptInput,
): Promise<{ ok: true; text: string; usage: Usage } | FailedAttempt> {
    const request = serializedSummarizationRequest({
        conversationText: input.conversationText,
        previousSummary: input.previousSummary,
        customInstructions: input.customInstructions,
    });
    const context: Context = {
        systemPrompt: SERIALIZATION_SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: request }],
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
