import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    REMINDER_STATE_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
    reminderResumeState,
    reminderSessionLabels,
    reminderStateMarker,
    todoItemsFrom,
} from "../../../src/modules/reminders/session-signals";
import type { ReminderId } from "../../../src/modules/reminders/types";
import type { ReminderPhase } from "../../../src/modules/decision";
import { zeroUsage } from "../../helpers/agent-doubles";

/**
 * The reminder signals: what the agent has been doing, what reminders it has already seen, the runtime TODO
 * progress, and the indexed memory names. Built from a real branch so the entry shapes are the ones
 * `SessionManager` writes, not a hand-rolled approximation.
 */

type AppendedMessage = Parameters<SessionManager["appendMessage"]>[0];

const CWD = "/repo";

const TODO_DOCUMENT = `---
version: 1
todos:
  - id: first
    title: First step
    status: completed
  - id: second
    title: Second step
    status: in_progress
---
`;

const TODO_COMPLETE_DOCUMENT = `---
version: 1
todos:
  - id: first
    title: First step
    status: completed
  - id: second
    title: Second step
    status: completed
---
`;

const temporaryDirectories: string[] = [];

function session(): SessionManager {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-signals-"));
    temporaryDirectories.push(directory);
    return SessionManager.create(CWD, directory);
}

function userEntry(text: string, timestamp: number): AppendedMessage {
    return { role: "user", content: text, timestamp };
}

function toolCallEntry(
    calls: Array<{ name: string; arguments: JsonObject }>,
    timestamp: number,
): AppendedMessage {
    const content: AssistantMessage["content"] = calls.map((call, index) => ({
        type: "toolCall",
        id: `call-${timestamp}-${index}`,
        name: call.name,
        arguments: call.arguments,
    }));

    return {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage: zeroUsage(),
        stopReason: "toolUse",
        timestamp,
    };
}

function toolResultEntry(toolCallId: string, isError: boolean, timestamp: number): AppendedMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: isError ? "failed" : "ok" }],
        isError,
        timestamp,
    };
}

/** One delivered reminder, as a branch records it: the `customType` and `details` a restart reads back. */
function appendReminder(
    manager: SessionManager,
    id: string,
    turn: number,
    contextTokens?: number,
): void {
    manager.appendCustomMessageEntry(
        "pi-coder-reminder",
        `<pi_coder_reminder>${id}</pi_coder_reminder>`,
        false,
        contextTokens === undefined ? { id, turn } : { id, turn, contextTokens },
    );
}

