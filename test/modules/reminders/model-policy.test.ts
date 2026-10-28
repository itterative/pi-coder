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
    state: vi.fn(),
    load: vi.fn(),
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
import { TRANSCRIPT_WINDOW_CHARS, type ReminderSignals } from "../../../src/modules/decision";
import { createPiStub, stubContext, stubSessionManager, type PiStub } from "../../helpers/pi-stub";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    toolCall,
} from "../../helpers/session-branch";

interface ReminderMessage {
    customType: string;
    content: string;
    display: boolean;
}

type BeforeAgentStartResult = { message?: ReminderMessage } | undefined;

let ctx: ExtensionContext;
/** The extension's judgement queue, so a case waits for a deferred decision the way the next hook would. */
let idle: () => Promise<void>;

function harness(): PiStub {
    const stub = createPiStub();
    idle = registerRemindersExtension(stub.pi).idle;
    return stub;
}

async function startSession(stub: PiStub): Promise<void> {
    await stub.requireHandler("session_start")({ reason: "startup" }, ctx);
}

/**
 * The boundary handler alone: what pi calls, before the deferred judgement settles.
 *
 * pi awaits this handler and builds the user's message after it, so a case that is about what the boundary
 * itself costs asserts on this and not on `userTurn`.
 */
async function turnBoundary(stub: PiStub): Promise<BeforeAgentStartResult> {
    return (await stub.requireHandler("before_agent_start")(
        { systemPrompt: "", prompt: "do the thing" },
        ctx,
    )) as BeforeAgentStartResult;
}

/**
 * One user turn, as pi runs it: the handler resolves, then the deferred judgement settles.
 *
 * A judged rotation turn decides after the boundary - the consult is not worth holding the user's message
 * behind - so its reminder arrives as a sent message rather than in the handler's return.
 */
async function userTurn(stub: PiStub): Promise<BeforeAgentStartResult> {
    const before = stub.sentMessages.length;
    const result = await turnBoundary(stub);

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
 * One finished assistant response, which is what `turn_end` means: a response plus the tools it called.
 *
 * The state checkpoint hangs off this rather than `before_agent_start`, so a case here drives it directly - the
 * same way a queued message does, since that never fires `before_agent_start` at all.
 */
async function toolResponse(stub: PiStub, toolResults: unknown[] = [{}]): Promise<void> {
    await toolResponseNow(stub, toolResults);
    // The checkpoint judgement is queued rather than awaited by the hook, so a case waits for the queue the
    // way the checkpoint's consumers do.
    await idle();
}

/** The `turn_end` handler alone: what pi calls, which returns before any checkpoint consult has started. */
async function toolResponseNow(stub: PiStub, toolResults: unknown[] = [{}]): Promise<void> {
    await stub.requireHandler("turn_end")({ message: {}, toolResults }, ctx);
}

/**
 * One mid-run threshold crossing, as pi drives it: an assistant message that called a tool and then streamed
 * enough text to grow the context past the threshold.
 *
 * The tool call comes first because only a message that will continue the run may steer, and the streamed text
 * is what the growth tracker counts.
 */
async function midRunCrossing(stub: PiStub, streamedChars = 400): Promise<void> {
    await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
    await stub.requireHandler("message_update")(
        { message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_start" } },
        ctx,
    );
    await stub.requireHandler("message_update")(
        {
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "x".repeat(streamedChars) },
        },
        ctx,
    );
}

function stateEntries(stub: PiStub): Array<{ customType: string; data: unknown }> {
    return stub.entries.filter((entry) => entry.customType === "pi-coder:reminder-state");
}

function lastDebugEntry(stub: PiStub): Record<string, unknown> | undefined {
    return stub.entries.findLast((entry) => entry.customType === "pi-coder-reminder:debug")
        ?.data as Record<string, unknown> | undefined;
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

/** A branch holding one read, so the state is `exploring` and the pool offers `delegation`. */
function exploringEntries(): SessionEntry[] {
    const manager = sessionManager("/tmp/reminder-project");
    manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 1));

    return manager.getBranch();
}

