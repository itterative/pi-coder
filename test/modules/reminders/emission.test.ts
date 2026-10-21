import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerRemindersExtension, { modelChoiceOf } from "../../../src/modules/reminders";
import type { ReminderConsult } from "../../../src/modules/decision";
import { ROTATION_REMINDERS } from "../../../src/modules/reminders/catalog";
import { createPiStub, stubContext, stubSessionManager, type PiStub } from "../../helpers/pi-stub";

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

function harness(options: { scope?: "full" | "memory" } = {}): PiStub {
    const stub = createPiStub();
    registerRemindersExtension(stub.pi, options);
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

beforeEach(() => {
    ctx = stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({ getBranch: () => [] }),
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("reminder emission", () => {
    it("emits the memory reminder as hidden context on the first turn", async () => {
        const stub = harness();
        await startSession(stub);

        const result = await userTurn(stub);

        expect(result?.message?.customType).toBe("pi-coder-reminder");
        expect(result?.message?.display).toBe(false);
        expect(result?.message?.content).toContain("<pi_coder_reminder>");
        expect(result?.message?.content).toContain("memory_system");
    });

    it("rotates after the configured number of turns", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "2");
        const stub = harness();
        await startSession(stub);

        expect((await userTurn(stub))?.message?.content).toContain("memory_system");
        expect(await userTurn(stub)).toBeUndefined();

        const rotated = await userTurn(stub);

        expect(rotated?.message?.content).toContain("memory-audit");
    });

    it("emits nothing when PI_CODER_REMINDER is false", async () => {
        vi.stubEnv("PI_CODER_REMINDER", "false");
        const stub = harness();
        await startSession(stub);

        expect(await userTurn(stub)).toBeUndefined();
    });

    it("re-arms the memory reminder after a compaction", async () => {
        const stub = harness();
        await startSession(stub);
        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        await stub.requireHandler("session_compact")({ reason: "manual" }, ctx);

        expect((await userTurn(stub))?.message?.content).toContain("memory_system");
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
        const stub = harness();
        await startSession(stub);
        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
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
        expect(String(stub.sentMessages[0]?.message.content)).toContain("memory-audit");
        expect(stub.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });

        // The baseline moved, so the next user turn does not repeat it.
        expect(await userTurn(stub)).toBeUndefined();
    });

    it("crosses the threshold at the assistant baseline too", async () => {
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

        expect(stub.sentMessages).toHaveLength(1);
        expect(String(stub.sentMessages[0]?.message.content)).toContain("memory-audit");
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

    it("records a debug entry when asked", async () => {
        vi.stubEnv("PI_CODER_REMINDER_DEBUG", "true");
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        expect(stub.entries).toHaveLength(1);
        expect(stub.entries[0]?.customType).toBe("pi-coder-reminder:debug");
        expect(stub.entries[0]?.data).toMatchObject({ reminder: "memory-read", scope: "full" });
    });
});

describe("modelChoiceOf", () => {
    function consult(decision: ReminderConsult["decision"]): ReminderConsult {
        return { decision, status: "answered", latencyMs: 1 };
    }

    it("maps a chosen reminder id, none, and unreadable answers", () => {
        expect(modelChoiceOf(consult({ kind: "reminder", id: "sandbox" }))).toBe("sandbox");
        expect(modelChoiceOf(consult({ kind: "none" }))).toBe("none");
        expect(modelChoiceOf(consult(undefined))).toBeUndefined();
    });

    it("ignores an id the module never offered", () => {
        const offered = ROTATION_REMINDERS[0]?.id;

        expect(offered).toBeDefined();
        expect(modelChoiceOf(consult({ kind: "reminder", id: "not-a-reminder" }))).toBeUndefined();
    });
});