/** An assistant response with a given usage, for the prompt-side baseline a resume derives. */
function assistantUsageEntry(
    usage: Partial<AssistantMessage["usage"]>,
    timestamp: number,
): AppendedMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { ...zeroUsage(), ...usage },
        stopReason: "stop",
        timestamp,
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("buildReminderSignals", () => {
    it("summarizes activity, prior reminders, TODO progress, and memory names", () => {
        const manager = session();
        manager.appendMessage(userEntry("do the work", 1));
        manager.appendMessage(
            toolCallEntry(
                [
                    { name: "read", arguments: { path: "src/a.ts" } },
                    { name: "edit", arguments: { path: "src/a.ts" } },
                    { name: "write", arguments: { path: "/repo/src/b.ts" } },
                    { name: "write", arguments: { path: ".pi/agent/memory/foo.md" } },
                    { name: "edit", arguments: { path: "/tmp/scratch/TODO.md" } },
                    { name: "bash", arguments: { command: "npm run test:run" } },
                    { name: "agent", arguments: {} },
                ],
                2,
            ),
        );
        manager.appendCustomEntry("pi-memory:memory-index", {
            projectMemories: [{ name: "agents" }, { name: "testing" }],
        });
        manager.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 3,
            contextTokens: 42_000,
            shown: new Map([["sandbox", 1]]),
        });

        expect(signals).toEqual({
            cwd: CWD,
            session: {
                user_turns: 3,
                context_tokens: 42_000,
                tools: { read: 1, edit: 2, write: 2, bash: 1, agent: 1 },
                recent_tools: ["edit", "write", "write", "edit", "bash", "agent"],
                files_modified: ["src/a.ts", "src/b.ts"],
                tests_run: true,
                memory_writes: 1,
                todo_writes: 1,
                phase: "validating",
                unvalidated: false,
            },
            reminders_shown: [{ id: "sandbox", turns_ago: 2 }],
            todo: { completed: 1, total: 2, current: "Second step" },
            memories: ["agents", "testing"],
        });
    });

    it("omits every empty section and the tool map when nothing ran", () => {
        const manager = session();
        manager.appendMessage(userEntry("hello", 1));

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 1,
            contextTokens: 0,
            shown: new Map(),
        });

        expect(signals).toEqual({
            cwd: CWD,
            session: { user_turns: 1, context_tokens: 0, phase: "discussing" },
        });
    });

    it("ignores an unreadable memory index and a TODO snapshot that does not parse", () => {
        const manager = session();
        manager.appendCustomEntry("pi-memory:memory-index", { projectMemories: "nope" });
        manager.appendCustomEntry("pi-coder:todo-snapshot", { version: 1, content: "not a todo" });

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 2,
            contextTokens: 0,
            shown: new Map(),
        });

        expect(signals.memories).toBeUndefined();
        expect(signals.todo).toBeUndefined();
    });

    it("returns the parsed TODO items behind the latest snapshot", () => {
        const manager = session();
        manager.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });

        expect(todoItemsFrom(manager.getBranch())).toEqual([
            { id: "first", title: "First step", status: "completed" },
            { id: "second", title: "Second step", status: "in_progress" },
        ]);
        expect(todoItemsFrom([])).toBeUndefined();
    });

    it("infers implementation and unvalidated changes without the model", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "write", arguments: { path: "src/a.ts" } }], 1),
        );

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 2,
            contextTokens: 0,
            shown: new Map(),
        });

        expect(signals.session).toMatchObject({ phase: "implementing", unvalidated: true });
    });

    it("treats a document write as recording work rather than a code change", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "write", arguments: { path: "docs/plan.md" } }], 1),
        );

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 2,
            contextTokens: 0,
            shown: new Map(),
        });

        // A plan edit is the recording phase: it changed the branch, but not the code the validation
        // reminder is about, so a doc-only turn is not unvalidated work.
        expect(signals.session).toMatchObject({ doc_writes: 1, phase: "documenting" });
        expect(signals.session?.files_modified).toBeUndefined();
        expect(signals.session?.unvalidated).toBeUndefined();
    });

    it("keeps a document write from excusing a code change", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );
        manager.appendMessage(
            toolCallEntry([{ name: "write", arguments: { path: "docs/plan.md" } }], 2),
        );

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 2,
            contextTokens: 0,
            shown: new Map(),
        });

        // The doc write neither joins `files_modified` nor moves the last write past the last run, so the
        // code change stays unvalidated.
        expect(signals.session).toMatchObject({
            doc_writes: 1,
            files_modified: ["src/a.ts"],
            phase: "implementing",
            unvalidated: true,
        });
    });

    it("infers exploration from reads alone", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "read", arguments: { path: "src/a.ts" } }], 1),
        );

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 2,
            contextTokens: 0,
            shown: new Map(),
        });

        expect(signals.session).toMatchObject({ phase: "exploring" });
        expect(signals.session?.unvalidated).toBeUndefined();
    });

    it("keeps the accepted labels and hands the activity only what they leave unanswered", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 4,
            contextTokens: 0,
            shown: new Map(),
            labels: { phase: "validating", finishing: true, unvalidated: false },
        });

        // The accepted phase is the anchor the accept rule holds in `decision/reminder.ts`; the activity scan
        // is the bootstrap, not the judge - and it is the only source of `unvalidated` now, so a value recorded
        // by an older session cannot freeze in place.
        expect(signals.session).toMatchObject({
            phase: "validating",
            unvalidated: true,
        });
    });

    it("infers discussing for a turn that changed and read nothing", () => {
        const manager = session();
        manager.appendMessage(userEntry("hello", 1));

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 1,
            contextTokens: 0,
            shown: new Map(),
        });

        // The scan answers every turn, so the state is never empty: a turn that neither changed nor read
        // anything is the one the criteria call `discussing`.
        expect(signals.session?.phase).toBe("discussing");
        expect(signals.session?.finishing).toBeUndefined();
    });

    it("reads the persisted phase from the last state entry and drops bad fields", () => {
        const manager = session();
        manager.appendCustomEntry(REMINDER_STATE_TYPE, {
            phase: "documenting",
            finishing: true,
            unvalidated: "nope",
        });

        // Only the phase: the labels an older session recorded for `finishing`/`unvalidated` are not read back,
        // because the questions behind them are gone and a frozen value would outrank the activity inference.
        expect(reminderLabelsFromEntries(manager.getBranch())).toEqual({ phase: "documenting" });
    });

    it("keeps the persisted phase across a compaction", () => {
        const manager = session();
        manager.appendCustomEntry(REMINDER_STATE_TYPE, { phase: "documenting", finishing: true });
        manager.appendCompaction("folded", null, 1000);

        // The branch still reaches the pre-fold entry, so a post-compaction restart re-reads the phase
        // instead of dropping it. Only the memory index treats a compaction as a hard boundary, because
        // its snapshot is rebuilt from the filesystem rather than re-read.
        expect(reminderLabelsFromEntries(manager.getBranch())).toEqual({ phase: "documenting" });
    });

    it("does not count a test-looking string inside other commands", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "bash", arguments: { command: "echo 'npm test'" } }], 1),
        );

        const signals = buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 1,
            contextTokens: 0,
            shown: new Map(),
        });

        // `echo` is the command; the quoted text is an argument, and the pattern anchors on the command word.
        expect(signals.session?.tests_run).toBeUndefined();
    });
});