/** The TODO states the query is built from: the exploring branch plus an open list. */
function contextWithTodo(): ExtensionContext {
    const entries = [...exploringEntries(), todoSnapshotEntry()];

    return stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({ getBranch: () => entries }),
    });
}

/**
 * The default context: an exploring branch.
 *
 * The pool follows the judged state, and a branch with no activity at all reads `discussing`, where only the
 * list (and only with an open list) is offered. Every case here is about what happens once the model is asked,
 * so the branch has to be in a state that offers something to ask about.
 */
function exploringContext(): ExtensionContext {
    const entries = exploringEntries();

    return stubContext({
        cwd: "/tmp/reminder-project",
        sessionManager: stubSessionManager({ getBranch: () => entries }),
    });
}

beforeEach(() => {
    ctx = exploringContext();
    mocks.consult.mockReset();
    mocks.state.mockReset();
    mocks.load.mockReset();
    mocks.enabled.mockReset();
    mocks.enabled.mockReturnValue(true);
    mocks.load.mockReturnValue({ enabled: true, reminders: true });
    mocks.consult.mockResolvedValue({
        decision: { kind: "reminder", id: "delegation" },
        status: "answered",
        latencyMs: 1,
    });
    // Tier 1 answers nothing by default, so a case that is not about the cascade sees the branch's own state.
    mocks.state.mockResolvedValue({
        status: "answered",
        latencyMs: 1,
        state: {},
        phaseConfidence: 0.9,
        answeredPhase: "discussing",
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
    cleanupBranches();
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
        // The phase the turn records is the state ask's answer; the pool consult never carries labels.
        mocks.state.mockResolvedValue({
            status: "answered",
            latencyMs: 1,
            state: { phase: "implementing" },
            phaseConfidence: 0.9,
        });

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

    it("records the window the consult judged beside the signals", async () => {
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        mocks.consult.mockResolvedValue({
            decision: { kind: "reminder", id: "delegation" },
            status: "answered",
            latencyMs: 1,
            window: { items: [{ role: "tool", text: "read(src/a.ts)" }], omitted: 2 },
        });

        await userTurn(stub);

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        // The window is recorded as the consult reported it, so a live decision can be checked against the
        // window a later change builds without replaying the branch it was read from.
        expect(entry?.data).toMatchObject({
            reminder: "delegation",
            window: { items: [{ role: "tool", text: "read(src/a.ts)" }], omitted: 2 },
        });
    });

    it("scopes the pool by the state tier 1 judged", async () => {
        ctx = stubContext({
            cwd: "/tmp/reminder-project",
            sessionManager: stubSessionManager({ getBranch: () => [] }),
        });
        mocks.state.mockResolvedValue({
            status: "answered",
            latencyMs: 1,
            state: { phase: "reporting" },
            phaseConfidence: 0.9,
        });
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await userTurn(stub);

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        // The branch alone reads `discussing`, whose pool is the list only; the judged state is what scopes it,
        // and the hand-back pair is what `reporting` offers.
        expect(entry?.data).toMatchObject({
            labels: { phase: "reporting" },
            available: ["memory-hygiene", "validation"],
            options: ["memory-hygiene", "validation"],
            stateConfidence: 0.9,
            escalated: false,
        });

        const sent = mocks.consult.mock.calls.at(-1)?.[0] as {
            signals?: ReminderSignals;
        };
        // The selection consult is asked from the state tier 1 judged, not from the activity alone.
        expect(sent.signals?.session?.phase).toBe("reporting");
    });

    it("re-asks the state when tier 1 comes back unsure", async () => {
        mocks.state
            .mockResolvedValueOnce({
                status: "answered",
                latencyMs: 1,
                state: { phase: "implementing" },
                phaseConfidence: 0.2,
                answeredPhase: "implementing",
            })
            .mockResolvedValueOnce({
                status: "answered",
                latencyMs: 1,
                state: { phase: "validating" },
                phaseConfidence: 0.9,
                answeredPhase: "validating",
            });
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await userTurn(stub);

        // The escalation is a second state ask on the window transcript, not state questions bolted onto the
        // pool's request: the pool is judged from its own conversation, and the state question keeps its own
        // transcript ask whatever the pool looks like.
        expect(mocks.state).toHaveBeenCalledTimes(2);
        expect((mocks.state.mock.calls[1]?.[0] as { windowChars?: number }).windowChars).toBe(
            TRANSCRIPT_WINDOW_CHARS,
        );

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        // The escalated answer is the one that counts, and the raw tier-1 confidence is recorded beside it.
        expect(entry?.data).toMatchObject({
            labels: { phase: "validating" },
            stateConfidence: 0.2,
            escalated: true,
        });
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
            // The judgement is deferred, so its entry is written after the boundary advanced the turn: the
            // snapshot is the one the decision saw, which is this turn's, and the flag says the entry landed
            // inside the run rather than before the prompt.
            deferred: true,
            scheduler: { userTurns: 2, sessionArmed: false },
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

describe("state checkpoints", () => {
    it("judges the state after a response that used a tool", async () => {
        mocks.state.mockResolvedValue({
            status: "answered",
            latencyMs: 1,
            state: { phase: "validating" },
            phaseConfidence: 0.9,
            transcript: "User: do the thing",
        });
        const stub = harness();
        await startSession(stub);

        await toolResponse(stub);

        expect(mocks.state).toHaveBeenCalledTimes(1);
        const sent = mocks.state.mock.calls[0]?.[0] as {
            heldPhase?: string;
            windowChars?: number;
        };
        // Tier 1 alone, on the short transcript, with no accepted phase to hold yet.
        expect(sent.windowChars).toBeUndefined();
        expect(sent.heldPhase).toBeUndefined();
        expect(stateEntries(stub)).toEqual([
            { customType: "pi-coder:reminder-state", data: { phase: "validating" } },
        ]);

        // The checkpoint is recorded like the other decisions, so a later session can tell that it ran - and it
        // carries the transcript the state was judged by, which the branch alone cannot reconstruct.
        expect(lastDebugEntry(stub)).toMatchObject({
            trigger: "checkpoint",
            labels: { phase: "validating" },
            stateConfidence: 0.9,
            escalated: false,
            stateTranscript: "User: do the thing",
        });
    });

    it("escalates to the full window when the short answer was unsure", async () => {
        mocks.state
            .mockResolvedValueOnce({
                status: "answered",
                latencyMs: 7,
                state: { phase: "implementing" },
                phaseConfidence: 0.2,
                answeredPhase: "implementing",
            })
            .mockResolvedValueOnce({
                status: "answered",
                latencyMs: 1,
                state: { phase: "documenting" },
                phaseConfidence: 0.9,
            });
        const stub = harness();
        await startSession(stub);

        await toolResponse(stub);

        expect(mocks.state).toHaveBeenCalledTimes(2);
        expect(
            (mocks.state.mock.calls[0]?.[0] as { windowChars?: number }).windowChars,
        ).toBeUndefined();
        expect((mocks.state.mock.calls[1]?.[0] as { windowChars?: number }).windowChars).toBe(
            TRANSCRIPT_WINDOW_CHARS,
        );
        // The escalated answer is accepted, while the recorded confidence, phase and latency stay tier 1's.
        expect(stateEntries(stub)).toEqual([
            { customType: "pi-coder:reminder-state", data: { phase: "documenting" } },
        ]);
        expect(lastDebugEntry(stub)).toMatchObject({
            escalated: true,
            stateConfidence: 0.2,
            statePhase: "implementing",
            stateLatencyMs: 7,
            labels: { phase: "documenting" },
        });
    });

    it("does not judge a response that called no tool", async () => {
        const stub = harness();
        await startSession(stub);

        await toolResponse(stub, []);

        expect(mocks.state).not.toHaveBeenCalled();
        expect(stateEntries(stub)).toEqual([]);
        expect(lastDebugEntry(stub)).toBeUndefined();
    });

    it("does not judge the state while the decision model has not opted into reminders", async () => {
        mocks.enabled.mockReturnValue(false);
        const stub = harness();
        await startSession(stub);

        await toolResponse(stub);

        expect(mocks.state).not.toHaveBeenCalled();
        expect(stateEntries(stub)).toEqual([]);
    });

    it("scopes a mid-run steer by the state the last response was judged in", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        // The checkpoint judges `reporting`, whose pool is the hand-back pair; the branch on its own reads
        // `exploring`, whose pool is `delegation`, so the pool the consult is offered is what proves the labels
        // carried.
        mocks.state.mockResolvedValue({
            status: "answered",
            latencyMs: 1,
            state: { phase: "reporting" },
            phaseConfidence: 0.9,
        });
        mocks.consult.mockResolvedValue({
            decision: { kind: "reminder", id: "validation" },
            status: "answered",
            latencyMs: 1,
        });
        // A real run starts at a non-zero context, which is the mid-run threshold's baseline.
        ctx = {
            ...ctx,
            getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 0.0025 }),
        };
        const stub = harness();
        await startSession(stub);
        await toolResponse(stub);

        await midRunCrossing(stub);

        expect(lastDebugEntry(stub)).toMatchObject({
            trigger: "mid-run",
            available: ["memory-hygiene", "validation"],
            options: ["memory-hygiene", "validation"],
            modelChoice: "validation",
        });
        expect(stub.sentMessages).toHaveLength(1);
        expect(String(stub.sentMessages[0]?.message.content)).toContain("validation");
    });

    it("declines a mid-run point the model answers none on", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        mocks.consult.mockResolvedValue({
            decision: { kind: "none" },
            status: "answered",
            latencyMs: 1,
        });
        ctx = {
            ...ctx,
            getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 0.0025 }),
        };
        const stub = harness();
        await startSession(stub);

        await midRunCrossing(stub);

        // The deterministic pointer always had an id here; the consult is what makes the point refusable.
        expect(lastDebugEntry(stub)).toMatchObject({
            trigger: "mid-run",
            reminder: null,
            modelChoice: "none",
            available: ["delegation"],
        });
        expect(stub.sentMessages).toEqual([]);
    });

    it("asks the mid-run question once per crossing, without a request of its own", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        mocks.consult.mockResolvedValue({
            decision: { kind: "none" },
            status: "answered",
            latencyMs: 1,
        });
        ctx = {
            ...ctx,
            getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 0.0025 }),
        };
        const stub = harness();
        await startSession(stub);

        await midRunCrossing(stub);

        // The prompt is already the branch's last user message, so the consult appends nothing to the
        // conversation and sends no `request` field.
        const ask = mocks.consult.mock.calls.at(-1)?.[0] as {
            request?: string;
            options: ReadonlyArray<{ id: string }>;
        };
        expect(ask.request).toBeUndefined();
        expect(ask.options.map((option) => option.id)).toEqual(["delegation"]);
        // A declined point restarts the cooldown, so the still-growing context does not ask again.
        expect(mocks.consult).toHaveBeenCalledTimes(1);
    });

    it("leaves the deterministic rotation in charge when the consult is disabled", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        mocks.consult.mockResolvedValue({ status: "disabled", latencyMs: 0 });
        ctx = {
            ...ctx,
            getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 0.0025 }),
        };
        const stub = harness();
        await startSession(stub);

        await midRunCrossing(stub);

        expect(lastDebugEntry(stub)).toMatchObject({ trigger: "mid-run", reminder: "delegation" });
        expect(stub.sentMessages).toHaveLength(1);
    });
});

