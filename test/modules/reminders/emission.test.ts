import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerRemindersExtension, { modelChoiceOf } from "../../../src/modules/reminders";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    toolCall,
} from "../../helpers/session-branch";
import type { ReminderConsult, ReminderSignals } from "../../../src/modules/decision";
import { ACTIVE_ROTATION_REMINDERS } from "../../../src/modules/reminders/catalog";
import {
    createPiStub,
    stubContext,
    stubSessionContext,
    stubSessionManager,
    type PiStub,
} from "../../helpers/pi-stub";

/**
 * The emission path: one hidden custom message per user turn, armed by the session lifecycle and suppressed
 * entirely by `PI_CODER_REMINDER=false`. Settings are read at registration, so each test stubs the
 * environment before building its harness.
 */

interface ReminderMessage {
    customType: string;
    content: string;
    display: boolean;
}

type BeforeAgentStartResult = { message?: ReminderMessage } | undefined;

let ctx: ExtensionContext;
/** The extension's judgement queue, so a case waits for a deferred decision the way the next hook would. */
let idle: () => Promise<void>;

function harness(options: { scope?: "full" | "memory" } = {}): PiStub {
    const stub = createPiStub();
    idle = registerRemindersExtension(stub.pi, options).idle;
    return stub;
}

async function startSession(stub: PiStub): Promise<void> {
    await stub.requireHandler("session_start")({ reason: "startup" }, ctx);
}

/**
 * One user turn, as pi runs it: the handler resolves, then the deferred judgement settles.
 *
 * An armed reminder (the memory list changed, or the transcript was folded) is decided at the boundary and
 * comes back from the handler; a judged rotation turn delivers its reminder after the boundary, so the send it
 * made is what this reports.
 */
async function userTurn(stub: PiStub): Promise<BeforeAgentStartResult> {
    const before = stub.sentMessages.length;
    const result = (await stub.requireHandler("before_agent_start")(
        { systemPrompt: "", prompt: "do the thing" },
        ctx,
    )) as BeforeAgentStartResult;

    await idle();
    if (result?.message !== undefined) {
        return result;
    }

    const sent = stub.sentMessages
        .slice(before)
        .findLast((entry) => entry.message.customType === "pi-coder-reminder");
    return sent === undefined
        ? undefined
        : {
              message: {
                  customType: sent.message.customType,
                  content: String(sent.message.content),
                  display: sent.message.display,
              },
          };
}

/**
 * Point the harness at a branch holding one read: the inferred state is `exploring`, whose pool is
 * `delegation` and `todo`. A branch with no activity at all reads `discussing`, where only the list (and only
 * with an open list) is offered, so a rotation case needs a state that has candidates.
 */
function useExploringBranch(): void {
    const manager = sessionManager("/tmp/reminder-project");
    manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 1));
    const entries = manager.getBranch();

    ctx = stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({
            getBranch: () => entries,
            getSessionFile: () => "/tmp/pi/sessions/folded.jsonl",
        }),
    });
}

beforeEach(() => {
    ctx = stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({
            getBranch: () => [],
            getSessionFile: () => "/tmp/pi/sessions/folded.jsonl",
        }),
    });
});

function appendUser(manager: SessionManager, text: string, timestamp: number): void {
    manager.appendMessage({ role: "user", content: text, timestamp });
}

/** One delivered reminder, as the branch records it: the message's `details` carry id and turn. */
function appendReminder(manager: SessionManager, id: string, turn: number): void {
    manager.appendCustomMessageEntry(
        "pi-coder-reminder",
        `<pi_coder_reminder>${id}</pi_coder_reminder>`,
        false,
        { id, turn },
    );
}

/** An open TODO list, so the `todo` gate allows the rotation id the navigation test expects. */
const TODO_DOCUMENT = `---
version: 1
todos:
  - id: first
    title: First step
    status: completed
  - id: second
    title: Second step
    status: pending
---
`;

afterEach(() => {
    vi.unstubAllEnvs();
    cleanupBranches();
});

