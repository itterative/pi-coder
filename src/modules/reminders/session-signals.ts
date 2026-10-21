import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    isReminderPhase,
    type ReminderSessionActivity,
    type ReminderSignals,
    type ReminderStateLabels,
    type ReminderTodoState,
} from "../decision/reminder";
import { getTodoSnapshotFromEntries } from "../todolist/persistence";
import { parseTodoList } from "../todolist/parser";
import { ACTIVE_ROTATION_REMINDERS } from "./catalog";
import type { ReminderId } from "./types";

/**
 * The context the decision model judges a reminder by, derived from the session branch and the module's own
 * emission history.
 *
 * The recent window in `decisionSessionContext` is four clipped items and bash-only, so a turn that edited
 * three files and delegated to a worker can read as one line of prose. Everything here is a bounded summary:
 * counts, small lists, and the current TODO progress, never transcript text beyond the request and window.
 */

/** How many paths, recent tool names, and memory names the state carries. */
const MAX_FILES_MODIFIED = 8;
const MAX_RECENT_TOOLS = 6;
const MAX_MEMORY_NAMES = 24;

/** The entry the memory module records its index under; read structurally rather than importing its private type. */
const MEMORY_INDEX_ENTRY = "pi-memory:memory-index";

/** The session entry the model-maintained state labels are persisted under. */
export const REMINDER_STATE_TYPE = "pi-coder:reminder-state";

/** The commands that count as having run the project's tests, anchored to a chain segment's command word. */
const TEST_COMMANDS = [
    /^npm(?:\s+run)?\s+test(?::run)?\b/u,
    /^npx\s+vitest(?:\s+run)?\b/u,
    /^vitest\s+run\b/u,
    /^pytest\b/u,
    /^cargo\s+test\b/u,
    /^go\s+test\b/u,
];

const WRITE_TOOLS = new Set(["edit", "write"]);

export interface ReminderSignalInput {
    entries: readonly SessionEntry[];
    cwd: string;
    /** The turn being prepared, counting from 1 after a reset. */
    currentTurn: number;
    contextTokens: number;
    /** When each rotation reminder was shown, keyed by the user turn it was emitted on. */
    shown: ReadonlyMap<ReminderId, number>;
    /** The labels the model assigned on earlier turns, when any are persisted. */
    labels?: ReminderStateLabels;
}

/**
 * The rotation ids the activity allows this turn. Only `memory-hygiene` is gated: before any file has
 * changed its "review what you learned" text has nothing to act on, so it stays unavailable until mutating
 * work happened. Filtering here rather than in the catalog keeps the gate a property of the session, not of
 * the reminder.
 */
export function availableRotationIds(signals: ReminderSignals): ReadonlySet<ReminderId> {
    const available = new Set<ReminderId>();
    for (const reminder of ACTIVE_ROTATION_REMINDERS) {
        if (reminder.id === "memory-hygiene" && !hasMutatingWork(signals.session)) {
            continue;
        }

        available.add(reminder.id);
    }

    return available;
}

/** Work the memory-hygiene reminder can act on: a changed file, TODO progress, or a wrapping-up label. */
function hasMutatingWork(session: ReminderSessionActivity | undefined): boolean {
    if (session === undefined) {
        return false;
    }

    return (
        (session.files_modified?.length ?? 0) > 0 ||
        (session.todo_writes ?? 0) > 0 ||
        session.finishing === true ||
        session.phase === "wrapping_up"
    );
}

export function buildReminderSignals(input: ReminderSignalInput): ReminderSignals {
    const activity = scanActivity(input.entries, input.cwd);
    const labels = resolveSessionLabels(input.labels, inferSessionLabels(activity));
    const signals: ReminderSignals = {
        cwd: input.cwd,
        session: {
            user_turns: input.currentTurn,
            context_tokens: input.contextTokens,
            ...activity,
            ...labels,
        },
    };

    const shown = [...input.shown.entries()]
        .map(([id, turn]) => ({ id, turns_ago: Math.max(0, input.currentTurn - turn) }))
        .toSorted((left, right) => left.turns_ago - right.turns_ago);
    if (shown.length > 0) {
        signals.reminders_shown = shown;
    }

    const todo = todoState(input.entries);
    if (todo !== undefined) {
        signals.todo = todo;
    }

    const memories = projectMemoryNames(input.entries);
    if (memories.length > 0) {
        signals.memories = memories;
    }

    return signals;
}

