import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { DecisionRecentMessage } from "./types";

/**
 * The session half of a decision: the request the command serves and the turns leading to it.
 *
 * This keeps the shape the cases were measured with, because the state is half of the measurement: the last
 * few turns as `{role, text}` items — user turns, assistant prose, and the tool calls the assistant made
 * (tool output deliberately excluded, it is the expensive part and the model never needed it) — plus the
 * current request as its own field. Flattened into one transcript the same facts measured *worse* than no
 * context at all, which is why the two never get merged here.
 *
 * The window is **planned rather than sliced**. Slicing the newest four items lost exactly the facts that
 * resolve a state read: the newest assistant message competed with an old turn for a slot, and non-bash tool
 * calls were dropped outright, so a turn that edited three files and delegated to a worker arrived as prose.
 * The plan keeps the newest user item, the newest assistant item and the newest tool calls whatever the budget
 * would otherwise take, and shares the rest newest-first. Its measurements come from the mid-run stage probe
 * (`reminders/stage-gating.md`): composition decided as much as size, no tier-1 escalation depended on the
 * window once the tool lines were present, and a 5x window bought nothing.
 *
 * The assistant message that carries the pending tool call is not in the branch yet when the gate asks, so
 * `recent` cannot include that message; every already-committed item before the command does appear.
 */

/** Characters the planned window may spend, before the omission accounting. */
export const WINDOW_CHARS = 1200;
/**
 * Characters for the tier-1 window: the probed knee of the cost curve (`reminders/stage-gating.md`).
 *
 * The endpoint answers a fitted transcript in ~0.269s at 800 chars against ~0.465s at 4500, and escalation on
 * the state question stopped tracking the tier-1 size at 800, so a larger short window buys latency and
 * nothing else. A state read needs the newest user item, the newest assistant item and the newest tool lines,
 * which the plan keeps whatever the budget.
 */
export const SHORT_WINDOW_CHARS = 800;
/**
 * Characters for the state transcript once the short window came back unsure.
 *
 * The probe's tier-2 budget: the README's 800/1800/4500 sweep measured 1800 as accurate as 4500 and cheaper,
 * so the escalated state is fitted at 1800 rather than at the plan's 1200 ({@link WINDOW_CHARS}).
 */
export const TRANSCRIPT_WINDOW_CHARS = 1800;
/** Characters per item, applied before the budget is measured, so one long echo cannot spend the window. */
export const ITEM_CHARS = 240;
/** Floor reserved for every kept item, so the newest item cannot take the whole window. */
export const ITEM_MIN = 120;
/** Newest tool calls the window always keeps, whichever items the budget would otherwise have taken. */
export const TOOL_ITEMS_KEPT = 3;
/** Characters for the request itself, matching `MAX_USER`. */
export const REQUEST_CHARS = 600;

export interface DecisionSessionContext {
    request?: string;
    recent: DecisionRecentMessage[];
    /** Items the plan dropped, so a caller can tell a trimmed window from a complete one. */
    omitted?: number;
    /**
     * Every item of the branch walk, oldest first, the request item included - the atoms a window is allocated
     * from.
     *
     * The planned `recent` is what the command and file-access states carry. The two model readers that count
     * what is worth the budget - the state ask's transcript (`decision/transcript.ts`) and the reminder
     * selection's conversation (`decision/window.ts`) - are built from these atoms instead, because each
     * measured variant fitted them itself and needs the items the plan drops.
     */
    items: DecisionRecentMessage[];
}

/** The planned window and what the budget left behind. */
export interface SessionWindow {
    /** The kept items, oldest first, each clipped to its share of the budget. */
    items: DecisionRecentMessage[];
    /** Items the budget left out, so a caller can see the window was trimmed rather than complete. */
    omitted: number;
}