describe("reminder emission", () => {
    it("emits the memory reminder as hidden context on the first turn", async () => {
        const stub = harness();
        await startSession(stub);

        const result = await userTurn(stub);

        expect(result?.message?.customType).toBe("pi-coder-reminder");
        expect(result?.message?.display).toBe(false);
        expect(result?.message?.content).toContain("<pi_coder_reminder>");
        // The block says it is automated, because it rides in the user role.
        expect(result?.message?.content).toContain("not from the user");
        expect(result?.message?.content).toContain("memory_system");
    });

    it("rotates after the configured number of turns", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "2");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);

        expect((await userTurn(stub))?.message?.content).toContain("memory_system");
        expect(await userTurn(stub)).toBeUndefined();

        const rotated = await userTurn(stub);

        // The turn has only read, so the pool is delegation and the list; the rotation starts at delegation.
        expect(rotated?.message?.content).toContain("scout");
    });

    it("emits nothing when PI_CODER_REMINDER is false", async () => {
        vi.stubEnv("PI_CODER_REMINDER", "false");
        const stub = harness();
        await startSession(stub);

        expect(await userTurn(stub)).toBeUndefined();
    });

    it("arms the compaction reminder after a compaction", async () => {
        const stub = harness();
        await startSession(stub);
        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        await stub.requireHandler("session_compact")({ reason: "manual" }, ctx);

        const folded = await userTurn(stub);
        // The fold's own reminder covers both the rebuilt memory list and the TODO state the summary does
        // not carry, and names this session's transcript for the detail the summary lost.
        expect(folded?.message?.content).toContain("compacted");
        expect(folded?.message?.content).toContain("TODO.md");
        expect(folded?.message?.content).toContain("/tmp/pi/sessions/folded.jsonl");
        expect(folded?.message?.content).not.toContain("memory_system");

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        expect(entry?.data).toMatchObject({ reminder: "compaction", trigger: "session" });
    });

    it("resumes the rotation and the shown history after a tree move", async () => {
        const manager = sessionManager("/tmp/reminder-project");
        appendUser(manager, "first", 1);
        appendReminder(manager, "delegation", 1);
        manager.appendCustomEntry("pi-coder:todo-snapshot", {
            version: 1,
            content: TODO_DOCUMENT,
        });
        appendUser(manager, "second", 3);
        ctx = stubSessionContext(manager, { cwd: "/tmp/reminder-project" });

        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        const stub = harness();
        await stub.requireHandler("session_tree")({ newLeafId: "a", oldLeafId: "b" }, ctx);

        // A navigation arms nothing, so the first turn is a plain rotation turn: it must continue after
        // delegation, not restart at the top of the catalog and repeat it.
        const result = await userTurn(stub);
        expect(result?.message?.content).toContain("TODO.md");

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        expect(entry?.data).toMatchObject({ reminder: "todo", scheduler: { rotationIndex: 2 } });
        const data = entry?.data as { state?: ReminderSignals };
        // Restored from the branch: delegation was emitted at turn 1, and this decision prepares turn 3.
        expect(data.state?.reminders_shown).toContainEqual({ id: "delegation", turns_ago: 2 });
    });

    it("keeps a child-scoped session to the memory reminder only", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        const stub = harness({ scope: "memory" });
        await startSession(stub);

        expect((await userTurn(stub))?.message?.content).toContain("memory_system");
        expect(await userTurn(stub)).toBeUndefined();
        expect(await userTurn(stub)).toBeUndefined();
    });

    it("delivers the threshold reminder mid-run as a steer", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
        // The run must continue to a next inference for a steer to have a destination, which a tool call
        // guarantees. The exploring pool offers delegation, which is the steer's reminder.
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "toolcall_start" },
            },
            ctx,
        );
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
            },
            ctx,
        );

        expect(stub.sentMessages).toHaveLength(1);
        expect(stub.sentMessages[0]?.message).toMatchObject({
            customType: "pi-coder-reminder",
            display: false,
        });
        expect(String(stub.sentMessages[0]?.message.content)).toContain("scout");
        expect(stub.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });

        // The baseline moved, so the next user turn does not repeat it.
        expect(await userTurn(stub)).toBeUndefined();
    });

    it("does not steer from the assistant baseline alone", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness();
        ctx = stubContext({
            cwd: "/tmp/reminder-project",
            sessionManager: stubSessionManager({ getBranch: () => [] }),
            getContextUsage: () => ({ tokens: 150, contextWindow: 200_000, percent: 0.001 }),
        });
        await startSession(stub);
        await userTurn(stub);

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);

        // The message has not called a tool yet, so it may be the run's last; nothing is queued.
        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not steer on a text-only assistant message", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
            },
            ctx,
        );

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not offer memory-hygiene while nothing has changed", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);

        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        const next = await userTurn(stub);

        expect(next?.message?.content).toContain("scout");
        expect(next?.message?.content).not.toContain("memory-audit");
    });

    it("caps mid-run steers at one per user turn", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        vi.stubEnv("PI_CODER_REMINDER_MIDRUN_MAX", "1");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "toolcall_start" },
            },
            ctx,
        );
        // Two threshold crossings inside the same assistant message.
        for (let crossing = 0; crossing < 2; crossing += 1) {
            await stub.requireHandler("message_update")(
                {
                    message: { role: "assistant" },
                    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
                },
                ctx,
            );
        }

        expect(stub.sentMessages).toHaveLength(1);
    });

    it("does not deliver mid-run when the threshold is off", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
            },
            ctx,
        );

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not deliver mid-run in a memory-scoped child", async () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness({ scope: "memory" });
        await startSession(stub);
        await userTurn(stub);

        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
            },
            ctx,
        );

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not deliver mid-run when reminders are disabled", async () => {
        vi.stubEnv("PI_CODER_REMINDER", "false");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness();
        await startSession(stub);

        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
            },
            ctx,
        );

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("records the session decision as a debug entry by default", async () => {
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        expect(stub.entries).toHaveLength(1);
        expect(stub.entries[0]?.customType).toBe("pi-coder-reminder:debug");
        expect(stub.entries[0]?.data).toMatchObject({
            trigger: "session",
            reminder: "memory-read",
            scope: "full",
        });
    });
});

describe("modelChoiceOf", () => {
    function consult(decision: ReminderConsult["decision"]): ReminderConsult {
        return { decision, status: "answered", latencyMs: 1 };
    }

    it("maps a chosen reminder id, none, and unreadable answers", () => {
        expect(modelChoiceOf(consult({ kind: "reminder", id: "delegation" }))).toBe("delegation");
        expect(modelChoiceOf(consult({ kind: "none" }))).toBe("none");
        expect(modelChoiceOf(consult(undefined))).toBeUndefined();
    });

    it("ignores a disabled id and an id the module never offered", () => {
        const offered = ACTIVE_ROTATION_REMINDERS[0]?.id;

        expect(offered).toBeDefined();
        expect(modelChoiceOf(consult({ kind: "reminder", id: "sandbox" }))).toBeUndefined();
        expect(modelChoiceOf(consult({ kind: "reminder", id: "not-a-reminder" }))).toBeUndefined();
    });
});
