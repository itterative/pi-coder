import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type DisplayContent = string | (TextContent | ImageContent)[];
type ToolArguments = Record<string, unknown>;

export type AgentTranscriptView = "collapsed" | "detailed";

export interface AgentSessionTranscriptViews {
    collapsed: string;
    detailed: string;
}

interface ToolCallDisplay {
    name: string;
    args: ToolArguments;
    failed: boolean;
}

interface TranscriptPart {
    text: string;
    toolOnly: boolean;
    toolCalls?: ToolCallDisplay[];
}

function contentText(content: DisplayContent): string {
    if (typeof content === "string") {
        return content;
    }
    return content.map((block) => (
        block.type === "text" ? block.text : `[image: ${block.mimeType}]`
    )).join("\n");
}

function quoteText(text: string): string {
    return text.split("\n").map((line) => `> ${line}`).join("\n");
}

function stringArgument(args: ToolArguments, name: string): string | undefined {
    const value = args[name];
    if (typeof value !== "string") {
        return undefined;
    }
    return value;
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function changeLines(prefix: "+" | "-", text: string): string[] {
    return text.split("\n").map((line) => `  ${prefix} ${line}`);
}

function editCall(args: ToolArguments, prefix: string): string[] {
    const lines = [`${prefix} edit ${stringArgument(args, "path") ?? ""}`.trimEnd()];
    const edits = args.edits;
    if (!Array.isArray(edits)) {
        return lines;
    }

    for (const edit of edits) {
        if (!edit || typeof edit !== "object") {
            continue;
        }
        const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
        if (typeof oldText === "string") {
            lines.push(...changeLines("-", oldText));
        }
        if (typeof newText === "string") {
            lines.push(...changeLines("+", newText));
        }
    }
    return lines;
}

function toolCallText(call: ToolCallDisplay): string {
    // × matches the failure marker already used by the agent activity widget.
    const prefix = call.failed ? "×" : "●";
    switch (call.name) {
        case "edit":
            return editCall(call.args, prefix).join("\n");
        case "bash":
            return `${prefix} bash ${stringArgument(call.args, "command") ?? ""}`.trimEnd();
        case "find":
        case "grep": {
            const pattern = stringArgument(call.args, "pattern");
            const path = stringArgument(call.args, "path");
            return [prefix, call.name, pattern, path].filter((value) => value !== undefined).join(" ");
        }
        default: {
            const path = stringArgument(call.args, "path");
            return path ? `${prefix} ${call.name} ${path}` : `${prefix} ${call.name}`;
        }
    }
}

function toolCallDescription(call: ToolCallDisplay): string {
    switch (call.name) {
        case "read":
            return `read ${stringArgument(call.args, "path") ?? "a file"}`;
        case "edit":
            return `edit ${stringArgument(call.args, "path") ?? "a file"}`;
        case "bash":
            return `run ${oneLine(stringArgument(call.args, "command") ?? "a command")}`;
        case "find":
        case "grep": {
            const pattern = stringArgument(call.args, "pattern");
            const path = stringArgument(call.args, "path");
            const subject = pattern === undefined ? "files" : `\`${oneLine(pattern)}\``;
            return `${call.name === "grep" ? "search" : "find"} ${subject}${path ? ` in ${path}` : ""}`;
        }
        default: {
            const path = stringArgument(call.args, "path");
            return path ? `${call.name} ${path}` : call.name;
        }
    }
}

function collapsedToolCalls(calls: ToolCallDisplay[]): string {
    const count = calls.length;
    const failed = calls.filter((call) => call.failed).length;
    const descriptions = calls.map(toolCallDescription);
    const previewLimit = 4;
    const preview = descriptions.length <= previewLimit
        ? descriptions
        : [...descriptions.slice(0, previewLimit), `+${descriptions.length - previewLimit} more`];
    const failureText = failed > 0 ? ` (${failed} failed)` : "";
    return `▸ ${count} tool call${count === 1 ? "" : "s"}${failureText}: ${preview.join("; ")}`;
}

function messageParts(
    entry: Extract<SessionEntry, { type: "message" }>,
    failedToolCalls: ReadonlySet<string>,
): TranscriptPart[] {
    const { message } = entry;
    switch (message.role) {
        case "user":
            return [{ text: quoteText(contentText(message.content)), toolOnly: false }];
        case "assistant": {
            const parts: TranscriptPart[] = [];
            let pendingToolCalls: ToolCallDisplay[] = [];
            const flushToolCalls = () => {
                if (pendingToolCalls.length === 0) {
                    return;
                }
                const toolCalls = pendingToolCalls;
                pendingToolCalls = [];
                parts.push({
                    text: toolCalls.map(toolCallText).join("\n"),
                    toolOnly: true,
                    toolCalls,
                });
            };
            for (const block of message.content) {
                if (block.type === "text") {
                    flushToolCalls();
                    if (block.text) {
                        parts.push({ text: block.text, toolOnly: false });
                    }
                } else if (block.type === "toolCall") {
                    pendingToolCalls.push({
                        name: block.name,
                        args: block.arguments,
                        failed: failedToolCalls.has(block.id),
                    });
                }
                // Thinking blocks are deliberately omitted until this view gains
                // an explicit opt-in control for them.
            }
            flushToolCalls();
            return parts;
        }
        case "toolResult":
            // Tool calls provide the useful chronological trace without repeating
            // potentially large read/bash output already available elsewhere.
            return [];
        case "bashExecution":
            return [{
                text: toolCallText({
                    name: "bash",
                    args: { command: message.command },
                    failed: message.exitCode !== undefined && message.exitCode !== 0,
                }),
                toolOnly: true,
                toolCalls: [{
                    name: "bash",
                    args: { command: message.command },
                    failed: message.exitCode !== undefined && message.exitCode !== 0,
                }],
            }];
        case "custom":
            return [{ text: quoteText(contentText(message.content)), toolOnly: false }];
        case "branchSummary":
            return [{ text: message.summary, toolOnly: false }];
        case "compactionSummary":
            return [{ text: message.summary, toolOnly: false }];
    }
}

function failedToolCallIds(entries: SessionEntry[]): Set<string> {
    const failed = new Set<string>();
    for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError) {
            failed.add(entry.message.toolCallId);
        }
    }
    return failed;
}

