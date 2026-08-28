import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { AgentTraceData } from "../contracts/trace";
import type { ChildProgress, ParentQuestion } from "../contracts/runs";
import type { WorkerMutationReport } from "../contracts/mutations";
import { ZERO_USAGE } from "../runs/usage";

const MAX_RECENT_ACTIVITY = 8;
const UPDATE_THROTTLE_MS = 100;

export interface ChildProgressTracker {
    progress: ChildProgress;
    pendingQuestion?: ParentQuestion;
    lastUpdateAt: number;
    changedFiles: Set<string>;
    readFiles: Set<string>;
    bashApproved: boolean;
    interrupted: boolean;
}

export function textFromAssistantMessage(message: unknown): string {
    if (!message || typeof message !== "object" || !("content" in message)) return "";
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } => (
            typeof part === "object"
            && part !== null
            && (part as { type?: unknown }).type === "text"
            && typeof (part as { text?: unknown }).text === "string"
        ))
        .map((part) => part.text)
        .join("");
}

function cloneUsage(usage: Usage): Usage {
    return { ...usage, cost: { ...usage.cost } };
}

export function aggregateUsage(session: AgentSession): Usage {
    const total = cloneUsage(ZERO_USAGE);
    let sawReasoning = false;
    let sawCacheWrite1h = false;

    for (const entry of session.sessionManager.getBranch()) {
        let usage: Usage | undefined;
        if (entry.type === "message" && "usage" in entry.message) {
            usage = entry.message.usage;
        } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
            usage = entry.usage;
        }
        if (!usage) continue;

        total.input += usage.input;
        total.output += usage.output;
        total.cacheRead += usage.cacheRead;
        total.cacheWrite += usage.cacheWrite;
        total.totalTokens += usage.totalTokens;
        total.cost.input += usage.cost.input;
        total.cost.output += usage.cost.output;
        total.cost.cacheRead += usage.cost.cacheRead;
        total.cost.cacheWrite += usage.cost.cacheWrite;
        total.cost.total += usage.cost.total;
        if (usage.reasoning !== undefined) {
            sawReasoning = true;
            total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
        }
        if (usage.cacheWrite1h !== undefined) {
            sawCacheWrite1h = true;
            total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
        }
    }

    if (!sawReasoning) delete total.reasoning;
    if (!sawCacheWrite1h) delete total.cacheWrite1h;
    return total;
}