describe("deferred rotation turns", () => {
    /** One tier-1 answer the case releases by hand, so a consult can be held in the air. */
    function holdStateAnswers(): Array<(answer: unknown) => void> {
        const held: Array<(answer: unknown) => void> = [];
        mocks.state.mockImplementation(
            () =>
                new Promise((resolve) => {
                    held.push(resolve);
                }),
        );
        return held;
    }

    /** The answer a held tier-1 ask resolves with. */
    const ANSWERED = { status: "answered", latencyMs: 1, state: {}, phaseConfidence: 0.9 };

    it("returns the boundary while the judgement is still in the air", async () => {
        const held = holdStateAnswers();
        const stub = harness();
        await startSession(stub);
        // The armed memory turn, so the turn under test is a rotation turn.
        await userTurn(stub);

        // pi builds the user's message as soon as this resolves, which is the point of deferring: no reminder
        // comes back from the handler, and nothing has been sent yet.
        expect(await turnBoundary(stub)).toBeUndefined();
        expect(stub.sentMessages).toEqual([]);

        held[0]?.(ANSWERED);
        await idle();

        expect(stub.sentMessages).toHaveLength(1);
        expect(String(stub.sentMessages[0]?.message.content)).toContain("scout");
    });

    it("steers the deferred reminder into the run it was judged for", async () => {
        const stub = harness();
        await startSession(stub);
        await stub.requireHandler("agent_start")({}, ctx);
        await userTurn(stub);

        expect((await userTurn(stub))?.message?.content).toContain("scout");

        expect(stub.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
    });

    it("carries the reminder with the next user message when the run has settled", async () => {
        const stub = harness();
        await startSession(stub);
        await stub.requireHandler("agent_start")({}, ctx);
        await stub.requireHandler("agent_settled")({}, ctx);
        await userTurn(stub);

        // A steer sent while nothing is streaming would be appended to the session without reaching the model,
        // so a settled run hands the reminder to the next prompt instead.
        expect((await userTurn(stub))?.message?.content).toContain("scout");

        expect(stub.sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn" });
    });

    it("stamps the deferred entry with the turn it judged and the flag that it was deferred", async () => {
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await userTurn(stub);

        expect(lastDebugEntry(stub)).toMatchObject({
            trigger: "turn",
            deferred: true,
            reminder: "delegation",
            // Tier 1's own half of the cascade: what it answered, how sure it was, and what it cost.
            statePhase: "discussing",
            stateConfidence: 0.9,
            stateLatencyMs: 1,
            scheduler: { userTurns: 2 },
        });
    });

    it("keeps a checkpoint judgement behind the turn judgement it followed", async () => {
        const held = holdStateAnswers();
        const stub = harness();
        await startSession(stub);
        // The armed memory turn, so the turn under test is a rotation turn.
        await userTurn(stub);

        await turnBoundary(stub);
        expect(mocks.state).toHaveBeenCalledTimes(1);

        // The checkpoint is queued, not awaited by `turn_end`, and it waits for the ask in front of it: the
        // queue is what keeps the consults in the order the session produced them.
        await toolResponseNow(stub);
        expect(mocks.state).toHaveBeenCalledTimes(1);

        held[0]?.(ANSWERED);
        await vi.waitFor(() => expect(mocks.state).toHaveBeenCalledTimes(2));

        // The checkpoint's own ask is held too; release it so the queue settles.
        held[1]?.(ANSWERED);
        await idle();

        expect(mocks.state).toHaveBeenCalledTimes(2);
    });

    it("drops a judgement whose session was replaced before it answered", async () => {
        const held = holdStateAnswers();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);
        await turnBoundary(stub);

        // A reload, tree move, or fold while a consult is in the air: the answer belongs to the session that
        // was left, so it is neither recorded nor delivered.
        await startSession(stub);
        held[0]?.({
            status: "answered",
            latencyMs: 1,
            state: { phase: "implementing" },
            phaseConfidence: 0.9,
        });
        await idle();

        expect(stateEntries(stub)).toEqual([]);
        expect(stub.sentMessages).toEqual([]);
    });

    it("still decides the armed reminder at the boundary, with no consult", async () => {
        const held = holdStateAnswers();
        const stub = harness();
        await startSession(stub);

        // The memory reminder is armed, so the first turn is not a rotation turn: it rides the user message as
        // it always did, and the consult a rotation turn would have made is never started.
        const result = await turnBoundary(stub);

        expect(result?.message?.content).toContain("memory_system");
        expect(mocks.state).not.toHaveBeenCalled();
        expect(mocks.consult).not.toHaveBeenCalled();
        expect(held).toEqual([]);
    });
});