describe("reminderSessionLabels", () => {
    it("infers the phase from the branch when the model assigned nothing", () => {
        const manager = session();
        manager.appendMessage(userEntry("do the work", 1));
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 2),
        );

        expect(reminderSessionLabels({ entries: manager.getBranch(), cwd: CWD })).toEqual({
            phase: "implementing",
            unvalidated: true,
        });
    });

    it("lets the accepted phase stand over the activity", () => {
        const manager = session();
        manager.appendMessage(userEntry("do the work", 1));
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 2),
        );

        const labels = reminderSessionLabels({
            entries: manager.getBranch(),
            cwd: CWD,
            labels: { phase: "validating" },
        });

        // The accepted phase is what the consult reasoned from, so it stands; the field it did not answer
        // (`unvalidated`) comes from the activity.
        expect(labels).toEqual({ phase: "validating", unvalidated: true });
    });

    it("infers the phase while nothing is accepted yet", () => {
        const manager = session();
        manager.appendMessage(userEntry("do the work", 1));
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 2),
        );

        const labels = reminderSessionLabels({ entries: manager.getBranch(), cwd: CWD });

        expect(labels).toEqual({ phase: "implementing", unvalidated: true });
    });

    it("reads discussing from a branch with no activity", () => {
        expect(reminderSessionLabels({ entries: [], cwd: CWD })).toEqual({ phase: "discussing" });
    });
});

describe("reminderStateMarker", () => {
    it("renders a recorded phase as one annotation line", () => {
        const manager = session();
        manager.appendCustomEntry(REMINDER_STATE_TYPE, { phase: "documenting" });

        // The marker is the line itself: no role prefix, and only the phase, which is what the probe's
        // `--annotate` inserted into the transcript.
        expect(reminderStateMarker(manager.getBranch().at(-1) as SessionEntry)).toBe(
            "State: *documenting*",
        );
    });

    it("ignores every other entry, and a phase it cannot name", () => {
        const manager = session();
        manager.appendMessage(userEntry("hello", 1));
        manager.appendCustomEntry("pi-memory:memory-index", { projectMemories: [] });
        manager.appendCustomEntry(REMINDER_STATE_TYPE, { finishing: true });
        manager.appendCustomEntry(REMINDER_STATE_TYPE, { phase: "not-a-phase" });

        const phases = manager
            .getBranch()
            .map((entry) => reminderStateMarker(entry))
            .filter((marker) => marker !== undefined);

        expect(phases).toEqual([]);
    });
});

