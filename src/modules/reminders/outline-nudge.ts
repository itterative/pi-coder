import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { REMINDER_CUSTOM_TYPE } from "./session-signals";

/**
 * The nudge that follows `rg`/`grep` exploration without `outline`.
 *
 * The reminder is event-driven, not a rotation entry. The behavior it exists to correct - reaching for a
 * line-oriented search on code that `outline` could map - happens inside an agent run, and a cadence measured
 * in user turns cannot time anything to it: by the next turn the expensive reads are already in the context.
 * The step boundary is the point where the model is choosing its next tool, so that is where the nudge is
 * delivered (`index.ts` `turn_end`).
 *
 * The deterministic trigger decides when a consult is worth paying for; the selection model decides whether the
 * nudge is emitted. At each trigger the module asks it for a helpfulness score on a bounded state - the recent
 * conversation, the triggering command, and its clipped output - and a `none` answer suppresses the nudge. A
 * disabled, failed, timed-out, or unreadable answer fails open and emits, matching the rotation's fallback. The
 * state and the broadened guidance came from replaying real sessions; the consult runs whenever the decision
 * model is enabled (`decisionModel.enabled`), and the trigger's rarity keeps the awaited cost bounded.
 */

/** The output a gate state carries: a few head lines, clipped, so the state stays bounded. */
export const OUTLINE_OUTPUT_CHARS = 400;
const OUTLINE_OUTPUT_LINES = 4;
const OUTLINE_OUTPUT_LINE_CHARS = 110;
/** The triggering command the gate state carries, clipped like a window item. */
const OUTLINE_COMMAND_CHARS = 240;

/**
 * Searches since the last `outline` call before the nudge may fire. One search can be a legitimate log or
 * config search; two in a row read as exploration.
 */
const OUTLINE_MIN_SEARCHES = 2;

/**
 * Tool calls that must pass after an `outline` call before the nudge may fire again. A model that just used
 * the tool does not need to be told about it, even if the next two searches follow it.
 */
export const OUTLINE_QUIET_CALLS = 20;

/**
 * User turns between two nudges. The habit is what the reminder is about, so it repeats - but it repeats
 * slowly: a nudge per few turns would be nagging, and the per-turn check already caps it at one per step run.
 */
export const OUTLINE_COOLDOWN_TURNS = 8;

/**
 * The shell commands whose job is a line-oriented code search. `find`/`ls` are absent: `outline` does not
 * replace a filename search.
 */
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"]);

/** The tool whose input is a content search rather than a file listing. */
const SEARCH_TOOL = "grep";

const OUTLINE_TOOL = "outline";

/** One tool call from an assistant message, as the scan and the step boundary see it. */
export interface StepToolCall {
    /** The call's id, so the step boundary can pair it with its result. */
    id?: string;
    name: string;
    arguments?: unknown;
}

/** What the branch says about the model's search habit, and when the nudge was last delivered. */
export interface OutlineUsage {
    /** Searches since the last `outline` call; reset to zero by one. */
    searchesSinceOutline: number;
    /** Tool calls since the last `outline` call; the quiet-window measure. */
    callsSinceOutline: number;
    /** Whether `outline` has been called at all in this epoch. */
    outlineCalls: number;
    /** The user turn the nudge was last delivered on, if the branch records one. */
    lastNudgeTurn?: number;
}

export interface OutlineNudgeOptions {
    minSearches: number;
    quietCalls: number;
    cooldownTurns: number;
}

const DEFAULT_OPTIONS: OutlineNudgeOptions = {
    minSearches: OUTLINE_MIN_SEARCHES,
    quietCalls: OUTLINE_QUIET_CALLS,
    cooldownTurns: OUTLINE_COOLDOWN_TURNS,
};

