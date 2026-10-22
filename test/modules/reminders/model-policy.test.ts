import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decision-model policy path: with `reminders` enabled the model decides both whether a turn gets a
 * reminder and which one, and only an unusable answer lets the deterministic schedule take over.
 *
 * The decision module is mocked because the point here is the wiring (the live prompt, the chosen id, the
 * `none` semantics), not the classifier.
 */

const mocks = vi.hoisted(() => ({
    consult: vi.fn(),
    load: vi.fn(),
}));

vi.mock("../../../src/modules/decision", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/modules/decision")>();
    return {
        ...actual,
        decisionConfig: { load: mocks.load },
        reminderEnabled: () => true,
        consultReminderSelection: mocks.consult,
    };
});

import registerRemindersExtension from "../../../src/modules/reminders";
import type { ReminderSignals } from "../../../src/modules/decision";
import { createPiStub, stubContext, stubSessionManager, type PiStub } from "../../helpers/pi-stub";

interface ReminderMessage {
    customType: string;
    content: string;
    display: boolean;
}

type BeforeAgentStartResult = { message?: ReminderMessage } | undefined;

let ctx: ExtensionContext;

function harness(): PiStub {
    const stub = createPiStub();
    registerRemindersExtension(stub.pi);
    return stub;
}

async function startSession(stub: PiStub): Promise<void> {
    await stub.requireHandler("session_start")({ reason: "startup" }, ctx);
}

async function userTurn(stub: PiStub): Promise<BeforeAgentStartResult> {
    return (await stub.requireHandler("before_agent_start")(
        { systemPrompt: "", prompt: "do the thing" },
        ctx,
    )) as BeforeAgentStartResult;
}

const TODO_DOCUMENT = `---
version: 1
todos:
  - id: first
    title: First step
    status: completed
  - id: second
    title: Second step
    status: in_progress
  - id: third
    title: Third step
    status: pending
---
`;

/** One TODO snapshot as the branch records it: the item list the query is built from. */
function todoSnapshotEntry(): SessionEntry {
    return {
        type: "custom",
        customType: "pi-coder:todo-snapshot",
        data: { version: 1, content: TODO_DOCUMENT },
        id: "todo-snapshot",
        parentId: null,
        timestamp: "2026-10-22T00:00:00.000Z",
    };
}

function contextWithTodo(): ExtensionContext {
    return stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({ getBranch: () => [todoSnapshotEntry()] }),
    });
}

beforeEach(() => {
    ctx = stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({ getBranch: () => [] }),
    });
    mocks.consult.mockReset();
    mocks.load.mockReset();
    mocks.load.mockReturnValue({ enabled: true, reminders: true });
    mocks.consult.mockResolvedValue({
        decision: { kind: "reminder", id: "delegation" },
        state: { phase: "implementing" },
        status: "answered",
        latencyMs: 1,
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("decision-model reminder policy", () => {
    it("does not consult on the session-reminder turn", async () => {
        const stub = harness();
        await startSession(stub);

        expect((await userTurn(stub))?.message?.content).toContain("memory_system");
        expect(mocks.consult).not.toHaveBeenCalled();
    });

    it("sends the live prompt, the signals, and emits the model's choice", async () => {
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        const result = await userTurn(stub);

        expect(result?.message?.content).toContain("scout");

        const first = mocks.consult.mock.calls[0]?.[0] as {
            request?: string;
            signals?: ReminderSignals;
        };
        expect(first.request).toBe("do the thing");
        expect(first.signals?.session).toMatchObject({ user_turns: 2, context_tokens: 0 });

        // The emission and the piggybacked labels are visible to the next consult.
        await userTurn(stub);
        const second = mocks.consult.mock.calls[1]?.[0] as { signals?: ReminderSignals };
        expect(second.signals?.reminders_shown).toEqual([{ id: "delegation", turns_ago: 1 }]);
        expect(second.signals?.session).toMatchObject({ phase: "implementing" });

        // Labels persist once per real change, not once per turn.
        expect(
            stub.entries.filter((entry) => entry.customType === "pi-coder:reminder-state"),
        ).toEqual([{ customType: "pi-coder:reminder-state", data: { phase: "implementing" } }]);
    });

    it("records the state and the gate on the decision entry", async () => {
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await userTurn(stub);

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        expect(entry?.data).toMatchObject({
            trigger: "turn",
            reminder: "delegation",
            scope: "full",
            modelChoice: "delegation",
            // The pre-decision snapshot, which is why the state carries user_turns 2 and this carries 1.
            scheduler: { userTurns: 1, sessionArmed: false },
        });

        const data = entry?.data as {
            state?: ReminderSignals;
            available?: string[];
            options?: string[];
        };
        expect(data.state?.session).toMatchObject({ user_turns: 2 });
        expect(data.available).toContain("delegation");
        expect(data.available).not.toContain("memory-hygiene");
        expect(data.options).toContain("delegation");
    });

    it("treats none as final but falls back when the consult is unusable", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        mocks.consult.mockResolvedValue({
            decision: { kind: "none" },
            status: "answered",
            latencyMs: 1,
        });
        expect(await userTurn(stub)).toBeUndefined();

        mocks.consult.mockResolvedValue({ status: "error", latencyMs: 1 });
        expect((await userTurn(stub))?.message?.content).toContain("scout");
    });

    it("forces the todo reminder when the query reads a move to a pending item", async () => {
        ctx = contextWithTodo();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        mocks.consult.mockResolvedValue({
            decision: { kind: "none" },
            extras: {
                todo_item_third: { type: "bool", probability: 0.8 },
                todo_outside: { type: "bool", probability: 0.2 },
            },
            status: "answered",
            latencyMs: 1,
        });

        const result = await userTurn(stub);

        expect(result?.message?.content).toContain("TODO.md");
        const sent = mocks.consult.mock.calls[0]?.[0] as {
            extraQuestions?: Record<string, unknown>;
        };
        expect(Object.keys(sent.extraQuestions ?? {})).toEqual(["todo_item_third", "todo_outside"]);

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        expect(entry?.data).toMatchObject({
            reminder: "todo",
            modelChoice: "todo",
            todoMove: { id: "third", probability: 0.8 },
            todoScores: { third: 0.8, outside: 0.2 },
        });
    });

    it("lets an explicit reminder pick win over the detected move, and still records it", async () => {
        ctx = contextWithTodo();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        mocks.consult.mockResolvedValue({
            decision: { kind: "reminder", id: "delegation" },
            extras: {
                todo_item_third: { type: "bool", probability: 0.8 },
                todo_outside: { type: "bool", probability: 0.2 },
            },
            status: "answered",
            latencyMs: 1,
        });

        const result = await userTurn(stub);

        expect(result?.message?.content).toContain("scout");
        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        expect(entry?.data).toMatchObject({
            reminder: "delegation",
            modelChoice: "delegation",
            todoMove: { id: "third", probability: 0.8 },
        });
    });

    it("does not ask the TODO query when the list has nothing the work could move to", async () => {
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await userTurn(stub);

        const sent = mocks.consult.mock.calls[0]?.[0] as { extraQuestions?: unknown };
        expect(sent.extraQuestions).toBeUndefined();
    });
});
