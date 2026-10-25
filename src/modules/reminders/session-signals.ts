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
import { parseTodoList, type TodoItem } from "../todolist/parser";
import { ACTIVE_ROTATION_REMINDERS } from "./catalog";
import type { ReminderId } from "./types";

/**
 * The context the decision model judges a reminder by, derived from the session branch and the module's own
 * emission history.
 *
 * The recent window in `decisionSessionContext` is a planned window of user, assistant and tool items, so the
 * state reads what was done; everything here is still a bounded summary — counts, small lists, and the current
 * TODO progress — and never transcript text beyond the request and the window.
 */

/** How many paths, recent tool names, and memory names the state carries. */
const MAX_FILES_MODIFIED = 8;
const MAX_RECENT_TOOLS = 6;
const MAX_MEMORY_NAMES = 24;

/** The entry the memory module records its index under; read structurally rather than importing its private type. */
const MEMORY_INDEX_ENTRY = "pi-memory:memory-index";

/** The session entry the accepted state labels are persisted under; it is also the window's annotation. */
export const REMINDER_STATE_TYPE = "pi-coder:reminder-state";

/**
 * The `customType` of a delivered reminder message.
 *
 * Its `details` carry the id and the turn it was emitted on, which is how a later restart on a populated
 * branch rebuilds what was already shown without a separate marker entry.
 */
export const REMINDER_CUSTOM_TYPE = "pi-coder-reminder";

/** The `custom` entry each selection decision is recorded under, so a replay can read what live decided. */
export const REMINDER_DEBUG_ENTRY_TYPE = "pi-coder-reminder:debug";

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

export interface ReminderLabelInput {
    entries: readonly SessionEntry[];
    cwd: string;
    /**
     * The accepted labels so far, when any are. They are the anchor the accept rule holds: the activity scan
     * is what an unanchored session (and a session with the model off) reports instead.
     */
    labels?: ReminderStateLabels;
}

export interface ReminderSignalInput extends ReminderLabelInput {
    /** The turn being prepared, counting from 1 after a reset. */
    currentTurn: number;
    contextTokens: number;
    /** When each rotation reminder was shown, keyed by the user turn it was emitted on. */
    shown: ReadonlyMap<ReminderId, number>;
}

/**
 * The rotation ids the activity allows this turn.
 *
 * `memory-hygiene` is gated on mutating work: before any file has changed its "review what you learned"
 * text has nothing to act on. `validation` is gated the same way and on the coarse state rather than the
 * instantaneous stage - a turn that only read and searched produced nothing to validate, which is exactly
 * the noise state scoping exists to remove. `todo` is gated on a readable list with work left in it: the
 * score form ranks `todo` high even when no list exists, and a closed list has nothing left to keep current.
 * Filtering here rather than in the catalog keeps each gate a property of the session, not of the reminder.
 *
 * The state drives it: each rotation reminder names the states that offer it (`catalog.ts`), and the judged
 * state is the session's own answer to "what is happening now". The scan infers a state for every turn, so the
 * pool is always definite - a fresh session reads `discussing` until something is read or written.
 */
export function availableRotationIds(signals: ReminderSignals): ReadonlySet<ReminderId> {
    const available = new Set<ReminderId>();
    const phase = signals.session?.phase;

    for (const reminder of ACTIVE_ROTATION_REMINDERS) {
        if (reminder.id === "todo" && !hasOpenTodo(signals.todo)) {
            continue;
        }

        if (phase !== undefined && isReminderPhase(phase) && !reminder.states.includes(phase)) {
            continue;
        }

        available.add(reminder.id);
    }

    return available;
}

/** A readable TODO list with at least one item still open. */
function hasOpenTodo(todo: ReminderTodoState | undefined): boolean {
    return todo !== undefined && todo.completed < todo.total;
}

