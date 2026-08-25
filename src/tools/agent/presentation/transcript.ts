import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type DisplayContent = string | (TextContent | ImageContent)[];
type ToolArguments = Record<string, unknown>;

interface TranscriptPart {
    text: string;
    toolOnly: boolean;
}

function contentText(content: DisplayContent): string {
    if (typeof content === "string") return content;
    return content.map((block) => (
        block.type === "text" ? block.text : `[image: ${block.mimeType}]`
    )).join("\n");
}

function quoteText(text: string): string {
    return text.split("\n").map((line) => `> ${line}`).join("\n");
}

function stringArgument(args: ToolArguments, name: string): string | undefined {
    const value = args[name];
    return typeof value === "string" ? value : undefined;
}

function changeLines(prefix: "+" | "-", text: string): string[] {
    return text.split("\n").map((line) => `  ${prefix} ${line}`);
}

function editCall(args: ToolArguments, prefix: string): string[] {
    const lines = [`${prefix} edit ${stringArgument(args, "path") ?? ""}`.trimEnd()];
    const edits = args.edits;
    if (!Array.isArray(edits)) return lines;

    for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
        if (typeof oldText === "string") lines.push(...changeLines("-", oldText));
        if (typeof newText === "string") lines.push(...changeLines("+", newText));
    }
    return lines;
}

function toolCallText(name: string, args: ToolArguments, failed: boolean): string {
    // × matches the failure marker already used by the agent activity widget.
    const prefix = failed ? "×" : "●";
    switch (name) {
        case "edit":
            return editCall(args, prefix).join("\n");
        case "bash":
            return `${prefix} bash ${stringArgument(args, "command") ?? ""}`.trimEnd();
        case "find":
        case "grep": {
            const pattern = stringArgument(args, "pattern");
            const path = stringArgument(args, "path");
            return [prefix, name, pattern, path].filter((value) => value !== undefined).join(" ");
        }
        case "review_history": {
            const base = stringArgument(args, "base");
            const head = stringArgument(args, "head");
            return [prefix, "review history", base && head ? `${base}..${head}` : undefined]
                .filter((value) => value !== undefined)
                .join(" ");
        }
        default: {
            const path = stringArgument(args, "path");
            return path ? `${prefix} ${name} ${path}` : `${prefix} ${name}`;
        }
    }
}

function messageText(
    entry: Extract<SessionEntry, { type: "message" }>,
    failedToolCalls: ReadonlySet<string>,
): TranscriptPart | undefined {
    const { message } = entry;
    switch (message.role) {
        case "user":
            return { text: quoteText(contentText(message.content)), toolOnly: false };
        case "assistant": {
            const sections: string[] = [];
            const toolCalls: string[] = [];
            let hasText = false;
            const flushToolCalls = () => {
                if (toolCalls.length > 0) sections.push(toolCalls.splice(0).join("\n"));
            };
            for (const block of message.content) {
                if (block.type === "text") {
                    flushToolCalls();
                    sections.push(block.text);
                    hasText = true;
                } else if (block.type === "toolCall") {
                    toolCalls.push(toolCallText(
                        block.name,
                        block.arguments,
                        failedToolCalls.has(block.id),
                    ));
                }
                // Thinking blocks are deliberately omitted until this view gains
                // an explicit opt-in control for them.
            }
            flushToolCalls();
            const text = sections.filter(Boolean).join("\n\n");
            return text ? { text, toolOnly: !hasText } : undefined;
        }
        case "toolResult":
            // Tool calls provide the useful chronological trace without repeating
            // potentially large read/bash output already available elsewhere.
            return undefined;
        case "bashExecution":
            return {
                text: `${message.exitCode && message.exitCode !== 0 ? "×" : "●"} bash ${message.command}`,
                toolOnly: true,
            };
        case "custom":
            return { text: quoteText(contentText(message.content)), toolOnly: false };
        case "branchSummary":
            return { text: message.summary, toolOnly: false };
        case "compactionSummary":
            return { text: message.summary, toolOnly: false };
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

/**
 * Formats an active delegated-child conversation for the read-only agent browser.
 * It keeps user/custom/assistant messages and compact tool calls in chronological
 * order. Edit calls show removed/added lines, failures use ×, and consecutive
 * tool-only responses stay together. Model thinking and tool-result output are omitted.
 */
export function formatAgentSessionTranscript(entries: SessionEntry[]): string {
    const failedToolCalls = failedToolCallIds(entries);
    const parts: TranscriptPart[] = [];
    for (const entry of entries) {
        if (entry.type === "message") {
            const part = messageText(entry, failedToolCalls);
            if (part) parts.push(part);
        } else if (entry.type === "custom_message") {
            parts.push({ text: quoteText(contentText(entry.content)), toolOnly: false });
        } else if (entry.type === "compaction") {
            parts.push({ text: entry.summary, toolOnly: false });
        } else if (entry.type === "branch_summary") {
            parts.push({ text: entry.summary, toolOnly: false });
        }
    }

    let transcript = "";
    let previousWasToolOnly = false;
    for (const part of parts) {
        if (transcript) transcript += previousWasToolOnly && part.toolOnly ? "\n" : "\n\n";
        transcript += part.text;
        previousWasToolOnly = part.toolOnly;
    }
    return transcript;
}

/** Returns the complete display transcript for a persisted child session, if readable. */
export function loadAgentSessionTranscript(sessionFile: string): string | undefined {
    try {
        return formatAgentSessionTranscript(SessionManager.open(sessionFile).getBranch());
    } catch {
        return undefined;
    }
}
