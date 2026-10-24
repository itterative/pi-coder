/**
 * The state transcript, ported verbatim from the stage probe (`session-midturn.py`, `--mode window`).
 *
 * This is the text the state question is judged from: the probe's `window_transcript` / `fitted_transcript`
 * pair, with its own caps, elision and omission markers. It is kept literal on purpose - the variant was
 * measured as-is, so the live request has to send the same bytes, and the probe remains the source of truth
 * (`test/fixtures/transcript-window.json` is generated from it). Do not "fix" the budget arithmetic here
 * without re-measuring: the ordering of allowance, musts, shares and tool share is what the runs used.
 */
import type { DecisionRecentMessage } from "./types";

/** One atom of a transcript: a message, a tool call, or a state marker inserted between them. */
export interface TranscriptItem {
    kind: string;
    text?: string;
    name?: string;
    arg?: string;
    turn?: number;
}

/** Cap on one tool line, applied before the budget is measured. */
export const TOOL_LINE_CHARS = 120;
/** Cap on one message line. */
export const MESSAGE_LINE_CHARS = 900;
/** The newest tool lines that are always kept. */
export const TOOL_MIN = 2;
/** Share of the budget further tool lines may use. */
export const TOOL_SHARE = 0.3;
/** Floor reserved for each kept message. */
export const MESSAGE_MIN = 220;
/** Tool items kept from the start of a turn. */
export const HEAD_LINES = 5;
/** Tool items kept from the end of a turn. */
export const TAIL_LINES = 25;
/** Turns drawn on: the newest contributes its tools, the earlier ones their messages only. */
export const KEEP_TURNS = 3;

/** The state marker role, exported by the session context and used here for its own editor history. */
const MARKER_KIND = "marker";
const MESSAGE_LABELS: Record<string, string> = { user: "User", assistant: "Assistant" };

/** Collapse whitespace and truncate with a single ellipsis, exactly as the probe's `clip` does. */
function clip(text: string, limit: number): string {
    const one = text.replace(/\s+/gu, " ").trim();
    if (limit > 0 && one.length > limit) {
        return `${one.slice(0, limit - 1)}…`;
    }

    return one;
}

/** One item as its transcript line, with the per-kind cap applied. */
function itemLine(item: TranscriptItem): string {
    if (item.kind === MARKER_KIND) {
        return item.text ?? "";
    }

    if (item.kind === "tool") {
        const inner = typeof item.arg === "string" ? clip(item.arg, TOOL_LINE_CHARS) : "…";
        return `Tool: ${item.name ?? "?"}(${inner})`;
    }

    const label = MESSAGE_LABELS[item.kind] ?? item.kind;
    return `${label}: ${clip(item.text ?? "", MESSAGE_LINE_CHARS)}`;
}

/** The marker text for what a fit left out. */
function describeOmissions(tools: number, messages: number): string {
    if (tools > 0 && messages > 0) {
        return `${String(tools)} tool calls and ${String(messages)} earlier messages omitted`;
    }
    if (tools > 0) {
        return `${String(tools)} tool calls omitted`;
    }
    if (messages > 0) {
        return `${String(messages)} earlier messages omitted`;
    }

    return "";
}

/**
 * Keep every message and the first/last {@link HEAD_LINES}/{@link TAIL_LINES} tool items of each turn.
 *
 * Elision is per turn and only ever drops tool items, so a user or assistant statement survives it.
 */