/**
 * The labels the model assigned win per field; deterministic inference fills the gaps.
 *
 * Inference never invents `finishing`: that is a judgement about the task, not something the activity counts
 * can see. `phase` and `unvalidated` have activity-shaped fallbacks, so the state stays populated when the
 * model is off, abstains, or returns an unreadable label.
 */
function resolveSessionLabels(
    persisted: ReminderStateLabels | undefined,
    inferred: ReminderStateLabels,
): ReminderStateLabels {
    const labels: ReminderStateLabels = {};

    const phase = persisted?.phase ?? inferred.phase;
    if (phase !== undefined) {
        labels.phase = phase;
    }

    if (persisted?.finishing !== undefined) {
        labels.finishing = persisted.finishing;
    }

    const unvalidated = persisted?.unvalidated ?? inferred.unvalidated;
    if (unvalidated !== undefined) {
        labels.unvalidated = unvalidated;
    }

    return labels;
}

/** What the activity counts alone imply: writes without a test run are implementation, reads are exploration. */
function inferSessionLabels(activity: ReminderSessionActivity): ReminderStateLabels {
    const changed =
        (activity.files_modified?.length ?? 0) > 0 ||
        (activity.memory_writes ?? 0) > 0 ||
        (activity.todo_writes ?? 0) > 0;
    const labels: ReminderStateLabels = {};

    if (changed) {
        labels.phase = activity.tests_run === true ? "verifying" : "implementing";
        labels.unvalidated = activity.tests_run !== true;
        return labels;
    }

    if (hasReadTools(activity.tools)) {
        labels.phase = "exploring";
    }

    return labels;
}

function hasReadTools(tools: Record<string, number> | undefined): boolean {
    if (tools === undefined) {
        return false;
    }

    return ["read", "grep", "find", "ls"].some((name) => (tools[name] ?? 0) > 0);
}

/** The latest persisted state labels on the branch, or empty when none is readable. */
export function reminderLabelsFromEntries(entries: readonly SessionEntry[]): ReminderStateLabels {
    const entry = entries.findLast(
        (candidate) => candidate.type === "custom" && candidate.customType === REMINDER_STATE_TYPE,
    );
    if (entry === undefined || entry.type !== "custom" || !isRecord(entry.data)) {
        return {};
    }

    const labels: ReminderStateLabels = {};
    const { phase, finishing, unvalidated } = entry.data;
    if (typeof phase === "string" && isReminderPhase(phase)) {
        labels.phase = phase;
    }
    if (typeof finishing === "boolean") {
        labels.finishing = finishing;
    }
    if (typeof unvalidated === "boolean") {
        labels.unvalidated = unvalidated;
    }

    return labels;
}

