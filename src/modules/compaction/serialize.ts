import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { CompactionConfig } from "./config";
import { collapseWhitespace, estimateTextTokens, truncateHead } from "./text";
import type { ContextMessage } from "./types";

/**
 * Minimal conversation serialization for the fallback summarization request.
 *
 * pi's own `serializeConversation` is the format these labels imitate, but its policy is fixed and heavy
 * for a summarizer: thinking blocks arrive untruncated (they are typically the largest single block in a
 * session and rarely contain information the visible text lacks), every tool result gets 2000 characters
 * regardless of tool, and no budget is enforced at all — an overflow-triggered request built from it can
 * be too large to send, which is the one case that must not fail. This module keeps pi's line format and
 * changes the policy: thinking off by default, per-tool result budgets that know `agent` reports are worth
 * more than `read` output, argument renderings that understand pi-coder's own tools, and newest-first
 * packing under an explicit token ceiling.
 */

const USER_LABEL = "[User]";
const THINKING_LABEL = "[Assistant thinking]";
const ASSISTANT_LABEL = "[Assistant]";
const TOOL_CALLS_LABEL = "[Assistant tool calls]";
const TOOL_RESULT_LABEL = "[Tool result]";
const BASH_LABEL = "[Bash]";
const BASH_RESULT_LABEL = "[Bash result]";
const NOTE_LABEL = "[System note]";
const COMPACTION_SUMMARY_LABEL = "[Compaction summary]";
const BRANCH_SUMMARY_LABEL = "[Branch summary]";

/** Kept wide: user text is the ground truth for goals, constraints, and preferences. */
const COMMAND_HEAD = 200;
const DEFAULT_ARGUMENT_HEAD = 120;
/** The previous summary is the session's accumulated memory, so it is not the place to be aggressive. */
const EARLIER_SUMMARY_CHARS = 6_000;

/** Argument keys worth keeping per tool, in rendering order. Anything absent renders as key names only. */
const TOOL_ARGUMENT_KEYS: Record<string, string[]> = {
    read: ["path", "offset", "limit"],
    ls: ["path"],
    grep: ["pattern", "path", "glob"],
    find: ["pattern", "path"],
    bash: ["command", "timeout"],
    edit: ["path"],
    write: ["path"],
    agent: ["action", "agent", "runId", "title"],
    ask_user: ["title"],
    ask_parent: ["question"],
};

/** Long-string arguments that need a wider head than the default. */
const ARGUMENT_HEADS: Record<string, number> = {
    command: COMMAND_HEAD,
    question: 240,
    pattern: 160,
    title: 120,
};

/** Result caps that differ from the default because the payload is the useful part. */
const RESULT_CHARS_OVERRIDES: Record<string, number> = {
    agent: 1_200,
};

/**
 * Table lookup for a key that came out of a transcript. Plain indexing answers with `Object.prototype`
 * members for a tool or argument named `constructor`, and a function where a character budget belongs is
 * a very quiet bug.
 */
function configured<T>(table: Record<string, T>, key: string): T | undefined {
    return Object.hasOwn(table, key) ? table[key] : undefined;
}

export interface SerializeOptions {
    keepThinking: boolean;
    /** Ceiling for the produced text, in estimated tokens. Oldest messages are dropped first. */
    maxTokens: number;
    assistantChars: number;
    userChars: number;
    toolResultChars: number;
    errorResultChars: number;
    noteChars: number;
}

export function serializerOptions(config: CompactionConfig): SerializeOptions {
    return {
        keepThinking: config.keepThinking,
        maxTokens: config.serializedMaxTokens,
        assistantChars: config.serializedAssistantChars,
        userChars: config.serializedUserChars,
        toolResultChars: config.serializedToolResultChars,
        errorResultChars: config.serializedErrorResultChars,
        noteChars: config.serializedNoteChars,
    };
}

export interface SerializedConversation {
    text: string;
    /** Serialized blocks kept inside the budget. */
    keptBlocks: number;
    /** Serialized blocks dropped from the oldest end to fit the budget. */
    droppedBlocks: number;
}

interface RenderedBlock {
    label: string;
    body: string;
}

type RenderedContent = string | (TextContent | ImageContent)[] | undefined;

function textBlocks(content: RenderedContent): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block) => (block.type === "text" ? block.text : "[image omitted]"))
        .filter((part) => part.length > 0)
        .join("\n");
}

function renderArgument(key: string, value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return `${key}=${String(value)}`;
    }
    if (typeof value === "string") {
        const head = configured(ARGUMENT_HEADS, key) ?? DEFAULT_ARGUMENT_HEAD;
        return `${key}=${JSON.stringify(truncateHead(collapseWhitespace(value), head))}`;
    }
    if (Array.isArray(value)) {
        return `${key}=${String(value.length)} item(s)`;
    }
    return undefined;
}

/** Sizes instead of payloads for the arguments a model would never fit in a summary anyway. */
function renderDerivedArguments(tool: string, args: Record<string, unknown>): string[] {
    const parts: string[] = [];
    const edits = args.edits;
    if (tool === "edit" && Array.isArray(edits)) {
        parts.push(`edits=${String(edits.length)}`);
    }
    const content = args.content;
    if (typeof content === "string" && (tool === "write" || tool === "edit")) {
        parts.push(`contentChars=${String(content.length)}`);
    }
    const task = args.task;
    if (tool === "agent" && typeof task === "string") {
        parts.push(`taskChars=${String(task.length)}`);
    }
    return parts;
}