export function elideTurnTools(items: readonly TranscriptItem[]): TranscriptItem[] {
    const out: TranscriptItem[] = [];
    const turns = [...new Set(items.map((item) => item.turn ?? 0))].toSorted((a, b) => a - b);

    for (const turn of turns) {
        const group = items.filter((item) => (item.turn ?? 0) === turn);
        const tools = group
            .map((item, index) => ({ item, index }))
            .filter((entry) => entry.item.kind === "tool")
            .map((entry) => entry.index);

        if (tools.length <= HEAD_LINES + TAIL_LINES + 1) {
            out.push(...group);
            continue;
        }

        const keep = new Set([
            ...tools.slice(0, HEAD_LINES),
            ...(TAIL_LINES > 0 ? tools.slice(-TAIL_LINES) : []),
        ]);
        let pending = true;

        for (const [index, item] of group.entries()) {
            if (item.kind === "tool" && !keep.has(index)) {
                if (pending) {
                    out.push({
                        kind: MARKER_KIND,
                        turn,
                        text: `  … ${String(tools.length - keep.size)} tool calls omitted …`,
                    });
                    pending = false;
                }
                continue;
            }

            out.push(item);
        }
    }

    return out;
}

/**
 * Render `items` into `budget` chars, keeping the newest tool lines and a user and assistant message.
 *
 * The probe's fit, line for line: markers and the newest {@link TOOL_MIN} tool lines are paid for first, the
 * newest user and assistant messages are kept whatever happens, further messages are fitted by
 * {@link MESSAGE_MIN} floors, each kept message is clipped to its share newest-first, and what is left goes to
 * further tool lines within {@link TOOL_SHARE} of the budget. Returns the kept lines and the omission note.
 */
export function renderFitted(
    items: readonly TranscriptItem[],
    budget: number,
): { lines: string[]; note: string; dropped: number } {
    const lines = items.map((item) => itemLine(item));
    const markers = items
        .map((_, index) => index)
        .filter((index) => items[index]?.kind === MARKER_KIND);
    const tools = items.map((_, index) => index).filter((index) => items[index]?.kind === "tool");
    const messages = items
        .map((_, index) => index)
        .filter((index) => MESSAGE_LABELS[items[index]?.kind ?? ""] !== undefined);

    const markerChars = markers.reduce(
        (total, index) => total + (lines[index]?.length ?? 0) + 1,
        0,
    );
    const skeletonTools = tools.toReversed().slice(0, TOOL_MIN);
    const toolChars = skeletonTools.reduce(
        (total, index) => total + (lines[index]?.length ?? 0) + 1,
        0,
    );
    const allowance = Math.max(budget - markerChars - toolChars, 0);

    const newestOf = (kind: string): number | undefined =>
        messages.toReversed().find((index) => items[index]?.kind === kind);
    const must = [newestOf("user"), newestOf("assistant")].filter(
        (index): index is number => index !== undefined,
    );
    const keptMessages = [...must];
    let room = allowance - must.length * MESSAGE_MIN;

    for (const index of messages.toReversed()) {
        if (must.includes(index)) {
            continue;
        }
        if (room < MESSAGE_MIN) {
            break;
        }

        keptMessages.push(index);
        room -= MESSAGE_MIN;
    }
    keptMessages.sort((a, b) => a - b);

    const shares = new Map<number, number>();
    let left = allowance;
    for (const [position, index] of keptMessages.toReversed().entries()) {
        const older = keptMessages.length - position - 1;
        const share = Math.max(
            MESSAGE_MIN,
            Math.min(MESSAGE_LINE_CHARS, left - older * MESSAGE_MIN),
        );
        shares.set(index, share);
        left -= share;
    }

    const rendered = new Map<number, string>();
    for (const index of keptMessages) {
        const item = items[index];
        const label = MESSAGE_LABELS[item?.kind ?? ""] ?? "";
        const share = shares.get(index) ?? MESSAGE_MIN;
        rendered.set(
            index,
            `${label}: ${clip(item?.text ?? "", Math.max(share - label.length - 2, 40))}`,
        );
    }

    const kept = new Set<number>([...markers, ...skeletonTools, ...keptMessages]);
    const used =
        markerChars +
        toolChars +
        keptMessages.reduce((total, index) => total + (rendered.get(index)?.length ?? 0) + 1, 0);
    let toolRoom = Math.min(budget - used, TOOL_SHARE * budget);

    for (const index of tools.toReversed()) {
        if (kept.has(index)) {
            continue;
        }

        const size = (lines[index]?.length ?? 0) + 1;
        if (size > toolRoom) {
            break;
        }

        kept.add(index);
        toolRoom -= size;
    }

    const out = items
        .map((_, index) => index)
        .filter((index) => kept.has(index))
        .map((index) => rendered.get(index) ?? lines[index] ?? "");
    const droppedTools = tools.filter((index) => !kept.has(index)).length;
    const droppedMessages = messages.filter((index) => !kept.has(index)).length;

    return {
        lines: out,
        note: describeOmissions(droppedTools, droppedMessages),
        dropped: items.length - kept.size,
    };
}