describe("reminderResumeState", () => {
    it("rebuilds the turns, the shown history, and the last rotation id", () => {
        const manager = session();
        manager.appendMessage(userEntry("first", 1));
        appendReminder(manager, "delegation", 1);
        manager.appendMessage(userEntry("second", 3));

        const state = reminderResumeState(manager.getBranch());
        expect(state?.userTurns).toBe(2);
        expect(state?.lastEmitTurn).toBe(1);
        expect(state?.lastRotationId).toBe("delegation");
        expect([...(state?.shown ?? new Map())]).toEqual([["delegation", 1]]);
    });

    it("does not track the memory reminder in shown but does count its turn", () => {
        const manager = session();
        appendReminder(manager, "memory-read", 1);

        const state = reminderResumeState(manager.getBranch());
        expect(state?.lastEmitTurn).toBe(1);
        expect(state?.lastRotationId).toBeUndefined();
        expect(state?.shown.size).toBe(0);
    });

    it("ignores emissions before the last compaction", () => {
        const manager = session();
        appendReminder(manager, "delegation", 1);
        manager.appendCompaction("folded", null, 1000);
        manager.appendMessage(userEntry("after", 2));

        // The fold is a full reset, so its pre-fold rotation must not leak into a post-fold resume.
        const state = reminderResumeState(manager.getBranch());
        expect(state?.userTurns).toBe(1);
        expect(state?.lastEmitTurn).toBe(0);
        expect(state?.lastRotationId).toBeUndefined();
        expect(state?.shown.size).toBe(0);
    });

    it("returns undefined for a branch with nothing to resume", () => {
        expect(reminderResumeState(session().getBranch())).toBeUndefined();
    });

    it("resumes the threshold baseline from the last reminder's stamped context", () => {
        const manager = session();
        appendReminder(manager, "delegation", 1, 5_000);

        expect(reminderResumeState(manager.getBranch())?.baselineContext).toBe(5_000);
    });

    it("derives the baseline from the prompt side of the response after an unstamped reminder", () => {
        const manager = session();
        appendReminder(manager, "compaction", 1);
        manager.appendMessage(
            assistantUsageEntry({ input: 3_000, cacheRead: 500, cacheWrite: 200 }, 2),
        );

        // The prompt side, never `totalTokens`, which would fold in that response's output - growth that came
        // after the reminder rather than before it.
        expect(reminderResumeState(manager.getBranch())?.baselineContext).toBe(3_700);
    });

    it("leaves the baseline unset when no response has measured the context yet", () => {
        const manager = session();
        appendReminder(manager, "memory-read", 1);

        expect(reminderResumeState(manager.getBranch())?.baselineContext).toBeUndefined();
    });
});