function transcriptParts(entries: SessionEntry[]): TranscriptPart[] {
    const failedToolCalls = failedToolCallIds(entries);
    const parts: TranscriptPart[] = [];
    for (const entry of entries) {
        if (entry.type === "message") {
            parts.push(...messageParts(entry, failedToolCalls));
        } else if (entry.type === "custom_message") {
            parts.push({ text: quoteText(contentText(entry.content)), toolOnly: false });
        } else if (entry.type === "compaction") {
            parts.push({ text: entry.summary, toolOnly: false });
        } else if (entry.type === "branch_summary") {
            parts.push({ text: entry.summary, toolOnly: false });
        }
    }
    return parts;
}

function joinParts(parts: TranscriptPart[]): string {
    let transcript = "";
    let previousWasToolOnly = false;
    for (const part of parts) {
        if (transcript) {
            transcript += previousWasToolOnly && part.toolOnly ? "\n" : "\n\n";
        }
        transcript += part.text;
        previousWasToolOnly = part.toolOnly;
    }
    return transcript;
}

function collapseParts(parts: TranscriptPart[]): TranscriptPart[] {
    const collapsed: TranscriptPart[] = [];
    let pendingToolCalls: ToolCallDisplay[] = [];
    const flushToolCalls = () => {
        if (pendingToolCalls.length === 0) {
            return;
        }
        const toolCalls = pendingToolCalls;
        pendingToolCalls = [];
        collapsed.push({
            text: collapsedToolCalls(toolCalls),
            toolOnly: true,
            toolCalls,
        });
    };

    for (const part of parts) {
        if (part.toolOnly && part.toolCalls) {
            pendingToolCalls.push(...part.toolCalls);
            continue;
        }
        flushToolCalls();
        collapsed.push(part);
    }
    flushToolCalls();
    return collapsed;
}

function formatTranscriptParts(parts: TranscriptPart[]): AgentSessionTranscriptViews {
    return {
        detailed: joinParts(parts),
        collapsed: joinParts(collapseParts(parts)),
    };
}

/** Formats an agent conversation in both compact and detailed forms. */
export function formatAgentSessionTranscripts(entries: SessionEntry[]): AgentSessionTranscriptViews {
    return formatTranscriptParts(transcriptParts(entries));
}

/**
 * Formats an active delegated-child conversation for the read-only agent browser.
 * Detailed mode keeps individual tool calls; collapsed mode groups consecutive
 * tool calls until the next user or assistant message.
 */
export function formatAgentSessionTranscript(
    entries: SessionEntry[],
    view: AgentTranscriptView = "detailed",
): string {
    return formatAgentSessionTranscripts(entries)[view];
}

/** Returns both display transcripts for a persisted child session, if readable. */
export function loadAgentSessionTranscriptViews(
    sessionFile: string,
): AgentSessionTranscriptViews | undefined {
    try {
        return formatAgentSessionTranscripts(SessionManager.open(sessionFile).getBranch());
    } catch {
        return undefined;
    }
}

/** Returns the detailed display transcript for a persisted child session, if readable. */
export function loadAgentSessionTranscript(sessionFile: string): string | undefined {
    return loadAgentSessionTranscriptViews(sessionFile)?.detailed;
}