/** All items at `budget`, with no turn or tool elision. */
export function fittedTranscript(
    items: readonly TranscriptItem[],
    budget: number,
): { text: string; dropped: number } {
    const fitted = renderFitted(items, budget);
    const lines =
        fitted.note === "" ? fitted.lines : [`  … ${fitted.note} (char cap) …`, ...fitted.lines];

    return { text: lines.join("\n"), dropped: fitted.dropped };
}

/**
 * The most recent turns as the model's transcript: tools elided, then fitted to `chars`.
 *
 * The newest turn keeps its tool items - they are what the current state is made of - while the earlier turns
 * in the span contribute their messages only. The request is appended as a user line when the window does not
 * already carry it, which is the boundary case: pi persists the user message only after the handler returns.
 */
export function windowTranscript(
    items: readonly TranscriptItem[],
    request: string,
    elide: boolean,
    chars: number,
    keepTurns = KEEP_TURNS,
): { text: string; dropped: number } {
    const totalLines = items.length;
    let selected = [...items];

    if (keepTurns > 0) {
        const newest = items.reduce((max, item) => Math.max(max, item.turn ?? 0), 0);
        selected = items.filter(
            (item) =>
                (item.turn ?? 0) === newest ||
                (item.kind !== "tool" && (item.turn ?? 0) > newest - keepTurns),
        );
    }

    if (elide) {
        selected = elideTurnTools(selected);
    }

    const carriesRequest = selected.some(
        (item) => item.kind === "user" && (item.text ?? "").slice(0, 40) === request.slice(0, 40),
    );
    if (request !== "" && !carriesRequest) {
        selected.push({ kind: "user", text: request, turn: 0 });
    }

    const fitted = fittedTranscript(selected, chars);

    return { text: fitted.text, dropped: fitted.dropped + (totalLines - selected.length) };
}

/**
 * The live window items as transcript atoms: the session context already renders each line's content.
 *
 * Two things happen here that the probe does at its own marker insertion: a state marker that repeats the one
 * before it is dropped (`insert_state_markers` skips a state equal to the previous mark, which is why a phase
 * held across several turns annotates the transcript once), and each item keeps the turn it was stamped with.
 */
export function transcriptItems(items: readonly DecisionRecentMessage[]): TranscriptItem[] {
    const atoms: TranscriptItem[] = [];
    let previousMarker: string | undefined;

    for (const item of items) {
        // Items before the first user message carry no turn of their own; they are the newest turn's as far as
        // the selection is concerned, so they keep their tools rather than being mistaken for history.
        const turn = item.turn ?? 0;

        if (item.role === "state") {
            if (item.text === previousMarker) {
                continue;
            }
            previousMarker = item.text;
            atoms.push({ kind: MARKER_KIND, text: item.text, turn });
            continue;
        }
        if (item.role === "command") {
            atoms.push({ kind: "tool", name: "bash", arg: item.text, turn });
            continue;
        }
        if (item.role === "tool") {
            const name = item.text.slice(0, Math.max(item.text.indexOf("("), 0)) || "tool";
            const arg = item.text.slice(name.length + 1, Math.max(item.text.lastIndexOf(")"), 0));
            atoms.push({ kind: "tool", name, arg, turn });
            continue;
        }

        atoms.push({ kind: item.role, text: item.text, turn });
    }

    return atoms;
}