function renderToolCall(name: string, args: Record<string, unknown>): string {
    const kept = configured(TOOL_ARGUMENT_KEYS, name);
    if (!kept) {
        // Unknown tool: values are unbounded and their meaning is not ours to judge, so name the shape only.
        const keys = Object.keys(args).sort();
        return keys.length === 0 ? name : `${name}(${keys.join(", ")})`;
    }
    const parts = kept
        .map((key) => renderArgument(key, args[key]))
        .filter((part): part is string => part !== undefined);
    const derived = renderDerivedArguments(name, args);
    const all = [...parts, ...derived];
    return all.length === 0 ? name : `${name}(${all.join(", ")})`;
}

function renderAssistant(
    message: Extract<ContextMessage, { role: "assistant" }>,
    options: SerializeOptions,
): RenderedBlock[] {
    const blocks: RenderedBlock[] = [];
    const toolCalls: string[] = [];
    for (const block of message.content) {
        if (block.type === "thinking") {
            if (options.keepThinking) {
                blocks.push({
                    label: THINKING_LABEL,
                    body: truncateHead(block.thinking, options.assistantChars),
                });
            }
            continue;
        }
        if (block.type === "text") {
            if (block.text) {
                blocks.push({
                    label: ASSISTANT_LABEL,
                    body: truncateHead(block.text, options.assistantChars),
                });
            }
            continue;
        }
        const args: Record<string, unknown> = block.arguments ?? {};
        toolCalls.push(renderToolCall(block.name, args));
    }
    if (toolCalls.length > 0) {
        blocks.push({ label: TOOL_CALLS_LABEL, body: toolCalls.join("; ") });
    }
    return blocks;
}

function renderToolResult(
    message: Extract<ContextMessage, { role: "toolResult" }>,
    options: SerializeOptions,
): RenderedBlock[] {
    const body = textBlocks(message.content);
    if (body.length === 0) {
        return [];
    }
    const cap = message.isError
        ? options.errorResultChars
        : (configured(RESULT_CHARS_OVERRIDES, message.toolName) ?? options.toolResultChars);
    const prefix = message.isError ? `${message.toolName} failed — ` : "";
    return [{ label: TOOL_RESULT_LABEL, body: `${prefix}${truncateHead(body, cap)}` }];
}

function renderBashExecution(
    message: Extract<ContextMessage, { role: "bashExecution" }>,
    options: SerializeOptions,
): RenderedBlock[] {
    if (message.excludeFromContext) {
        return [];
    }
    const outcome = message.cancelled
        ? "cancelled"
        : typeof message.exitCode === "number"
          ? `exit ${String(message.exitCode)}`
          : undefined;
    const command = `${truncateHead(collapseWhitespace(message.command), COMMAND_HEAD)}${outcome ? ` (${outcome})` : ""}`;
    const blocks: RenderedBlock[] = [{ label: BASH_LABEL, body: command }];
    const output = message.output ?? "";
    if (output.length > 0) {
        blocks.push({
            label: BASH_RESULT_LABEL,
            body: truncateHead(output, options.toolResultChars),
        });
    }
    return blocks;
}

function renderCustom(
    message: Extract<ContextMessage, { role: "custom" }>,
    options: SerializeOptions,
): RenderedBlock[] {
    if (options.noteChars <= 0) {
        return [];
    }
    const body = textBlocks(message.content);
    if (body.length === 0) {
        return [];
    }
    return [
        {
            label: NOTE_LABEL,
            body: `${message.customType}: ${truncateHead(body, options.noteChars)}`,
        },
    ];
}

function renderMessage(message: ContextMessage, options: SerializeOptions): RenderedBlock[] {
    switch (message.role) {
        case "user": {
            const body = textBlocks(message.content);
            return body ? [{ label: USER_LABEL, body: truncateHead(body, options.userChars) }] : [];
        }
        case "assistant":
            return renderAssistant(message, options);
        case "toolResult":
            return renderToolResult(message, options);
        case "bashExecution":
            return renderBashExecution(message, options);
        case "custom":
            return renderCustom(message, options);
        case "compactionSummary":
            return [
                {
                    label: COMPACTION_SUMMARY_LABEL,
                    body: truncateHead(message.summary, EARLIER_SUMMARY_CHARS),
                },
            ];
        case "branchSummary":
            return [
                {
                    label: BRANCH_SUMMARY_LABEL,
                    body: truncateHead(message.summary, EARLIER_SUMMARY_CHARS),
                },
            ];
        default:
            return [];
    }
}

function renderLine(block: RenderedBlock): string {
    return `${block.label}: ${block.body}`;
}

function blockTokenEstimate(block: RenderedBlock): number {
    return estimateTextTokens(renderLine(block));
}

/**
 * Pack newest-first under `maxTokens`, then restore chronological order.
 *
 * The newest block is always kept, even when it alone exceeds the ceiling: a request with nothing to
 * summarize is worse than one that is too large to be useful, and the caller reports the overflow.
 */
function packWithinBudget(blocks: RenderedBlock[], maxTokens: number): RenderedBlock[] {
    const kept: RenderedBlock[] = [];
    let used = 0;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        const cost = blockTokenEstimate(block);
        if (kept.length > 0 && used + cost > maxTokens) {
            break;
        }
        kept.push(block);
        used += cost;
    }
    return kept.reverse();
}

export function serializeConversationMinimal(
    messages: ContextMessage[],
    options: SerializeOptions,
): SerializedConversation {
    const blocks = messages.flatMap((message) => renderMessage(message, options));
    const kept = packWithinBudget(blocks, options.maxTokens);
    const droppedBlocks = blocks.length - kept.length;
    const parts = kept.map(renderLine);
    if (droppedBlocks > 0) {
        parts.unshift(
            `[... ${String(droppedBlocks)} older message blocks omitted to fit the ` +
                `${String(options.maxTokens)}-token summarization budget]`,
        );
    }
    return { text: parts.join("\n\n"), keptBlocks: kept.length, droppedBlocks };
}
