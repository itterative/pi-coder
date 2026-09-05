import type { Usage } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    FileOperations,
    SessionBeforeCompactEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { CompactionPreparation, ContextMessage } from "../../src/modules/compaction/types";
import { zeroUsage } from "./agent-doubles";

/**
 * Context-message, compaction-preparation, and provider-response doubles for the compaction module.
 *
 * The message shapes come from pi's own union (`AgentMessage` reaches it only through a declaration merge
 * inside pi-coding-agent), so building them literally here means a pi-side field change fails a suite
 * instead of quietly serializing `undefined`.
 */

const ENTRY_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export function userMessage(text: string, timestamp = 0): ContextMessage {
    return { role: "user", content: text, timestamp };
}

export interface AssistantCallFixture {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
}

export interface AssistantFixture {
    text?: string;
    thinking?: string;
    calls?: AssistantCallFixture[];
    stopReason?: AssistantMessage["stopReason"];
}

export function assistantMessage(fixture: AssistantFixture, timestamp = 0): ContextMessage {
    const content: AssistantMessage["content"] = [];
    if (fixture.thinking) {
        content.push({ type: "thinking", thinking: fixture.thinking });
    }
    if (fixture.text) {
        content.push({ type: "text", text: fixture.text });
    }
    for (const call of fixture.calls ?? []) {
        content.push({
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? {},
        });
    }
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "stub-model",
        usage: zeroUsage(),
        stopReason: fixture.stopReason ?? "stop",
        timestamp,
    };
}

export function toolResultMessage(input: {
    callId: string;
    tool: string;
    text: string;
    isError?: boolean;
    timestamp?: number;
}): ContextMessage {
    return {
        role: "toolResult",
        toolCallId: input.callId,
        toolName: input.tool,
        content: [{ type: "text", text: input.text }],
        isError: input.isError ?? false,
        timestamp: input.timestamp ?? 0,
    };
}

export function bashExecutionMessage(input: {
    command: string;
    output?: string;
    exitCode?: number;
    cancelled?: boolean;
    excludeFromContext?: boolean;
}): ContextMessage {
    return {
        role: "bashExecution",
        command: input.command,
        output: input.output ?? "",
        exitCode: input.exitCode,
        cancelled: input.cancelled ?? false,
        truncated: false,
        excludeFromContext: input.excludeFromContext,
        timestamp: 0,
    };
}

export function customMessage(customType: string, text: string, display: boolean): ContextMessage {
    return { role: "custom", customType, content: text, display, timestamp: 0 };
}

export function compactionSummaryMessage(summary: string, tokensBefore = 1000): ContextMessage {
    return { role: "compactionSummary", summary, tokensBefore, timestamp: 0 };
}

export function messageEntry(
    id: string,
    message: ContextMessage,
    parentId: string | null = null,
): SessionEntry {
    return { type: "message", id, parentId, timestamp: ENTRY_TIMESTAMP, message };
}

/**
 * A linear branch. pi walks the leaf path through `parentId`, so entries left unlinked read as separate
 * branches and only the last one survives into the context.
 */
export function messageChain(
    items: Array<{ id: string; message: ContextMessage }>,
): SessionEntry[] {
    let parentId: string | null = null;
    return items.map((item) => {
        const entry = messageEntry(item.id, item.message, parentId);
        parentId = item.id;
        return entry;
    });
}

export function fileOperations(overrides: Partial<FileOperations> = {}): FileOperations {
    return {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
        ...overrides,
    };
}

export function compactionPreparation(
    overrides: Partial<CompactionPreparation> = {},
): CompactionPreparation {
    return {
        firstKeptEntryId: "kept-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 190_000,
        fileOps: fileOperations(),
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        ...overrides,
    };
}

export function compactEvent(
    overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
    return {
        type: "session_before_compact",
        preparation: compactionPreparation(),
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
        ...overrides,
    };
}

/** A provider response carrying only summary text. */
export function summaryResponse(text: string, usage?: Usage): AssistantMessage {
    return assistantResponse([{ type: "text", text }], usage);
}

/** A provider response that tried to keep working instead of summarizing. */
export function toolCallResponse(name = "read"): AssistantMessage {
    return assistantResponse([
        { type: "text", text: "let me look" },
        { type: "toolCall", id: "call-1", name, arguments: { path: "src/index.ts" } },
    ]);
}

function assistantResponse(content: AssistantMessage["content"], usage?: Usage): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "stub-model",
        usage: usage ?? zeroUsage(),
        stopReason: "stop",
        timestamp: 0,
    };
}