/** Tool calls, writes, and test runs observed in the branch, as counts and bounded lists. */
function scanActivity(entries: readonly SessionEntry[], cwd: string): ReminderSessionActivity {
    const tools: Record<string, number> = {};
    const recentTools: string[] = [];
    const files = new Set<string>();
    let testsRun = false;
    let memoryWrites = 0;
    let todoWrites = 0;

    for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        for (const call of toolCalls(entry.message.content)) {
            tools[call.name] = (tools[call.name] ?? 0) + 1;
            recentTools.push(call.name);
            if (recentTools.length > MAX_RECENT_TOOLS) {
                recentTools.shift();
            }

            if (call.name === "bash") {
                const command = argumentText(call.arguments, "command");
                testsRun ||= command !== undefined && runsTests(command);
                continue;
            }

            if (!WRITE_TOOLS.has(call.name)) {
                continue;
            }

            const target = argumentText(call.arguments, "path");
            if (target === undefined) {
                continue;
            }

            const relative = relativePath(cwd, target);
            if (isMemoryPath(relative)) {
                memoryWrites += 1;
                continue;
            }

            if (path.basename(relative) === "TODO.md") {
                todoWrites += 1;
                continue;
            }

            // Re-insert so the set keeps the most recently written paths at the end.
            files.delete(relative);
            files.add(relative);
        }
    }

    const activity: ReminderSessionActivity = {};
    if (Object.keys(tools).length > 0) {
        activity.tools = tools;
    }
    if (recentTools.length > 0) {
        activity.recent_tools = recentTools;
    }

    const modified = [...files].slice(-MAX_FILES_MODIFIED);
    if (modified.length > 0) {
        activity.files_modified = modified;
    }
    if (testsRun) {
        activity.tests_run = true;
    }
    if (memoryWrites > 0) {
        activity.memory_writes = memoryWrites;
    }
    if (todoWrites > 0) {
        activity.todo_writes = todoWrites;
    }

    return activity;
}

/**
 * Whether any command segment runs a known test runner.
 *
 * Anchored to the segment's command word rather than the whole string, so `echo 'npm test'` is an argument
 * and not a test run. Lead assignments (`FOO=1 npm test`) are dropped first; wrappers like `timeout` are not
 * unwrapped, because the cost of missing one is a reminder, not a permission.
 */
function runsTests(command: string): boolean {
    for (const segment of command.split(/[;&|\n]/u)) {
        const words = segment
            .trim()
            .split(/\s+/u)
            .filter((word) => word !== "");
        while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) {
            words.shift();
        }

        const invocation = words.join(" ");
        if (invocation !== "" && TEST_COMMANDS.some((pattern) => pattern.test(invocation))) {
            return true;
        }
    }

    return false;
}

function isMemoryPath(relative: string): boolean {
    return relative.startsWith(".pi/agent/memory/") || relative.includes("/.pi/agent/memory/");
}

/** A path relative to the working directory, or absolute when it resolves outside it. */
function relativePath(cwd: string, target: string): string {
    const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    const relative = path.relative(cwd, absolute);
    if (relative === "" || relative.startsWith("..")) {
        return absolute;
    }

    return relative;
}

interface ToolCall {
    name: string;
    arguments: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCalls(content: unknown): ToolCall[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const calls: ToolCall[] = [];
    for (const part of content) {
        if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") {
            continue;
        }

        calls.push({ name: part.name, arguments: part.arguments });
    }

    return calls;
}

function argumentText(args: unknown, key: string): string | undefined {
    if (!isRecord(args)) {
        return undefined;
    }

    const value = args[key];
    return typeof value === "string" ? value : undefined;
}

function todoState(entries: readonly SessionEntry[]): ReminderTodoState | undefined {
    const snapshot = getTodoSnapshotFromEntries(entries);
    if (snapshot === undefined) {
        return undefined;
    }

    try {
        const list = parseTodoList(snapshot.content);
        const total = list.items.length;
        if (total === 0) {
            return undefined;
        }

        const completed = list.items.filter((item) => item.status === "completed").length;
        const current = list.items.find((item) => item.status === "in_progress")?.title.trim();
        const state: ReminderTodoState = { completed, total };
        if (current !== undefined && current !== "") {
            state.current = current.slice(0, 80);
        }

        return state;
    } catch {
        return undefined;
    }
}

function projectMemoryNames(entries: readonly SessionEntry[]): string[] {
    const entry = entries.findLast(
        (candidate) => candidate.type === "custom" && candidate.customType === MEMORY_INDEX_ENTRY,
    );
    if (entry === undefined || entry.type !== "custom" || !isRecord(entry.data)) {
        return [];
    }

    const memories = entry.data.projectMemories;
    if (!Array.isArray(memories)) {
        return [];
    }

    const names: string[] = [];
    for (const memory of memories) {
        if (isRecord(memory) && typeof memory.name === "string") {
            names.push(memory.name);
        }
    }

    return names.slice(0, MAX_MEMORY_NAMES);
}
