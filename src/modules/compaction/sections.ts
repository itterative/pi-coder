import { collapseWhitespace, truncateHead } from "./text";
import type { ContextMessage } from "./types";

/**
 * Deterministic parts of the summary, computed from the transcript rather than recalled by the model.
 *
 * Everything here is mechanically knowable from the span pi is about to discard: what the user literally asked
 * for and which delegated run ids appeared. Asking a model to reproduce those from memory is how compaction
 * drifts, and a wrong identifier is worse than no identifier, because it reads as authority. The model is only
 * asked for the judgement-bearing sections.
 */

const RECENT_REQUEST_COUNT = 3;
const RECENT_REQUEST_CHARS = 400;
const RUN_TITLE_CHARS = 80;

export interface DelegatedRunCall {
    action?: string;
    agent?: string;
    title?: string;
    runId?: string;
}

export interface SpanAnalysis {
    /** User requests in chronological order, whitespace-collapsed. */
    userRequests: string[];
    agentCalls: DelegatedRunCall[];
    agentRunIds: Set<string>;
    messageCount: number;
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function analyzeSpan(messages: ContextMessage[]): SpanAnalysis {
    const agentCalls: DelegatedRunCall[] = [];
    const agentRunIds = new Set<string>();
    const userRequests: string[] = [];

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
                const args: Record<string, unknown> = block.arguments ?? {};
                if (block.name !== "agent") {
                    continue;
                }
                recordAgentCall(args, agentCalls, agentRunIds);
            }
        }
    }

    return {
        userRequests,
        agentCalls,
        agentRunIds,
        messageCount: messages.length,
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

function delegatedRuns(analysis: SpanAnalysis): string {
    if (analysis.agentCalls.length === 0) {
        return "";
    }
    const lines: string[] = [];
    for (const call of analysis.agentCalls.slice(-RECENT_REQUEST_COUNT * 2)) {
        const details = [
            call.action,
            call.agent,
            call.title && truncateHead(call.title, RUN_TITLE_CHARS),
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
    const folded = `## Context Fold\n- ${String(input.analysis.messageCount)} messages were folded into this checkpoint.`;
    const omitted =
        input.droppedBlocks > 0
            ? `\n- ${String(input.droppedBlocks)} older message blocks were omitted from the summarization ` +
              "input, so this checkpoint may not reflect them."
            : "";
    // Neither the model that wrote this checkpoint nor the reader of it saw the retained turns, and the reader
    // sees them immediately after the summary. Their provenance has to be stated deterministically, or the
    // turns read as the continuation of the summary rather than as history that predates it.
    const retained =
        "\n- The messages that follow were kept verbatim from before this compaction: newer than everything " +
        "summarized here, older than the current turn, and not summarized themselves. The conversation " +
        `resumes at entry ${input.firstKeptEntryId}.`;
    const sections = [
        verbatimRequests(input.analysis),
        delegatedRuns(input.analysis),
        `${folded}${omitted}${retained}`,
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
