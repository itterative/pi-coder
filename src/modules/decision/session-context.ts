import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { DecisionRecentMessage } from "./types";

/**
 * The session half of a decision: the request the command serves and the turns leading to it.
 *
 * This reproduces the shape the cases were measured with, because the state is half of the measurement: the
 * last few turns as `{role, text}` items — user turns, assistant prose, and the commands the assistant ran
 * (tool output deliberately excluded, it is the expensive part and the model never needed it) — plus the
 * current request as its own field. Flattened into one transcript the same facts measured *worse* than no
 * context at all, which is why the two never get merged here.
 *
 * The assistant message that carries the pending tool call is not in the branch yet when the gate asks, so
 * `recent` cannot include that message; every already-committed item before the command does appear.
 */

/** Items kept, matching `MAX_HISTORY` in the case extractor. */
export const RECENT_ITEM_COUNT = 4;
/** Characters per item, matching `MAX_TEXT`. */
export const ITEM_CHARS = 240;
/** Characters for the request itself, matching `MAX_USER`. */
export const REQUEST_CHARS = 600;

export interface DecisionSessionContext {
    request?: string;
    recent: DecisionRecentMessage[];
}

/** Whitespace-collapse and clip, so one long tool echo cannot crowd out the rest of the state. */
function clip(text: string, limit: number): string {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    if (collapsed.length <= limit) {
        return collapsed;
    }

    return `${collapsed.slice(0, limit - 1)}…`;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
    if (typeof part !== "object" || part === null) {
        return false;
    }

    const candidate = part as Record<string, unknown>;
    return candidate.type === "text" && typeof candidate.text === "string";
}

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n")
        .trim();
}

/** The command of a bash tool call, or `undefined` for any other part. */
function toolCallCommand(part: unknown): string | undefined {
    if (typeof part !== "object" || part === null) {
        return undefined;
    }

    const candidate = part as Record<string, unknown>;
    if (candidate.type !== "toolCall" || candidate.name !== "bash") {
        return undefined;
    }

    const args = candidate.arguments;
    if (typeof args !== "object" || args === null) {
        return undefined;
    }

    const command = (args as Record<string, unknown>).command;
    if (typeof command !== "string" || command.trim() === "") {
        return undefined;
    }

    return command;
}

function itemsOf(message: { content: unknown }): DecisionRecentMessage[] {
    const items: DecisionRecentMessage[] = [];
    const text = textOf(message.content);
    if (text !== "") {
        items.push({ role: "assistant", text: clip(text, ITEM_CHARS) });
    }

    if (!Array.isArray(message.content)) {
        return items;
    }

    for (const part of message.content) {
        const command = toolCallCommand(part);
        if (command !== undefined) {
            items.push({ role: "command", text: clip(command, ITEM_CHARS) });
        }
    }

    return items;
}

/**
 * Build the session half from the active branch.
 *
 * `recent` is the items immediately before the command, oldest first — the current turn's prose and commands
 * when there are any, then earlier turns when the turn is shorter than the window. The current request is its
 * own field, so its item is dropped from the window rather than ending it: ending it there discarded the
 * whole current turn, which is exactly the context the probes measured with. Replaying the two logged
 * abstains, the kept items took `none` confidence from 0.48/0.51 to 0.64/0.64.
 */
/** How many earlier same-tool commands the suggestion state carries. */
export const SUGGESTION_HISTORY_COUNT = 3;

/** The words of a command with leading environment assignments dropped, for the same-tool comparison. */
function commandWords(command: string): string[] {
    return command
        .trim()
        .split(/\s+/u)
        .filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
}

function sameInvocation(command: string, key: readonly string[]): boolean {
    const words = commandWords(command);

    return words.length >= key.length && key.every((word, index) => words[index] === word);
}

/**
 * The commands in the branch that name the same tool as `tokens`, oldest first.
 *
 * A suggestion for an unrecognized package runner turns on what the session has already done with that tool:
 * one earlier `npx zorch run test/bar.test.ts` moved the role answer from 0.80 (code) to 0.36 (data), while a
 * mixed recent window left it at 0.61. The window is therefore filtered to the same leading tool and package
 * (at most two words), clipped like every other state item, and capped at
 * {@link SUGGESTION_HISTORY_COUNT}.
 */
export function decisionSimilarCommands(
    entries: readonly SessionEntry[],
    tokens: readonly string[],
    limit = SUGGESTION_HISTORY_COUNT,
): string[] {
    const key = tokens.slice(0, 2);
    if (key.length === 0) {
        return [];
    }

    const matches: string[] = [];
    for (const entry of entries) {
        if (entry.type !== "message") {
            continue;
        }

        const { message } = entry;
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            continue;
        }

        for (const part of message.content) {
            const command = toolCallCommand(part);
            if (command !== undefined && sameInvocation(command, key)) {
                matches.push(clip(command, ITEM_CHARS));
            }
        }
    }

    return matches.slice(-limit);
}

export function decisionSessionContext(entries: readonly SessionEntry[]): DecisionSessionContext {
    const items: DecisionRecentMessage[] = [];
    let request: string | undefined;

    for (const entry of entries) {
        if (entry.type !== "message") {
            continue;
        }

        const { message } = entry;
        if (message.role === "user") {
            const text = textOf(message.content);
            if (text !== "") {
                request = clip(text, REQUEST_CHARS);
                items.push({ role: "user", text: clip(text, ITEM_CHARS) });
            }
            continue;
        }

        if (message.role === "assistant") {
            items.push(...itemsOf(message));
        }
    }

    const requestIndex = items.findLastIndex((item) => item.role === "user");
    const history =
        requestIndex === -1
            ? items
            : [...items.slice(0, requestIndex), ...items.slice(requestIndex + 1)];

    return {
        ...(request === undefined ? {} : { request }),
        recent: history.slice(-RECENT_ITEM_COUNT),
    };
}