export function childError(session: AgentSession): string | undefined {
    const assistant = [...session.state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") return session.state.errorMessage;

    if (assistant.stopReason === "error") {
        return assistant.errorMessage ?? session.state.errorMessage ?? "Child model request failed.";
    }
    if (assistant.stopReason === "length") return "Child response hit the model output limit.";
    if (assistant.stopReason === "aborted") return "Child model request was aborted.";
    if (assistant.stopReason === "deferred" || assistant.stopReason === "pending") {
        return `Unsupported child response state: ${assistant.stopReason}.`;
    }
    return undefined;
}

function tracePreview(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function traceToolArgs(toolName: string, args: unknown): AgentTraceData {
    if (!args || typeof args !== "object") return {};
    const input = args as Record<string, unknown>;
    const pathValue = typeof input.path === "string" ? input.path : "";
    if (toolName === "read") {
        return {
            path: pathValue,
            offset: typeof input.offset === "number" ? input.offset : 0,
            limit: typeof input.limit === "number" ? input.limit : 0,
        };
    }
    if (toolName === "grep" || toolName === "find") {
        const pattern = typeof input.pattern === "string" ? input.pattern : "";
        return { path: pathValue, patternPreview: tracePreview(pattern, 120) };
    }
    if (toolName === "ls") return { path: pathValue };
    if (toolName === "edit") {
        return {
            path: pathValue,
            replacementCount: Array.isArray(input.edits) ? input.edits.length : 0,
        };
    }
    if (toolName === "write") {
        return { path: pathValue, contentChars: typeof input.content === "string" ? input.content.length : 0 };
    }
    if (toolName === "bash") {
        return { commandChars: typeof input.command === "string" ? input.command.length : 0 };
    }
    if (toolName === "ask_user") {
        return {
            titlePreview: tracePreview(typeof input.title === "string" ? input.title : "", 120),
            optionCount: Array.isArray(input.options) ? input.options.length : 0,
        };
    }
    if (toolName === "ask_parent") {
        return {
            questionPreview: tracePreview(
                typeof input.question === "string" ? input.question : "",
                120,
            ),
            optionCount: Array.isArray(input.options) ? input.options.length : 0,
        };
    }
    return { argumentKeys: Object.keys(input).sort().join(",") };
}

function traceResultChars(result: unknown): number {
    if (!result || typeof result !== "object") return 0;
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return 0;
    return content.reduce((total, part) => {
        if (!part || typeof part !== "object") return total;
        const text = (part as { text?: unknown }).text;
        return total + (typeof text === "string" ? text.length : 0);
    }, 0);
}

export function traceSessionEvent(
    event: AgentSessionEvent,
): { type: string; data?: AgentTraceData } | undefined {
    if (event.type === "agent_start" || event.type === "turn_start" || event.type === "agent_settled") {
        return { type: `session.${event.type}` };
    }
    if (event.type === "agent_end") {
        return {
            type: "session.agent_end",
            data: { messageCount: event.messages.length, willRetry: event.willRetry },
        };
    }
    if (event.type === "turn_end") {
        return {
            type: "session.turn_end",
            data: {
                role: event.message.role,
                toolResultCount: event.toolResults.length,
            },
        };
    }
    if (event.type === "message_start" || event.type === "message_end") {
        const role = event.message.role;
        const text = textFromAssistantMessage(event.message);
        return {
            type: `session.${event.type}`,
            data: {
                role,
                textChars: text.length,
                ...(role === "assistant" && event.type === "message_end"
                    ? { textPreview: tracePreview(text) }
                    : {}),
            },
        };
    }
    if (event.type === "tool_execution_start") {
        return {
            type: "session.tool_start",
            data: { tool: event.toolName, ...traceToolArgs(event.toolName, event.args) },
        };
    }
    if (event.type === "tool_execution_end") {
        const result = event.result as { terminate?: unknown; details?: unknown } | undefined;
        const details = result?.details && typeof result.details === "object"
            ? result.details as Record<string, unknown>
            : undefined;
        return {
            type: "session.tool_end",
            data: {
                tool: event.toolName,
                isError: event.isError,
                terminate: result?.terminate === true,
                resultChars: traceResultChars(event.result),
                canceled: details?.canceled === true,
                unavailable: details?.unavailable === true,
            },
        };
    }
    if (event.type === "compaction_start" || event.type === "compaction_end") {
        return { type: `session.${event.type}`, data: { reason: event.reason } };
    }
    return undefined;
}

function toolActivity(toolName: string, args: unknown): string {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const filePath = tracePreview(typeof input.path === "string" ? input.path : ".", 80);
    if (toolName === "read") return `Reading ${filePath}`;
    if (toolName === "grep") {
        const pattern = tracePreview(typeof input.pattern === "string" ? input.pattern : "", 60);
        return `Searching ${pattern ? JSON.stringify(pattern) : "files"} in ${filePath}`;
    }
    if (toolName === "find") {
        const pattern = tracePreview(typeof input.pattern === "string" ? input.pattern : "", 60);
        return `Finding ${pattern ? JSON.stringify(pattern) : "entries"} in ${filePath}`;
    }
    if (toolName === "ls") return `Listing ${filePath}`;
    if (toolName === "edit") return `Editing ${filePath}`;
    if (toolName === "write") return `Writing ${filePath}`;
    if (toolName === "bash") return "Running approved bash command";
    if (toolName === "ask_parent") return "Requesting parent guidance";
    if (toolName === "ask_user") return "Requesting user guidance";
    return `Using ${toolName}`;
}

export function reportProgress(
    tracker: ChildProgressTracker,
    onProgress: (progress: ChildProgress) => void,
): void {
    onProgress({
        output: tracker.progress.output,
        ...(tracker.progress.lastAssistantMessage
            ? { lastAssistantMessage: tracker.progress.lastAssistantMessage }
            : {}),
        recentActivity: [...tracker.progress.recentActivity],
        ...(tracker.progress.phase ? { phase: tracker.progress.phase } : {}),
        ...(tracker.progress.lastToolActivity ? { lastToolActivity: tracker.progress.lastToolActivity } : {}),
        ...(tracker.progress.toolCounts ? { toolCounts: { ...tracker.progress.toolCounts } } : {}),
        ...(tracker.progress.failedToolCalls !== undefined
            ? { failedToolCalls: tracker.progress.failedToolCalls }
            : {}),
        permissionPending: tracker.progress.permissionPending,
        ...(tracker.progress.todo ? { todo: { ...tracker.progress.todo } } : {}),
    });
}

export function updateTracker(
    event: AgentSessionEvent,
    tracker: ChildProgressTracker,
    onProgress: (progress: ChildProgress) => void,
): void {
    let forceUpdate = false;
    if (event.type === "message_start" && event.message.role === "assistant") {
        forceUpdate = true;
        if (tracker.progress.output.trim()) {
            tracker.progress.lastAssistantMessage = tracker.progress.output;
        }
        tracker.progress.output = textFromAssistantMessage(event.message);
        tracker.progress.phase = "Thinking";
        tracker.progress.recentActivity.push("Thinking");
        tracker.progress.recentActivity = tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
    } else if (
        event.type === "message_update"
        && event.message.role === "assistant"
        && event.assistantMessageEvent.type === "thinking_start"
    ) {
        forceUpdate = true;
        tracker.progress.phase = "Thinking";
    } else if (
        event.type === "message_update"
        && event.message.role === "assistant"
        && event.assistantMessageEvent.type === "text_delta"
    ) {
        tracker.progress.output += event.assistantMessageEvent.delta;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
        tracker.progress.output = textFromAssistantMessage(event.message);
        if (tracker.progress.output.trim()) {
            tracker.progress.lastAssistantMessage = tracker.progress.output;
        }
    } else if (event.type === "tool_execution_start") {
        forceUpdate = true;
        const activity = toolActivity(event.toolName, event.args);
        tracker.progress.lastToolActivity = activity;
        tracker.progress.toolCounts ??= {};
        tracker.progress.toolCounts[event.toolName] = (tracker.progress.toolCounts[event.toolName] ?? 0) + 1;
        tracker.progress.recentActivity.push(activity);
        tracker.progress.recentActivity = tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
    } else if (event.type === "tool_execution_end" && event.isError) {
        tracker.progress.failedToolCalls = (tracker.progress.failedToolCalls ?? 0) + 1;
        forceUpdate = true;
    } else {
        return;
    }

    const now = Date.now();
    if (forceUpdate || now - tracker.lastUpdateAt >= UPDATE_THROTTLE_MS) {
        tracker.lastUpdateAt = now;
        reportProgress(tracker, onProgress);
    }
}

