import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
    REMINDER_STATE_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderLabelsFromEntries,
    reminderResumeState,
} from "../../../src/modules/reminders/session-signals";
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
function appendReminder(manager: SessionManager, id: string, turn: number): void {
    manager.appendCustomMessageEntry(
        "pi-coder-reminder",
        `<pi_coder_reminder>${id}</pi_coder_reminder>`,
        false,
        { id, turn },
    );
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
                phase: "verifying",
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
            session: { user_turns: 1, context_tokens: 0 },
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

    it("lets persisted model labels win over inference", () => {
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
            labels: { phase: "debugging", finishing: true, unvalidated: false },
        });

        expect(signals.session).toMatchObject({
            phase: "debugging",
            finishing: true,
            unvalidated: false,
        });
    });

    it("reads persisted labels from the last state entry and drops bad fields", () => {
        const manager = session();
        manager.appendCustomEntry(REMINDER_STATE_TYPE, {
            phase: "wrapping_up",
            finishing: true,
            unvalidated: "nope",
        });

        expect(reminderLabelsFromEntries(manager.getBranch())).toEqual({
            phase: "wrapping_up",
            finishing: true,
        });
    });

    it("keeps persisted labels across a compaction", () => {
        const manager = session();
        manager.appendCustomEntry(REMINDER_STATE_TYPE, { phase: "wrapping_up", finishing: true });
        manager.appendCompaction("folded", null, 1000);

        // The branch still reaches the pre-fold entry, so a post-compaction restart re-reads the labels
        // instead of dropping them. Only the memory index treats a compaction as a hard boundary, because
        // its snapshot is rebuilt from the filesystem rather than re-read.
        expect(reminderLabelsFromEntries(manager.getBranch())).toEqual({
            phase: "wrapping_up",
            finishing: true,
        });
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
});

describe("availableRotationIds", () => {
    function availability(manager: SessionManager, labels?: { phase?: "wrapping_up" }) {
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

    it("gates memory-hygiene out until mutating work has happened", () => {
        const manager = session();
        manager.appendMessage(userEntry("tell me about this", 1));

        const available = availability(manager);

        expect(available.has("memory-hygiene")).toBe(false);
        expect(available.has("delegation")).toBe(true);
    });

    it("gates memory-hygiene in once a code file or the TODO changed", () => {
        const edited = session();
        edited.appendMessage(toolCallEntry([{ name: "edit", arguments: { path: "src/a.ts" } }], 1));
        expect(availability(edited).has("memory-hygiene")).toBe(true);

        const todoed = session();
        todoed.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "/tmp/scratch/TODO.md" } }], 1),
        );
        expect(availability(todoed).has("memory-hygiene")).toBe(true);
    });

    it("gates memory-hygiene in for a wrapping-up label", () => {
        const manager = session();
        manager.appendMessage(userEntry("report back", 1));

        expect(availability(manager, { phase: "wrapping_up" }).has("memory-hygiene")).toBe(true);
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
            phase: "verifying",
        });

        manager.appendMessage(
            toolCallEntry([{ name: "edit", arguments: { path: "src/b.ts" } }], 4),
        );

        expect(signalsOf(manager).session).toMatchObject({
            unvalidated: true,
            phase: "implementing",
        });
    });

    it("treats a run that failed after the last change as unvalidated and debugging", () => {
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
            phase: "debugging",
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
        expect(session_?.phase).toBe("verifying");
    });
});
