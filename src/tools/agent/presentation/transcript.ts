import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getTodoSnapshotFromEntries } from "../../../modules/todolist/persistence";
import { formatTodoTranscript } from "./todo-transcript";

type DisplayContent = string | (TextContent | ImageContent)[];
type ToolArguments = Record<string, unknown>;

export type AgentTranscriptView = "collapsed" | "detailed";

/** Set true to show full edit/write content in detailed transcript tool lines. */
const SHOW_TOOL_CALL_DIFFS = false;

/** A transcript segment with tool calls kept outside the Markdown renderer. */
export interface AgentTranscriptPart {
    kind: "markdown" | "plain";
    text: string;
}

export interface AgentSessionTranscriptViews {
    collapsed: string;
    detailed: string;
    collapsedParts: AgentTranscriptPart[];
    detailedParts: AgentTranscriptPart[];
}

interface ToolCallDisplay {
    name: string;
    args: ToolArguments;
    failed: boolean;
}

type TranscriptPartKind = "user" | "assistant" | "custom" | "tool";

interface TranscriptPart {
    kind: TranscriptPartKind;
    text: string;
    toolCalls?: ToolCallDisplay[];
}

interface TodoTranscriptEntry {
    collapsed: string;
    detailed: string;
}

interface CollectedTranscript {
    conversation: TranscriptPart[];
    todo?: TodoTranscriptEntry;
}

function contentText(content: DisplayContent): string {
    if (typeof content === "string") {
        return content;
    }
    return content
        .map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
        .join("\n");
}

