import { collapseWhitespace, truncateHead } from "./text";
import type { ContextMessage } from "./types";

/**
 * Deterministic parts of the summary, computed from the transcript rather than recalled by the model.
 *
 * Everything here is mechanically knowable from the span pi is about to discard: which tools ran and how
 * often, which calls failed, what the user literally asked for, which delegated run ids appeared. Asking a
 * model to reproduce those from memory is how compaction drifts, and a wrong count is worse than no count,
 * because it reads as authority. The model is only asked for the judgement-bearing sections.
 */

const RECENT_REQUEST_COUNT = 3;
const RECENT_REQUEST_CHARS = 400;
const LEDGER_TITLE_CHARS = 80;

export interface ToolTally {
    calls: number;
    failed: number;
}

export interface DelegatedRunCall {
    action?: string;
    agent?: string;
    title?: string;
    runId?: string;
}

export interface SpanAnalysis {
    /** User requests in chronological order, whitespace-collapsed. */
    userRequests: string[];
    tools: Map<string, ToolTally>;
    agentCalls: DelegatedRunCall[];
    agentRunIds: Set<string>;
    messageCount: number;
    toolCallCount: number;
    failedToolCallCount: number;
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tally(tools: Map<string, ToolTally>, name: string, field: "calls" | "failed"): void {
    const entry = tools.get(name) ?? { calls: 0, failed: 0 };
    entry[field] += 1;
    tools.set(name, entry);
}

export function analyzeSpan(messages: ContextMessage[]): SpanAnalysis {
    const tools = new Map<string, ToolTally>();
    const agentCalls: DelegatedRunCall[] = [];
    const agentRunIds = new Set<string>();
    const userRequests: string[] = [];
    const failedCallIds = new Set<string>();
    const namesByCallId = new Map<string, string>();
    let toolCallCount = 0;

    for (const message of messages) {
        if (message.role === "user") {
            const text = textOf(message.content);
            if (text.trim()) {
                userRequests.push(collapseWhitespace(text));
            }
            continue;
        }
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type !== "toolCall") {
                    continue;
                }
                toolCallCount += 1;
                namesByCallId.set(block.id, block.name);
                tally(tools, block.name, "calls");
                const args: Record<string, unknown> = block.arguments ?? {};
                if (block.name !== "agent") {
                    continue;
                }
                recordAgentCall(args, agentCalls, agentRunIds);
            }
            continue;
        }
        if (message.role === "toolResult" && message.isError) {
            failedCallIds.add(message.toolCallId);
        }
    }

    for (const callId of failedCallIds) {
        const name = namesByCallId.get(callId);
        if (name) {
            tally(tools, name, "failed");
        }
    }

    return {
        userRequests,
        tools,
        agentCalls,
        agentRunIds,
        messageCount: messages.length,
        toolCallCount,
        failedToolCallCount: failedCallIds.size,
    };
}

function recordAgentCall(
    args: Record<string, unknown>,
    agentCalls: DelegatedRunCall[],
    agentRunIds: Set<string>,
): void {
    const call: DelegatedRunCall = {};
    const action = stringField(args, "action");
    const agent = stringField(args, "agent");
    const title = stringField(args, "title");
    const runId = stringField(args, "runId");
    if (action) {
        call.action = action;
    }
    if (agent) {
        call.agent = agent;
    }
    if (title) {
        call.title = title;
    }
    if (runId) {
        call.runId = runId;
        agentRunIds.add(runId);
    }
    agentCalls.push(call);
}

/** pi's `TextContent | ImageContent[]` union, narrowed only on the `type` this reader cares about. */
type TextPart = { type: string; text?: string };

function textOf(content: string | readonly TextPart[] | undefined): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function verbatimRequests(analysis: SpanAnalysis): string {
    const recent = analysis.userRequests.slice(-RECENT_REQUEST_COUNT);
    if (recent.length === 0) {
        return "";
    }
    const lines = recent.map((request) => `- "${truncateHead(request, RECENT_REQUEST_CHARS)}"`);
    return ["## Verbatim Recent Requests", ...lines].join("\n");
}

function ledgerLines(analysis: SpanAnalysis): string {
    if (analysis.tools.size === 0) {
        return "";
    }
    const entries = [...analysis.tools.entries()].sort((a, b) => b[1].calls - a[1].calls);
    const parts = entries.map(([name, tallyEntry]) => {
        const failed = tallyEntry.failed > 0 ? `, ${String(tallyEntry.failed)} failed` : "";
        return `${name} x${String(tallyEntry.calls)}${failed}`;
    });
    const totals =
        `total ${String(analysis.toolCallCount)} tool calls, ` +
        `${String(analysis.failedToolCallCount)} failed`;
    return ["## Tool Ledger", ...parts.map((part) => `- ${part}`), `- ${totals}`].join("\n");
}

function delegatedRuns(analysis: SpanAnalysis): string {
    if (analysis.agentCalls.length === 0) {
        return "";
    }
    const lines: string[] = [];
    for (const call of analysis.agentCalls.slice(-RECENT_REQUEST_COUNT * 2)) {
        const details = [
            call.action,
            call.agent,
            call.title && truncateHead(call.title, LEDGER_TITLE_CHARS),
        ]
            .filter((part): part is string => Boolean(part))
            .join(" ");
        lines.push(`- ${details}${call.runId ? ` [${call.runId}]` : ""}`);
    }
    const ids = [...analysis.agentRunIds].slice(0, RECENT_REQUEST_COUNT * 2);
    if (ids.length > 0) {
        lines.push(`- run ids seen: ${ids.join(", ")}`);
        lines.push('- recover later ids with agent(action="list")');
    }
    return ["## Delegated Runs", ...lines].join("\n");
}

export interface SupplementarySectionInput {
    analysis: SpanAnalysis;
    firstKeptEntryId: string;
    /** Blocks the serializer had to drop from the oldest end to fit its budget. */
    droppedBlocks: number;
}

export function buildSupplementarySections(input: SupplementarySectionInput): string {
    const dropped =
        `## Dropped Context\n- ${String(input.analysis.messageCount)} messages were summarized ` +
        `into this checkpoint; context resumes at entry ${input.firstKeptEntryId}.`;
    const omitted =
        input.droppedBlocks > 0
            ? `\n- ${String(input.droppedBlocks)} older message blocks were left out of the summarization ` +
              "request itself, so they are not represented here."
            : "";
    const sections = [
        verbatimRequests(input.analysis),
        ledgerLines(input.analysis),
        delegatedRuns(input.analysis),
        `${dropped}${omitted}`,
    ];
    return sections.filter((section) => section.length > 0).join("\n\n");
}

/** pi's own file-list tail, reproduced so `<read-files>` and `<modified-files>` stay parseable downstream. */
export function formatFileLists(readFiles: string[], modifiedFiles: string[]): string {
    const sections: string[] = [];
    if (readFiles.length > 0) {
        sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
    }
    if (modifiedFiles.length > 0) {
        sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
    }
    if (sections.length === 0) {
        return "";
    }
    return `\n\n${sections.join("\n\n")}`;
}

export function computeFileLists(fileOps: {
    read: Set<string>;
    written: Set<string>;
    edited: Set<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
    const modified = new Set([...fileOps.edited, ...fileOps.written]);
    const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
    const modifiedFiles = [...modified].sort();
    return { readFiles, modifiedFiles };
}