function emptyUsage(): OutlineUsage {
    return { searchesSinceOutline: 0, callsSinceOutline: 0, outlineCalls: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argumentText(args: unknown, key: string): string | undefined {
    if (!isRecord(args)) {
        return undefined;
    }

    const value = args[key];
    return typeof value === "string" ? value : undefined;
}

/** The tool calls an assistant message carries, in call order. */
export function toolCallsOf(content: unknown): StepToolCall[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const calls: StepToolCall[] = [];
    for (const part of content) {
        if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") {
            continue;
        }

        calls.push({
            ...(typeof part.id === "string" ? { id: part.id } : {}),
            name: part.name,
            ...(part.arguments === undefined ? {} : { arguments: part.arguments }),
        });
    }

    return calls;
}

/** Whether one call is a line-oriented search of code. */
export function isSearchCall(call: StepToolCall): boolean {
    if (call.name === SEARCH_TOOL) {
        return true;
    }

    if (call.name !== "bash") {
        return false;
    }

    const command = argumentText(call.arguments, "command");
    return command !== undefined && commandSearches(command);
}

function isOutlineCall(call: StepToolCall): boolean {
    return call.name === OUTLINE_TOOL;
}

/**
 * Whether any command segment runs a search command.
 *
 * Anchored to the segment's command word, so `echo 'rg foo'` is an argument and not a search. Lead assignments
 * are dropped first, and `git grep` is matched as the one two-word invocation that matters. Wrappers such as
 * `timeout` are not unwrapped, because a missed search costs a reminder, not a permission.
 *
 * Two segment shapes are not searches: a search on the right of a pipe filters another command's output rather
 * than exploring code, and a search inside a heredoc body is script text, not a call. Both were found in real
 * sessions (`npx vitest … | rg "×"`, a `cat <<'EOF'` fixture), and neither is what the nudge is about.
 */
function commandSearches(command: string): boolean {
    const segments = stripHeredocBodies(command).split(/(\|\||&&|\|&|[;&|\n])/u);
    let piped = false;

    for (let index = 0; index < segments.length; index += 2) {
        const segment = segments[index] ?? "";
        const separator = segments[index + 1];
        if (!piped && segmentSearches(segment)) {
            return true;
        }

        piped = separator === "|" || separator === "|&";
    }

    return false;
}

/** One command segment's own command word. */
function segmentSearches(segment: string): boolean {
    const words = segment
        .trim()
        .split(/\s+/u)
        .filter((word) => word !== "");
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) {
        words.shift();
    }

    const [commandWord, subcommand] = words;
    if (commandWord === undefined) {
        return false;
    }

    const executable = path.basename(commandWord);
    // `rg --files` is a filename listing with no pattern: `outline` does not replace it.
    if (executable === "rg" && words.includes("--files")) {
        return false;
    }

    if (SEARCH_COMMANDS.has(executable)) {
        return true;
    }

    return commandWord === "git" && subcommand === "grep";
}

const HEREDOC_START = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/u;

/** Remove heredoc bodies, keeping the lines that open them. A body is script text, not a command. */
function stripHeredocBodies(command: string): string {
    const kept: string[] = [];
    let delimiter: string | undefined;

    for (const line of command.split("\n")) {
        if (delimiter !== undefined) {
            if (line.trim() === delimiter) {
                delimiter = undefined;
            }
            continue;
        }

        kept.push(line);
        const match = HEREDOC_START.exec(line);
        if (match !== null) {
            delimiter = match[1] ?? match[2] ?? match[3];
        }
    }

    return kept.join("\n");
}

/** The command a gate state carries, in the same vocabulary the conversation uses for tool calls. */
export function commandText(call: StepToolCall): string {
    const args = isRecord(call.arguments) ? call.arguments : {};
    let text: string;

    if (call.name === "bash") {
        text = typeof args.command === "string" ? args.command : "bash";
    } else if (call.name === "read") {
        text = `read(${String(args.path ?? "?")})`;
    } else if (call.name === SEARCH_TOOL) {
        text = `grep(${String(args.pattern ?? "?")})`;
    } else {
        text = `${call.name}(${JSON.stringify(args).slice(0, 120)})`;
    }

    return text.slice(0, OUTLINE_COMMAND_CHARS);
}

/**
 * A bounded summary of one tool result: its size plus a few head lines.
 *
 * The output is what lets the gate state judge the cost of the exploration - a 14-line `rg -A 12` that
 * returned a declaration body reads very differently from a 2,000-line scan - so it is included, but only as
 * this clipped summary. The full body would dwarf the conversation it is meant to inform.
 */
export function summarizeToolOutput(content: unknown): string {
    const text = textOf(content);
    if (text === "") {
        return "no output";
    }

    const lines = text.split("\n");
    const head = lines
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(0, OUTLINE_OUTPUT_LINES)
        .map((line) => line.slice(0, OUTLINE_OUTPUT_LINE_CHARS))
        .join("\n");

    return `[${String(lines.length)} lines, ${String(text.length)} chars] ${head}`.slice(
        0,
        OUTLINE_OUTPUT_CHARS,
    );
}

