import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The outline nudge's decision gate: at a real trigger the module asks the selection model for a score on the
 * bounded state, and a `none` answer suppresses the emission. An unavailable answer fails open. The decision
 * module is mocked because the point is the wiring and the state shape, not the classifier.
 */

const mocks = vi.hoisted(() => ({
    consult: vi.fn(),
    state: vi.fn(),
    load: vi.fn(() => ({ enabled: true })),
    enabled: vi.fn(() => true),
}));

vi.mock("../../../src/modules/decision", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/modules/decision")>();
    return {
        ...actual,
        decisionConfig: { load: mocks.load },
        reminderEnabled: mocks.enabled,
        consultReminderSelection: mocks.consult,
        consultReminderState: mocks.state,
    };
});

import registerRemindersExtension from "../../../src/modules/reminders";
import { WINDOW_POLICY_CONVERSATION } from "../../../src/modules/decision";
import { createPiStub, stubContext, stubSessionManager, type PiStub } from "../../helpers/pi-stub";

function harness(): PiStub {
    const stub = createPiStub();
    registerRemindersExtension(stub.pi);
    return stub;
}

function context() {
    return stubContext({
        cwd: "/repo",
        sessionManager: stubSessionManager({ getBranch: () => [] }),
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.005 }),
    });
}

function toolResult(id: string, text: string) {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
    };
}

function assistantStep(commands: string[]) {
    return {
        role: "assistant",
        content: commands.map((command, index) => ({
            type: "toolCall",
            id: `c${String(index)}`,
            name: "bash",
            arguments: { command },
        })),
    };
}

function gateRecords(stub: PiStub): Record<string, unknown>[] {
    return stub.entries
        .filter((entry) => entry.customType === "pi-coder-reminder:debug")
        .map((entry) => entry.data)
        .filter(
            (data): data is Record<string, unknown> =>
                typeof data === "object" && data !== null && "trigger" in data,
        )
        .filter((data) => data.trigger === "outline");
}

function answered(decision: "outline" | "none", score: number) {
    return {
        status: "answered",
        latencyMs: 12,
        decision: decision === "none" ? { kind: "none" } : { kind: "reminder", id: "outline" },
        scores: { outline: score },
        window: { items: [], omitted: 0 },
    };
}

const COMMANDS = [
    'rg -n "ContainerSessionOptions" src/modules/sandbox',
    'rg -n "export interface ContainerMount" -A 12 src/modules/sandbox/container/*.ts',
];

beforeEach(() => {
    mocks.consult.mockReset();
    mocks.state.mockReset();
    mocks.state.mockResolvedValue({ status: "disabled", latencyMs: 0, state: {} });
    mocks.consult.mockResolvedValue(answered("outline", 1.6));
});

describe("outline gate", () => {
    it("emits the nudge when the model scores it above the gate", async () => {
        const stub = harness();

        await stub.requireHandler("turn_end")(
            {
                message: assistantStep(COMMANDS),
                toolResults: [
                    toolResult("c0", "src/client.ts:12:export interface ContainerSessionOptions {"),
                    toolResult(
                        "c1",
                        "src/args.ts:45:export interface ContainerMount {\nsrc/args.ts-46-    source: string;\n",
                    ),
                ],
            },
            context(),
        );

        expect(stub.sentMessages).toHaveLength(1);
        expect(String(stub.sentMessages[0]?.message.content)).toContain("`digest`");

        const record = gateRecords(stub)[0];
        expect(record).toMatchObject({
            trigger: "outline",
            modelChoice: "outline",
            scores: { outline: 1.6 },
            reminder: "outline",
        });
        expect(record?.outline).toMatchObject({ command: COMMANDS[1] });

        const request = mocks.consult.mock.calls[0]?.[0] as {
            options?: readonly { id: string }[];
            windowPolicy?: unknown;
            stateExtras?: unknown;
        };
        expect(request.options?.map((option) => option.id)).toEqual(["outline"]);
        expect(request.windowPolicy).toBe(WINDOW_POLICY_CONVERSATION);
        expect(request.stateExtras).toEqual({
            command: COMMANDS[1],
            output: expect.stringContaining("[3 lines,"),
        });
    });

    it("suppresses the nudge when the model answers none", async () => {
        const stub = harness();
        mocks.consult.mockResolvedValue(answered("none", 0.5));

        await stub.requireHandler("turn_end")(
            {
                message: assistantStep(COMMANDS),
                toolResults: [toolResult("c0", "ok"), toolResult("c1", "ok")],
            },
            context(),
        );

        expect(stub.sentMessages).toHaveLength(0);

        const record = gateRecords(stub)[0];
        expect(record).toMatchObject({
            trigger: "outline",
            modelChoice: "none",
            scores: { outline: 0.5 },
            reminder: null,
        });
    });

    it("fails open when the model is unavailable", async () => {
        const stub = harness();
        mocks.consult.mockResolvedValue({ status: "disabled", latencyMs: 0 });

        await stub.requireHandler("turn_end")(
            {
                message: assistantStep(COMMANDS),
                toolResults: [toolResult("c0", "ok"), toolResult("c1", "ok")],
            },
            context(),
        );

        expect(stub.sentMessages).toHaveLength(1);
        expect(gateRecords(stub)[0]).toMatchObject({ trigger: "outline", reminder: "outline" });
    });

    it("does not consult for a search that only filters another command's output", async () => {
        const stub = harness();

        await stub.requireHandler("turn_end")(
            {
                message: assistantStep(['npx vitest run test/x.ts 2>&1 | rg -n "×|Tests"']),
                toolResults: [toolResult("c0", "× one test failed")],
            },
            context(),
        );

        expect(stub.sentMessages).toHaveLength(0);
        expect(gateRecords(stub)).toHaveLength(0);
        expect(mocks.consult).not.toHaveBeenCalled();
    });
});