describe("availableRotationIds", () => {
    /** The pool a branch produces, with optional accepted labels on top of what the scan infers. */
    function availability(manager: SessionManager, labels?: { phase?: ReminderPhase }) {
        return availableRotationIds(
            buildReminderSignals({
                entries: manager.getBranch(),
                cwd: CWD,
                currentTurn: 1,
                contextTokens: 0,
                shown: new Map(),
                labels,
            }),
        );
    }

    /** The pool as a list, in catalog order, so an expectation states the whole offer. */
    function offered(manager: SessionManager, labels?: { phase?: ReminderPhase }): ReminderId[] {
        return [...availability(manager, labels)];
    }

    it("offers the list only, while the turn is still discussing", () => {
        const discussing = session();
        discussing.appendMessage(userEntry("tell me about this", 1));
        discussing.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });

        // `delegation` is about work underway and both hand-back reminders need something produced, so a turn
        // that has neither changed nor read anything offers only the TODO list.
        expect(offered(discussing)).toEqual(["todo"]);
    });

    it("offers delegation and the list while exploring, not the hand-back reminders", () => {
        const exploring = session();
        exploring.appendMessage(
            toolCallEntry([{ name: "read", arguments: { path: "src/a.ts" } }], 1),
        );
        exploring.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });

        expect(offered(exploring)).toEqual(["delegation", "todo"]);
    });

    it("offers every produced-work reminder while implementing", () => {
        const implementing = session();
        implementing.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );
        implementing.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });

        // `validation` is offered here on purpose: an unvalidated change under construction is exactly when
        // an agent can call the work finished without running anything.
        expect(offered(implementing)).toEqual([
            "memory-hygiene",
            "delegation",
            "todo",
            "validation",
        ]);
    });

    it("drops delegation and the list once the turn is validating", () => {
        const validating = session();
        validating.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );
        validating.appendMessage(
            toolCallEntry([{ name: "bash", arguments: { command: "npm test" } }], 2),
        );
        validating.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });

        // The advice to split work or keep the list current has passed; what is left to say is about
        // finishing, which is what the hand-back pair is for.
        expect(offered(validating)).toEqual(["memory-hygiene", "validation"]);
    });

    it("offers the hand-back pair from a recording state", () => {
        const documenting = session();
        documenting.appendMessage(
            toolCallEntry([{ name: "write", arguments: { path: "docs/plan.md" } }], 1),
        );

        expect(offered(documenting)).toEqual(["memory-hygiene", "validation"]);
    });

    it("lets an accepted state decide the pool over what the scan can see", () => {
        const manager = session();
        manager.appendMessage(userEntry("report back", 1));

        // The scan reads `discussing` here; the accepted `reporting` is the state the session is in, and it
        // is what the pool follows.
        expect(offered(manager, { phase: "reporting" })).toEqual(["memory-hygiene", "validation"]);
        expect(offered(manager, { phase: "discussing" })).toEqual([]);
    });

    it("gates the list on an open list whatever the state says", () => {
        const exploring = session();
        exploring.appendMessage(
            toolCallEntry([{ name: "read", arguments: { path: "src/a.ts" } }], 1),
        );
        expect(availability(exploring).has("todo")).toBe(false);

        exploring.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_COMPLETE_DOCUMENT,
        });
        expect(availability(exploring).has("todo")).toBe(false);

        exploring.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });
        expect(availability(exploring).has("todo")).toBe(true);
    });
});

describe("outcome-aware validation", () => {
    function signalsOf(manager: SessionManager) {
        return buildReminderSignals({
            entries: manager.getBranch(),
            cwd: CWD,
            currentTurn: 1,
            contextTokens: 0,
            shown: new Map(),
        });
    }

    function editedThenTested(manager: SessionManager): void {
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );
        manager.appendMessage(
            toolCallEntry([{ name: "bash", arguments: { command: "npm test" } }], 2),
        );
        manager.appendMessage(toolResultEntry("call-2-0", false, 3));
    }

    it("treats edits after the last passing run as unvalidated again", () => {
        const manager = session();
        editedThenTested(manager);

        expect(signalsOf(manager).session).toMatchObject({
            tests_run: true,
            unvalidated: false,
            phase: "validating",
        });

        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/b.ts" } }], 4),
        );

        expect(signalsOf(manager).session).toMatchObject({
            unvalidated: true,
            phase: "implementing",
        });
    });

    it("treats a run that failed after the last change as unvalidated and validating", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );
        manager.appendMessage(
            toolCallEntry([{ name: "bash", arguments: { command: "npm test" } }], 2),
        );
        manager.appendMessage(toolResultEntry("call-2-0", true, 3));

        expect(signalsOf(manager).session).toMatchObject({
            tests_run: true,
            last_test_failed: true,
            unvalidated: true,
            phase: "validating",
        });
    });

    it("clears the failure when a later run passes", () => {
        const manager = session();
        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1),
        );
        manager.appendMessage(
            toolCallEntry([{ name: "bash", arguments: { command: "npm test" } }], 2),
        );
        manager.appendMessage(toolResultEntry("call-2-0", true, 3));
        manager.appendMessage(
            toolCallEntry([{ name: "bash", arguments: { command: "npm test" } }], 4),
        );
        manager.appendMessage(toolResultEntry("call-4-0", false, 5));

        const session_ = signalsOf(manager).session;
        expect(session_?.last_test_failed).toBeUndefined();
        expect(session_?.unvalidated).toBe(false);
        expect(session_?.phase).toBe("validating");
    });
});