function textOf(content: unknown): string {
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter(
            (part): part is { type: "text"; text: string } =>
                isRecord(part) && part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
}

/** Fold one call into the counters. Exported for the branch seed and the step tracker to share one rule. */
function applyOutlineCall(usage: OutlineUsage, call: StepToolCall): void {
    usage.callsSinceOutline += 1;

    if (isOutlineCall(call)) {
        usage.outlineCalls += 1;
        usage.searchesSinceOutline = 0;
        usage.callsSinceOutline = 0;
        return;
    }

    if (isSearchCall(call)) {
        usage.searchesSinceOutline += 1;
    }
}

/**
 * What the branch records about the search habit.
 *
 * Only the post-fold slice is read, for the same reason `reminderResumeState` does: a fold resets the user-turn
 * numbering the cooldown is measured in, so a pre-fold nudge must not hold the post-fold one back. A delivered
 * nudge is a `custom_message` whose `details` carry its id, and the id may be one of several (`ids`) when the
 * message was combined with another reminder.
 */
export function outlineUsageFromEntries(entries: readonly SessionEntry[]): OutlineUsage {
    const afterFold = entries.findLastIndex((entry) => entry.type === "compaction") + 1;
    const usage = emptyUsage();
    let lastNudgeTurn: number | undefined;

    for (const entry of entries.slice(afterFold)) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            for (const call of toolCallsOf(entry.message.content)) {
                applyOutlineCall(usage, call);
            }
            continue;
        }

        if (entry.type !== "custom_message" || entry.customType !== REMINDER_CUSTOM_TYPE) {
            continue;
        }

        const details = entry.details;
        if (!isRecord(details)) {
            continue;
        }

        const ids = Array.isArray(details.ids)
            ? details.ids.filter((value): value is string => typeof value === "string")
            : typeof details.id === "string"
              ? [details.id]
              : [];
        const turn = details.turn;
        if (!ids.includes(OUTLINE_TOOL) || typeof turn !== "number" || !Number.isFinite(turn)) {
            continue;
        }

        lastNudgeTurn = Math.max(lastNudgeTurn ?? 0, turn);
    }

    if (lastNudgeTurn !== undefined) {
        usage.lastNudgeTurn = lastNudgeTurn;
    }

    return usage;
}

/**
 * The step boundary's view of the habit: fold each step's calls into the counters, and answer whether this
 * boundary is where the nudge belongs.
 *
 * `noteStep` records the nudge's turn when it answers yes, so one run cannot nudge twice and the cooldown
 * anchors on the delivery rather than on the decision to consider one.
 */
export class OutlineNudgeTracker {
    private usage: OutlineUsage = emptyUsage();
    private readonly options: OutlineNudgeOptions;

    constructor(options: Partial<OutlineNudgeOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    noteStep(calls: readonly StepToolCall[], currentTurn: number): boolean {
        let searched = false;
        for (const call of calls) {
            applyOutlineCall(this.usage, call);
            searched ||= isSearchCall(call);
        }

        // The nudge belongs to the step that searched, not to whatever step happens to follow it: by then the
        // model may have moved on, and the text would describe activity the current step does not show.
        if (!searched || !this.due(currentTurn)) {
            return false;
        }

        this.usage.lastNudgeTurn = currentTurn;
        return true;
    }

    /** Resume on a populated branch, or start an empty post-fold epoch. */
    seed(usage: OutlineUsage): void {
        this.usage = { ...usage };
    }

    reset(): void {
        this.usage = emptyUsage();
    }

    snapshot(): OutlineUsage {
        return { ...this.usage };
    }

    private due(currentTurn: number): boolean {
        if (this.usage.searchesSinceOutline < this.options.minSearches) {
            return false;
        }

        // Only an `outline` call the model has actually made can be too recent: a session that never used the
        // tool has no quiet window to respect.
        if (this.usage.outlineCalls > 0 && this.usage.callsSinceOutline < this.options.quietCalls) {
            return false;
        }

        const lastTurn = this.usage.lastNudgeTurn;
        if (lastTurn !== undefined && currentTurn - lastTurn < this.options.cooldownTurns) {
            return false;
        }

        return true;
    }
}