export function buildReminderSignals(input: ReminderSignalInput): ReminderSignals {
    const scan = scanActivity(input.entries, input.cwd);
    const labels = resolveSessionLabels(input.labels, inferSessionLabels(scan));
    const signals: ReminderSignals = {
        cwd: input.cwd,
        session: {
            user_turns: input.currentTurn,
            context_tokens: input.contextTokens,
            ...scan.activity,
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
 * The judged labels from a branch alone.
 *
 * The whole signal payload also builds the turn counts, the TODO read, and the memory list; a caller that only
 * shows the state - the footer's badge - needs the activity scan and nothing else. Both paths resolve through
 * `resolveSessionLabels`, so a label's rule stays in one place.
 */
export function reminderSessionLabels(input: ReminderLabelInput): ReminderStateLabels {
    const scan = scanActivity(input.entries, input.cwd);
    return resolveSessionLabels(input.labels, inferSessionLabels(scan));
}

/**
 * The state one turn reports: the accepted labels, with the activity scan filling what is not answered yet.
 *
 * The accepted phase is the one the model moved to under the confidence gate in `decision/reminder.ts`, and it
 * is what the state has to keep: it is the state the model itself reasoned from. The activity scan is the
 * bootstrap - a session that has not answered yet - and the whole answer while the model is off.
 *
 * `unvalidated` is inferred, never inherited: the question that used to answer it is gone, so a value recorded
 * by an older session would be frozen forever and would override the inference on every later turn.
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

    if (inferred.unvalidated !== undefined) {
        labels.unvalidated = inferred.unvalidated;
    }

    return labels;
}

/**
 * What the activity counts alone imply: writes without a validation success after them are unvalidated.
 *
 * This is the state a session reports before the model has answered anything, and the whole state while the
 * model is off, so every turn gets one: the falls-through end is `discussing`, a turn that neither changed nor
 * read anything.
 *
 * Known blind spot: the scan sees the `edit`/`write` tools, so a change produced through bash instead - a
 * heredoc, a redirect, or `sed -i` - leaves the activity looking read-only or empty. It is a fallback, not a
 * guarantee: the model judges the same window and is free to answer otherwise.
 */
function inferSessionLabels(scan: ActivityScan): ReminderStateLabels {
    const activity = scan.activity;
    const codeChanged = (activity.files_modified?.length ?? 0) > 0;
    const labels: ReminderStateLabels = {};

    if (codeChanged) {
        if (scan.lastTestFailed) {
            // The last test run failed: diagnosing a failure is part of the `validating` phase.
            labels.phase = "validating";
        } else if (scan.lastTestIndex >= 0 && scan.lastWriteIndex > scan.lastTestIndex) {
            // Edits after the last run moved the work back to implementation.
            labels.phase = "implementing";
        } else {
            labels.phase = activity.tests_run === true ? "validating" : "implementing";
        }
        labels.unvalidated = isUnvalidated(scan);
        return labels;
    }

    if (recordedWork(activity)) {
        // Memory, TODO and document writes are the recording phase the criteria call `documenting`, not
        // implementation: the branch changed but no code did, so nothing is left unvalidated and the
        // validation reminder has nothing to ask for. Counting a document write as a code change did both.
        labels.phase = "documenting";
        return labels;
    }

    if (hasReadTools(activity.tools)) {
        labels.phase = "exploring";
        return labels;
    }

    // Nothing changed and nothing was read: the turn is answering, debating, or deciding.
    labels.phase = "discussing";
    return labels;
}

/** Whether the branch recorded something - a memory, the TODO list, or a prose document - rather than changing code. */
function recordedWork(activity: ReminderSessionActivity): boolean {
    return (
        (activity.memory_writes ?? 0) > 0 ||
        (activity.todo_writes ?? 0) > 0 ||
        (activity.doc_writes ?? 0) > 0
    );
}

/**
 * Changes without a validation success after them.
 *
 * The branch-wide `tests_run` boolean cannot answer this on its own: it stays true after any earlier run, so
 * an edit that follows a passing run would still read as validated. Ordering the last code write against the
 * last test run fixes that, and a failed last run counts as unvalidated even when it came after the write.
 */
function isUnvalidated(scan: ActivityScan): boolean {
    if (scan.lastWriteIndex < 0) {
        return false;
    }

    if (scan.lastTestIndex < 0) {
        return true;
    }

    if (scan.lastTestFailed) {
        return true;
    }

    return scan.lastWriteIndex > scan.lastTestIndex;
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
    // Only the phase: an entry of an older session also recorded `finishing`/`unvalidated`, and those are not
    // read back any more - the questions that produced them are gone, so a recorded value would never change.
    const { phase } = entry.data;
    if (typeof phase === "string" && isReminderPhase(phase)) {
        labels.phase = phase;
    }

    return labels;
}

/**
 * One recorded state entry as the window's annotation line, or `undefined` for any other entry.
 *
 * The mid-run probe inserted its own accepted states into the transcript at the tool item where each was
 * accepted (`--annotate`), so the model reads the phase timeline in the conversation rather than confirming a
 * single claim in the state. This is that marker, in the probe's own wording (`  ── state: X ──`), so an
 * annotated transcript reads the same here as in the measurement.
 */
export function reminderStateMarker(entry: SessionEntry): string | undefined {
    if (entry.type !== "custom" || entry.customType !== REMINDER_STATE_TYPE) {
        return undefined;
    }

    const data = entry.data;
    if (!isRecord(data) || typeof data.phase !== "string" || !isReminderPhase(data.phase)) {
        return undefined;
    }

    return `  ── state: ${data.phase} ──`;
}

/** What a branch can tell a restarted module: the turns counted, what was shown, and where the pointer was. */
export interface ReminderResumeState {
    /** User turns on the branch since the last compaction. */
    userTurns: number;
    /** Rotation ids already shown, keyed by the user turn they were emitted on. */
    shown: Map<ReminderId, number>;
    /** The last rotation id emitted, so the pointer resumes after it; absent when none was. */
    lastRotationId?: ReminderId;
    /** The user turn of the last reminder of any kind, for the turn cadence. */
    lastEmitTurn: number;
    /**
     * The context the last reminder was shown at, when the branch recorded one.
     *
     * It is the reminder's own stamp, or the prompt side of the first response after it when the stamp is
     * absent (a fold's emission renders before any post-fold usage exists). Absent means the branch holds no
     * usable measurement, and the run establishes the baseline from its first usage instead.
     */
    baselineContext?: number;
}

/**
 * Rebuild the scheduler's view from a branch after a restart on a populated session.
 *
 * A delivered reminder is a `custom_message` whose `details` carry the id and the turn it was emitted on, so
 * the branch itself records what was shown. It also carries the context it was shown at, which the threshold
 * resumes from; a reminder without one (an older stamp, or a fold whose context is not known at emission) falls
 * back to the prompt side of the first response after it. Only entries after the last `compaction` are read:
 * the fold is a full reset (the module arms a change-point reminder and restarts the rotation), so pre-fold
 * emissions must not leak into a post-fold resume. `undefined` means the branch holds nothing to resume, and
 * the caller starts fresh.
 */
export function reminderResumeState(
    entries: readonly SessionEntry[],
): ReminderResumeState | undefined {
    const afterFold = entries.findLastIndex((entry) => entry.type === "compaction") + 1;
    const slice = entries.slice(afterFold);

    let userTurns = 0;
    let lastEmitTurn = 0;
    let lastRotationId: ReminderId | undefined;
    let lastReminderIndex = -1;
    let stampedContext: number | undefined;
    const shown = new Map<ReminderId, number>();

    for (const [index, entry] of slice.entries()) {
        if (entry.type === "message" && entry.message.role === "user") {
            userTurns += 1;
            continue;
        }

        if (entry.type !== "custom_message" || entry.customType !== REMINDER_CUSTOM_TYPE) {
            continue;
        }

        const details = entry.details;
        if (!isRecord(details)) {
            continue;
        }

        const id = details.id;
        const turn = details.turn;
        if (typeof id !== "string" || typeof turn !== "number" || !Number.isFinite(turn)) {
            continue;
        }

        lastEmitTurn = Math.max(lastEmitTurn, turn);
        if (isRotationId(id)) {
            shown.set(id, turn);
            lastRotationId = id;
        }

        // A 0 stamp means the context was not known when the reminder rendered, so the baseline comes from the
        // response that followed instead.
        lastReminderIndex = index;
        stampedContext =
            typeof details.contextTokens === "number" && details.contextTokens > 0
                ? details.contextTokens
                : undefined;
    }

    if (userTurns === 0 && lastEmitTurn === 0) {
        return undefined;
    }

    const baselineContext = stampedContext ?? promptTokensAfter(slice, lastReminderIndex);

    return {
        userTurns: Math.max(userTurns, lastEmitTurn),
        shown,
        ...(lastRotationId === undefined ? {} : { lastRotationId }),
        lastEmitTurn,
        ...(baselineContext === undefined ? {} : { baselineContext }),
    };
}

/**
 * The prompt side of the first assistant response after `index`: `input + cacheRead + cacheWrite`.
 *
 * That response's prompt is the context the last reminder rode in on, so it is the baseline the threshold
 * measures growth from. It is the fallback for a reminder whose own stamp is absent or 0 - the compaction
 * reminder renders before a post-fold usage exists, so there is nothing to stamp - which is what lets the fold
 * resume without a backfill write.
 */
function promptTokensAfter(entries: readonly SessionEntry[], index: number): number | undefined {
    for (const entry of entries.slice(index + 1)) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        const { usage } = entry.message;
        const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
        if (tokens > 0) {
            return tokens;
        }
    }

    return undefined;
}

/** Whether an id names a rotation reminder, which `shown` tracks; change-point reminders are not rotated. */
function isRotationId(value: string): value is ReminderId {
    return ACTIVE_ROTATION_REMINDERS.some((reminder) => reminder.id === value);
}

/**
 * The scanned activity plus the ordering the labels need.
 *
 * The counts answer "what happened"; the indices answer "in what order", which `tests_run` alone loses:
 * a test run anywhere in the branch reads the same as one after the last edit.
 */
interface ActivityScan {
    activity: ReminderSessionActivity;
    /** Entry index of the last edit/write to a code file, or -1 when none. */
    lastWriteIndex: number;
    /** Entry index of the last test-runner call, or -1 when none. */
    lastTestIndex: number;
    /** Whether the most recent test run's tool result reported an error. */
    lastTestFailed: boolean;
}

/** Tool calls, writes, and test runs observed in the branch, as counts, bounded lists, and ordering. */
function scanActivity(entries: readonly SessionEntry[], cwd: string): ActivityScan {
    const state: ActivityState = {
        tools: {},
        recentTools: [],
        files: new Set(),
        pendingTestCalls: new Set(),
        testsRun: false,
        memoryWrites: 0,
        todoWrites: 0,
        docWrites: 0,
        lastWriteIndex: -1,
        lastTestIndex: -1,
        lastTestFailed: false,
    };

    for (const [index, entry] of entries.entries()) {
        if (entry.type !== "message") {
            continue;
        }

        const { message } = entry;
        if (message.role === "toolResult") {
            applyTestResult(state, message);
            continue;
        }

        if (message.role !== "assistant") {
            continue;
        }

        for (const call of toolCalls(message.content)) {
            applyToolCall(state, call, index, cwd);
        }
    }

    return {
        activity: activityFrom(state),
        lastWriteIndex: state.lastWriteIndex,
        lastTestIndex: state.lastTestIndex,
        lastTestFailed: state.lastTestFailed,
    };
}

/** The mutable counters one scan accumulates. */
interface ActivityState {
    tools: Record<string, number>;
    recentTools: string[];
    files: Set<string>;
    /** Ids of test-runner calls whose result has not been seen yet. */
    pendingTestCalls: Set<string>;
    testsRun: boolean;
    memoryWrites: number;
    todoWrites: number;
    /** Prose documents written, counted apart from the code changes the labels read. */
    docWrites: number;
    lastWriteIndex: number;
    lastTestIndex: number;
    lastTestFailed: boolean;
}

function applyToolCall(state: ActivityState, call: ToolCall, index: number, cwd: string): void {
    state.tools[call.name] = (state.tools[call.name] ?? 0) + 1;
    state.recentTools.push(call.name);
    if (state.recentTools.length > MAX_RECENT_TOOLS) {
        state.recentTools.shift();
    }

    if (call.name === "bash") {
        applyBashCall(state, call, index);
        return;
    }

    if (!WRITE_TOOLS.has(call.name)) {
        return;
    }

    const target = argumentText(call.arguments, "path");
    if (target !== undefined) {
        applyWriteCall(state, target, index, cwd);
    }
}

function applyBashCall(state: ActivityState, call: ToolCall, index: number): void {
    const command = argumentText(call.arguments, "command");
    if (command === undefined || !runsTests(command)) {
        return;
    }

    state.testsRun = true;
    state.lastTestIndex = index;
    if (call.id !== undefined) {
        state.pendingTestCalls.add(call.id);
    }
}

/** Track a write, splitting memory files, TODO.md and documents out of the code changes the labels are about. */
function applyWriteCall(state: ActivityState, target: string, index: number, cwd: string): void {
    const relative = relativePath(cwd, target);
    if (isMemoryPath(relative)) {
        state.memoryWrites += 1;
        return;
    }

    if (path.basename(relative) === "TODO.md") {
        state.todoWrites += 1;
        return;
    }

    if (isDocumentPath(relative)) {
        state.docWrites += 1;
        return;
    }

    state.lastWriteIndex = index;
    // Re-insert so the set keeps the most recently written paths at the end.
    state.files.delete(relative);
    state.files.add(relative);
}

/** Whether a path is a prose document rather than code the labels and the validation gate are about. */
function isDocumentPath(relative: string): boolean {
    return path.extname(relative).toLowerCase() === ".md";
}

/** Only a test runner's own result matters, and only its outcome: the body is never read. */
function applyTestResult(
    state: ActivityState,
    message: { toolCallId: string; isError: boolean },
): void {
    if (!state.pendingTestCalls.delete(message.toolCallId)) {
        return;
    }

    state.lastTestFailed = message.isError === true;
}

/** Project the accumulated state onto the fields the decision state carries. */
function activityFrom(state: ActivityState): ReminderSessionActivity {
    const activity: ReminderSessionActivity = {};
    if (Object.keys(state.tools).length > 0) {
        activity.tools = state.tools;
    }
    if (state.recentTools.length > 0) {
        activity.recent_tools = state.recentTools;
    }

    const modified = [...state.files].slice(-MAX_FILES_MODIFIED);
    if (modified.length > 0) {
        activity.files_modified = modified;
    }
    if (state.testsRun) {
        activity.tests_run = true;
    }
    if (state.lastTestFailed) {
        activity.last_test_failed = true;
    }
    if (state.memoryWrites > 0) {
        activity.memory_writes = state.memoryWrites;
    }
    if (state.todoWrites > 0) {
        activity.todo_writes = state.todoWrites;
    }
    if (state.docWrites > 0) {
        activity.doc_writes = state.docWrites;
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
    id?: string;
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

        calls.push({
            ...(typeof part.id === "string" ? { id: part.id } : {}),
            name: part.name,
            arguments: part.arguments,
        });
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

/**
 * The parsed TODO items behind the latest snapshot, or `undefined` when there is no readable list.
 *
 * The signals carry only the progress summary, so the TODO query asks about these items without putting them
 * in the decision state: the question criteria are the only place they travel.
 */
export function todoItemsFrom(entries: readonly SessionEntry[]): TodoItem[] | undefined {
    const snapshot = getTodoSnapshotFromEntries(entries);
    if (snapshot === undefined) {
        return undefined;
    }

    try {
        const items = parseTodoList(snapshot.content).items;
        return items.length === 0 ? undefined : items;
    } catch {
        return undefined;
    }
}

function todoState(entries: readonly SessionEntry[]): ReminderTodoState | undefined {
    const items = todoItemsFrom(entries);
    if (items === undefined) {
        return undefined;
    }

    const completed = items.filter((item) => item.status === "completed").length;
    const current = items.find((item) => item.status === "in_progress")?.title.trim();
    const state: ReminderTodoState = { completed, total: items.length };
    if (current !== undefined && current !== "") {
        state.current = current.slice(0, 80);
    }

    return state;
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
