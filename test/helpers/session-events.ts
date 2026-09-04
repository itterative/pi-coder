import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { zeroUsage } from "./agent-doubles";

/**
 * Builders for the `AgentSessionEvent` variants a child tracker consumes.
 *
 * `updateTracker` reads three fields off a message-update event and two off a tool-execution event, but
 * pi's variants require a full `AssistantMessage` (`api`, `provider`, `model`, `usage`, `stopReason`) and a
 * stream event carrying `contentIndex` plus a `partial` message. Hand-written partials therefore reached for
 * `as any`, which also silenced the field names the tests actually depend on. These builders fill the
 * envelope from real pi types and keep the interesting fields as arguments.
 *
 * Every type below is **derived** from the exported `AgentSessionEvent` union rather than imported from
 * `pi-ai`, so a pi re-shape surfaces here instead of in each suite.
 */

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;
type AssistantStreamEvent = MessageUpdate["assistantMessageEvent"];
type AssistantMessageValue = Extract<AssistantStreamEvent, { type: "text_delta" }>["partial"];

/** A minimal assistant message; override `content` to drive the text-extraction path. */
function assistantMessage(overrides: Partial<AssistantMessageValue> = {}): AssistantMessageValue {
    return {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test-model",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
        ...overrides,
    } as AssistantMessageValue;
}

/** `message_start` for an assistant turn, which is what flips the tracker into a streaming phase. */
export function messageStartEvent(message: Partial<AssistantMessageValue> = {}): AgentSessionEvent {
    return { type: "message_start", message: assistantMessage(message) };
}

/**
 * Assemble one stream event. pi's variant union cannot be built generically — each member has a
 * different required payload (`toolcall_end` needs `toolCall`, the deltas need `delta`) — so the named
 * builders below supply the payload and this is the single place the envelope is asserted.
 */
function streamEvent(event: Record<string, unknown>): AssistantStreamEvent {
    return event as AssistantStreamEvent;
}

function messageUpdate(
    assistantEvent: AssistantStreamEvent,
    message: AssistantMessageValue,
): AgentSessionEvent {
    return { type: "message_update", message, assistantMessageEvent: assistantEvent };
}

/** Assistant text arriving incrementally. */
export function textDeltaEvent(delta: string): AgentSessionEvent {
    return messageUpdate(
        streamEvent({ type: "text_delta", contentIndex: 0, delta, partial: assistantMessage() }),
        assistantMessage(),
    );
}

/** Reasoning arriving incrementally; the tracker must count it without exposing the text. */
export function thinkingDeltaEvent(delta: string): AgentSessionEvent {
    return messageUpdate(
        streamEvent({
            type: "thinking_delta",
            contentIndex: 0,
            delta,
            partial: assistantMessage(),
        }),
        assistantMessage(),
    );
}

/** `tool_execution_start`, where the tracker records the tool name and its running counts. */
export function toolExecutionStartEvent(
    toolName: string,
    args: Record<string, unknown> = {},
    toolCallId = "call-1",
): AgentSessionEvent {
    return { type: "tool_execution_start", toolCallId, toolName, args };
}

/** `tool_execution_end`; `isError` is what the tracker counts as a failed tool call. */
export function toolExecutionEndEvent(
    toolName: string,
    options: { isError?: boolean; toolCallId?: string; result?: unknown } = {},
): AgentSessionEvent {
    return {
        type: "tool_execution_end",
        toolCallId: options.toolCallId ?? "call-1",
        toolName,
        result: options.result ?? "done",
        isError: options.isError ?? false,
    };
}