export function quoteText(text: string): string {
    return text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
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

function lineCount(text: string): number {
    return text.length === 0 ? 0 : text.split("\n").length;
}

interface EditChange {
    oldText?: string;
    newText?: string;
}

function editChanges(args: ToolArguments): EditChange[] {
    if (!Array.isArray(args.edits)) {
        return [];
    }

    return args.edits.flatMap((edit) => {
        if (!edit || typeof edit !== "object") {
            return [];
        }
        const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
        return [
            {
                ...(typeof oldText === "string" ? { oldText } : {}),
                ...(typeof newText === "string" ? { newText } : {}),
            },
        ];
    });
}

function changedLineCount(changes: EditChange[], field: keyof EditChange): number {
    return changes.reduce((total, change) => {
        const text = change[field];
        return total + (text === undefined ? 0 : lineCount(text));
    }, 0);
}

function editCall(args: ToolArguments, prefix: string): string[] {
    const path = stringArgument(args, "path") ?? "";
    const changes = editChanges(args);
    const removedLines = changedLineCount(changes, "oldText");
    const addedLines = changedLineCount(changes, "newText");
    const lines = [`${prefix} edit ${path}`.trimEnd()];
    if (!SHOW_TOOL_CALL_DIFFS) {
        lines[0] += ` (+${addedLines} -${removedLines})`;
        return lines;
    }

    for (const change of changes) {
        if (change.oldText !== undefined) {
            lines.push(...changeLines("-", change.oldText));
        }
        if (change.newText !== undefined) {
            lines.push(...changeLines("+", change.newText));
        }
    }
    return lines;
}

function writeCall(args: ToolArguments, prefix: string): string {
    const path = stringArgument(args, "path") ?? "";
    const content = stringArgument(args, "content");
    const line = `${prefix} write ${path}`.trimEnd();
    if (SHOW_TOOL_CALL_DIFFS && content !== undefined) {
        return [line, ...changeLines("+", content)].join("\n");
    }
    if (content === undefined) {
        return line;
    }
    return `${line} (+${lineCount(content)} lines)`;
}

function toolCallText(call: ToolCallDisplay): string {
    // × matches the failure marker already used by the agent activity widget.
    const prefix = call.failed ? "×" : "●";
    switch (call.name) {
        case "edit":
            return editCall(call.args, prefix).join("\n");
        case "write":
            return writeCall(call.args, prefix);
        case "bash":
            return `${prefix} bash ${stringArgument(call.args, "command") ?? ""}`.trimEnd();
        case "find":
        case "grep": {
            const pattern = stringArgument(call.args, "pattern");
            const path = stringArgument(call.args, "path");
            return [prefix, call.name, pattern, path]
                .filter((value) => value !== undefined)
                .join(" ");
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
            const subject = pattern === undefined ? "files" : oneLine(pattern);
            return `${call.name === "grep" ? "search" : "find"} ${subject}${path ? ` in ${path}` : ""}`;
        }
        default: {
            const path = stringArgument(call.args, "path");
            return path ? `${call.name} ${path}` : call.name;
        }
    }
}

export function formatToolCallSummary(
    count: number,
    failed: number,
    includeZeroFailures = true,
): string {
    const failureText = failed > 0 || includeZeroFailures ? ` (${failed} failed)` : "";
    return `${count} tool call${count === 1 ? "" : "s"}${failureText}`;
}

function collapsedToolCalls(calls: ToolCallDisplay[]): string {
    const count = calls.length;
    const failed = calls.filter((call) => call.failed).length;
    const descriptions = calls.map(toolCallDescription);
    const previewLimit = 4;
    const preview =
        descriptions.length <= previewLimit
            ? descriptions
            : [
                  ...descriptions.slice(0, previewLimit),
                  `+${descriptions.length - previewLimit} more`,
              ];
    return `▸ ${formatToolCallSummary(count, failed, false)}: ${preview.join("; ")}`;
}

function messageParts(
    entry: Extract<SessionEntry, { type: "message" }>,
    failedToolCalls: ReadonlySet<string>,
): TranscriptPart[] {
    const { message } = entry;
    switch (message.role) {
        case "user":
            return [{ kind: "user", text: quoteText(contentText(message.content)) }];
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
                    kind: "tool",
                    text: toolCalls.map(toolCallText).join("\n"),
                    toolCalls,
                });
            };
            for (const block of message.content) {
                if (block.type === "text") {
                    flushToolCalls();
                    if (block.text) {
                        parts.push({ kind: "assistant", text: block.text });
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
            return [
                {
                    kind: "tool",
                    text: toolCallText({
                        name: "bash",
                        args: { command: message.command },
                        failed: message.exitCode !== undefined && message.exitCode !== 0,
                    }),
                    toolCalls: [
                        {
                            name: "bash",
                            args: { command: message.command },
                            failed: message.exitCode !== undefined && message.exitCode !== 0,
                        },
                    ],
                },
            ];
        case "custom":
            return [{ kind: "custom", text: quoteText(contentText(message.content)) }];
        case "branchSummary":
            return [{ kind: "assistant", text: message.summary }];
        case "compactionSummary":
            return [{ kind: "assistant", text: message.summary }];
    }
}

function failedToolCallIds(entries: SessionEntry[]): Set<string> {
    const failed = new Set<string>();
    for (const entry of entries) {
        if (
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.isError
        ) {
            failed.add(entry.message.toolCallId);
        }
    }
    return failed;
}

function collectConversationParts(
    entries: SessionEntry[],
    failedToolCalls: ReadonlySet<string>,
): TranscriptPart[] {
    const conversation: TranscriptPart[] = [];

    for (const entry of entries) {
        if (entry.type === "message") {
            conversation.push(...messageParts(entry, failedToolCalls));
            continue;
        }
        if (entry.type === "custom_message" && entry.display) {
            // Hidden custom messages (e.g. pi-memory reminders, mailbox notes)
            // are injected for the model, not shown in the transcript.
            conversation.push({ kind: "custom", text: quoteText(contentText(entry.content)) });
            continue;
        }
        if (entry.type === "compaction" || entry.type === "branch_summary") {
            conversation.push({ kind: "assistant", text: entry.summary });
        }
    }

    return conversation;
}

function collectTodoEntry(entries: SessionEntry[]): TodoTranscriptEntry | undefined {
    const snapshot = getTodoSnapshotFromEntries(entries);
    if (!snapshot) {
        return undefined;
    }

    const todo = formatTodoTranscript(snapshot.content);
    if (!todo) {
        return undefined;
    }

    const detailed = todo.body ? `${todo.collapsed}\n\n${quoteText(todo.body)}` : todo.collapsed;
    return { collapsed: todo.collapsed, detailed };
}

function collectTranscript(entries: SessionEntry[]): CollectedTranscript {
    return {
        conversation: collectConversationParts(entries, failedToolCallIds(entries)),
        todo: collectTodoEntry(entries),
    };
}

function collapseToolCalls(parts: TranscriptPart[]): TranscriptPart[] {
    const collapsed: TranscriptPart[] = [];
    let pendingToolCalls: ToolCallDisplay[] = [];

    const flushToolCalls = (): void => {
        if (pendingToolCalls.length === 0) {
            return;
        }

        collapsed.push({
            kind: "tool",
            text: collapsedToolCalls(pendingToolCalls),
            toolCalls: pendingToolCalls,
        });
        pendingToolCalls = [];
    };

    for (const part of parts) {
        if (part.kind === "tool" && part.toolCalls) {
            pendingToolCalls.push(...part.toolCalls);
            continue;
        }

        flushToolCalls();
        collapsed.push(part);
    }

    flushToolCalls();
    return collapsed;
}

function joinTranscriptParts(parts: TranscriptPart[]): string {
    let transcript = "";
    let previousKind: TranscriptPartKind | undefined;

    for (const part of parts) {
        if (transcript) {
            transcript += previousKind === "tool" && part.kind === "tool" ? "\n" : "\n\n";
        }
        transcript += part.text;
        previousKind = part.kind;
    }

    return transcript;
}

function transcriptParts(
    transcript: CollectedTranscript,
    view: AgentTranscriptView,
): TranscriptPart[] {
    const conversation =
        view === "collapsed" ? collapseToolCalls(transcript.conversation) : transcript.conversation;
    if (!transcript.todo) {
        return conversation;
    }

    const todoText = transcript.todo[view];
    const firstUserIndex = conversation.findIndex((part) => part.kind === "user");
    const todoIndex = firstUserIndex < 0 ? 0 : firstUserIndex + 1;
    const renderedParts = [...conversation];
    renderedParts.splice(todoIndex, 0, { kind: "assistant", text: todoText });
    return renderedParts;
}

function renderTranscript(transcript: CollectedTranscript, view: AgentTranscriptView): string {
    return joinTranscriptParts(transcriptParts(transcript, view));
}

function displayTranscriptParts(
    transcript: CollectedTranscript,
    view: AgentTranscriptView,
): AgentTranscriptPart[] {
    return transcriptParts(transcript, view).map((part) => ({
        kind: part.kind === "tool" ? "plain" : "markdown",
        text: part.text,
    }));
}

/** Formats an agent conversation in both compact and detailed forms. */
export function formatAgentSessionTranscripts(
    entries: SessionEntry[],
): AgentSessionTranscriptViews {
    const transcript = collectTranscript(entries);
    return {
        detailed: renderTranscript(transcript, "detailed"),
        collapsed: renderTranscript(transcript, "collapsed"),
        detailedParts: displayTranscriptParts(transcript, "detailed"),
        collapsedParts: displayTranscriptParts(transcript, "collapsed"),
    };
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
    return renderTranscript(collectTranscript(entries), view);
}
