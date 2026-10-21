import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
});