/** Whitespace-collapse and clip, so one long tool echo cannot crowd out the rest of the state. */
function clip(text: string, limit: number): string {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    if (collapsed.length <= limit) {
        return collapsed;
    }

    return `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Whitespace-collapse and clip a caller-supplied request to the state's request limit.
 *
 * A `before_agent_start` caller passes the live prompt, which is not in the branch yet and can carry a full
 * template or skill expansion; the branch-built request is clipped where it is read, so the override needs the
 * same bound rather than sending the expansion whole to a small classifier window.
 */
export function clipRequest(text: string): string {
    return clip(text, REQUEST_CHARS);
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a user message joined the turn already running instead of starting one.
 *
 * The probe's rule: a steer follows a tool result, or an assistant message that called a tool. It is what keeps
 * an interjection inside the turn it interrupted, so the transcript's turn selection does not read it as a new
 * turn with no work in it.
 */
function isSteeredMessage(
    previous: "toolResult" | "assistant" | "assistantWithTools" | "other" | undefined,
): boolean {
    return previous === "toolResult" || previous === "assistantWithTools";
}

/** Whether an assistant message's content carries a tool call. */
function hasToolCall(content: unknown): boolean {
    if (!Array.isArray(content)) {
        return false;
    }

    return content.some(
        (part) => isRecord(part) && part.type === "toolCall" && typeof part.name === "string",
    );
}

/** The command of a bash tool call, or `undefined` for any other part. */
function toolCallCommand(part: unknown): string | undefined {
    if (!isRecord(part)) {
        return undefined;
    }

    if (part.type !== "toolCall" || part.name !== "bash") {
        return undefined;
    }

    const args = part.arguments;
    if (!isRecord(args)) {
        return undefined;
    }

    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") {
        return undefined;
    }

    return command;
}

/**
 * The one argument that identifies a tool call to a reader, by tool.
 *
 * Preferred keys come first so an `edit` shows the path it changed rather than the patch it carried; any other
 * string argument is a fallback to something rather than nothing.
 */
const TOOL_ARGUMENT_KEYS: Record<string, readonly string[]> = {
    read: ["path", "file_path"],
    edit: ["path", "file_path"],
    write: ["path", "file_path"],
    ls: ["path"],
    grep: ["pattern", "path"],
    find: ["pattern", "path"],
    agent: ["agent", "title"],
    ask_user: ["title", "question"],
    skill: ["name"],
    todolist: ["action"],
};

/**
 * A one-line rendering of a non-bash tool call: the tool's name and the argument that identifies it.
 *
 * The window is a state read, so an edit has to read as an edit of a named file — the fact the bash-only
 * window could not carry, and the one whose absence left the model judging the state from prose alone.
 */
function toolSummary(name: string, args: unknown): string {
    const record = isRecord(args) ? args : {};
    const preferred = TOOL_ARGUMENT_KEYS[name] ?? [];
    const keys = [...preferred, ...Object.keys(record).filter((key) => !preferred.includes(key))];

    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim() !== "") {
            return `${name}(${value})`;
        }
    }

    return `${name}()`;
}

/** The item one tool-call part contributes: bash as its command, every other tool as a named call. */
function toolCallItem(part: unknown): DecisionRecentMessage | undefined {
    if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") {
        return undefined;
    }

    if (part.name === "bash") {
        const command = toolCallCommand(part);
        return command === undefined ? undefined : { role: "command", text: command };
    }

    return { role: "tool", text: toolSummary(part.name, part.arguments) };
}

function itemsOf(message: { content: unknown }): DecisionRecentMessage[] {
    const items: DecisionRecentMessage[] = [];
    const text = textOf(message.content);
    if (text !== "") {
        items.push({ role: "assistant", text });
    }

    if (!Array.isArray(message.content)) {
        return items;
    }

    for (const part of message.content) {
        const item = toolCallItem(part);
        if (item !== undefined) {
            items.push(item);
        }
    }

    return items;
}

/** Whether an item is a tool call, of either role the window gives one. */
function isToolItem(item: DecisionRecentMessage | undefined): boolean {
    return item?.role === "command" || item?.role === "tool";
}

/**
 * The item indexes the plan keeps whatever the budget would otherwise have taken.
 *
 * One user item and one assistant item, because a state read needs both sides of the exchange it is judging,
 * then the newest tool calls, because *what was done* is what the slice used to lose.
 */
function guaranteedIndexes(items: readonly DecisionRecentMessage[]): Set<number> {
    const guaranteed = new Set<number>();

    for (const role of ["user", "assistant"]) {
        const index = items.findLastIndex((item) => item.role === role);
        if (index !== -1) {
            guaranteed.add(index);
        }
    }

    let taken = 0;
    for (let index = items.length - 1; index >= 0 && taken < TOOL_ITEMS_KEPT; index -= 1) {
        if (isToolItem(items[index])) {
            guaranteed.add(index);
            taken += 1;
        }
    }

    return guaranteed;
}

/**
 * Plan the window: the guarantees first, then the newest of what is left, each item clipped to its share.
 *
 * Every item is capped to {@link ITEM_CHARS} before the budget is measured, so one long echo cannot spend the
 * window by itself. Each kept item then reserves {@link ITEM_MIN}, and the shares are handed out newest-first
 * — the newest action takes what the older items' floors leave — so an older item is trimmed before a newer
 * one is dropped, and the newest fact is never the shortest line.
 */
export function planSessionWindow(
    items: readonly DecisionRecentMessage[],
    budget = WINDOW_CHARS,
): SessionWindow {
    const capped = items.map((item) => ({ ...item, text: clip(item.text, ITEM_CHARS) }));
    const guaranteed = guaranteedIndexes(capped);

    const kept = new Set(guaranteed);
    let room = budget - guaranteed.size * ITEM_MIN;
    for (let index = capped.length - 1; index >= 0; index -= 1) {
        if (kept.has(index)) {
            continue;
        }

        const floor = itemFloor(capped[index] as DecisionRecentMessage);
        if (room < floor) {
            break;
        }

        kept.add(index);
        room -= floor;
    }

    const order = [...kept].toSorted((left, right) => left - right);
    const newestFirst = order.toReversed();
    const shares = new Map<number, number>();
    let left = budget;

    for (const [position, index] of newestFirst.entries()) {
        const older = newestFirst.length - position - 1;
        const item = capped[index] as DecisionRecentMessage;
        const floor = itemFloor(item);
        const share = Math.max(floor, Math.min(item.text.length, left - older * ITEM_MIN));
        shares.set(index, share);
        left -= share;
    }

    return {
        items: order.map((index) => {
            const item = capped[index] as DecisionRecentMessage;
            return { ...item, text: clip(item.text, shares.get(index) ?? ITEM_MIN) };
        }),
        omitted: items.length - order.length,
    };
}

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

/** The item role that carries a state marker: its text is the whole line, never trimmed. */
const STATE_ROLE = "state";

/** One item as its transcript line. */
const WINDOW_LABELS: Record<string, string> = { user: "User", assistant: "Assistant" };

function itemLine(item: DecisionRecentMessage): string {
    if (item.role === STATE_ROLE) {
        return item.text;
    }

    if (item.role === "command") {
        return `Tool: bash(${item.text})`;
    }

    if (item.role === "tool") {
        return `Tool: ${item.text}`;
    }

    return `${WINDOW_LABELS[item.role] ?? item.role}: ${item.text}`;
}

/**
 * The window as a transcript a human reads: `User:` / `Assistant:` lines and `Tool: name(arg)` per call, with
 * what the budget left out named first.
 *
 * This is the shape the mid-run probe rendered (`session-midturn.py`), kept so a window can be read the same
 * way here - in a test, a replay, or a log. The model itself is sent the items, not this text: the render is
 * for the reviewer deciding whether the window carries what it should.
 */
export function renderSessionWindow(
    items: readonly DecisionRecentMessage[],
    omitted = 0,
): string[] {
    const lines: string[] = [];
    if (omitted > 0) {
        lines.push(`… ${omitted} earlier item${omitted === 1 ? "" : "s"} omitted …`);
    }

    for (const item of items) {
        lines.push(itemLine(item));
    }

    return lines;
}

/**
 * Whether an entry contributes a state marker to the window, and what it says.
 *
 * The decision module cannot name the reminder's state entry itself: `reminders/` is built on top of it, so
 * the caller passes a reader. Returning `undefined` is the ordinary case for every other kind of entry.
 */
export type StateMarkerReader = (entry: SessionEntry) => string | undefined;

export interface SessionContextOptions {
    stateMarker?: StateMarkerReader;
    /** The budget the window is planned inside; the tier-1 window passes {@link SHORT_WINDOW_CHARS}. */
    windowChars?: number;
}

/**
 * The budget floor one item reserves: the shared item floor, except a state marker.
 *
 * A marker is short and never trimmed, so charging it the full floor would spend a whole window on a dozen
 * annotation lines; it is charged exactly what it costs.
 */
function itemFloor(item: DecisionRecentMessage): number {
    return item.role === STATE_ROLE ? item.text.length : ITEM_MIN;
}

/**
 * Build the session half from the active branch.
 *
 * `recent` is the planned window over the items immediately before the command, oldest first — the current
 * turn's prose and tool calls when there are any, then earlier turns when the turn is shorter than the window.
 * The current request is its own field, so its item is dropped from the window rather than ending it: ending
 * it there discarded the whole current turn, which is exactly the context the probes measured with. Replaying
 * the two logged abstains, the kept items took `none` confidence from 0.48/0.51 to 0.64/0.64.
 */
export function decisionSessionContext(
    entries: readonly SessionEntry[],
    options: SessionContextOptions = {},
): DecisionSessionContext {
    const items: DecisionRecentMessage[] = [];
    let request: string | undefined;
    // The turn stamps the transcript's turn selection reads: the probe's rule, a user message starts a turn
    // unless it joined a running one (a steer). Items before the first user message belong to no turn.
    let turn = 0;
    let previousMessage: "toolResult" | "assistant" | "assistantWithTools" | "other" | undefined;

    for (const entry of entries) {
        if (entry.type !== "message") {
            // A recorded state is part of the conversation the model judges: the accepted phase is inserted
            // where it was accepted, so continuity is carried inside the transcript instead of only as a
            // claim in the state's own phase field.
            const marker = options.stateMarker?.(entry);
            if (marker !== undefined) {
                items.push({ role: STATE_ROLE, text: marker, turn });
            }
            // A compaction or fold starts a fresh turn, as the probe's `is_steered` decides.
            if (entry.type === "compaction" || entry.type === "branch_summary") {
                previousMessage = undefined;
            }
            continue;
        }

        const { message } = entry;
        if (message.role === "user") {
            const text = textOf(message.content);
            if (text !== "") {
                if (turn === 0 || !isSteeredMessage(previousMessage)) {
                    turn += 1;
                }
                request = clip(text, REQUEST_CHARS);
                items.push({ role: "user", text, turn });
            }
            previousMessage = "other";
            continue;
        }

        if (message.role === "assistant") {
            items.push(...itemsOf(message).map((item) => ({ ...item, turn })));
            previousMessage = hasToolCall(message.content) ? "assistantWithTools" : "assistant";
        }

        if (message.role === "toolResult") {
            previousMessage = "toolResult";
        }
    }

    const requestIndex = items.findLastIndex((item) => item.role === "user");
    const history =
        requestIndex === -1
            ? items
            : [...items.slice(0, requestIndex), ...items.slice(requestIndex + 1)];
    const window = planSessionWindow(history, options.windowChars ?? WINDOW_CHARS);

    return {
        ...(request === undefined ? {} : { request }),
        // The planned window keeps the state shape the pool was measured with (`{role, text}`); the turn stamps
        // are the transcript's, and only the atoms below carry them.
        recent: window.items.map(({ role, text }) => ({ role, text })),
        items,
        ...(window.omitted === 0 ? {} : { omitted: window.omitted }),
    };
}
