import {
    SessionManager,
    type ContextUsage,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerRemindersExtension, { modelChoiceOf } from "../../../src/modules/reminders";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    textPart,
    toolCall,
    userEntry,
} from "../../helpers/session-branch";
import type { ReminderConsult, ReminderSignals } from "../../../src/modules/decision";
import { ACTIVE_ROTATION_REMINDERS } from "../../../src/modules/reminders/catalog";
import {
    createPiStub,
    stubContext,
    stubModel,
    stubSessionContext,
    stubSessionManager,
    type PiStub,
} from "../../helpers/pi-stub";
import { countedUsage } from "../../helpers/agent-doubles";

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
        // A real run starts at a non-zero context, which is the baseline the mid-run threshold measures from.
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.005 }),
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

/** One delivered reminder, as the branch records it: the message's `details` carry id, turn, and context. */
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

/**
 * One completed agent step, as pi runs it: the message streams, then the boundary dispatch after its tools ran.
 *
 * The mid-run decision belongs to that boundary and not to a delta - a steer is delivered after the turn and
 * before the next inference - so every case that used to poke `message_update` drives `turn_end` instead. The
 * streamed text is what the growth estimate is built from, which is why it is still sent.
 */
async function step(
    stub: PiStub,
    options: { growth?: number; toolResults?: boolean; toolCalls?: unknown[] } = {},
): Promise<void> {
    const growth = options.growth ?? 400;
    await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
    if (growth > 0) {
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(growth) },
            },
            ctx,
        );
    }
    await stub.requireHandler("turn_end")(
        {
            message: { role: "assistant", content: options.toolCalls ?? [] },
            toolResults: options.toolResults === false ? [] : [{ role: "toolResult" }],
        },
        ctx,
    );
}

/** The mid-run debug records a case produced: what a decision point actually cost, independent of the steer. */
function midRunRecords(stub: PiStub): unknown[] {
    return stub.entries
        .filter((entry) => entry.customType === "pi-coder-reminder:debug")
        .filter((entry) => (entry.data as { trigger?: string }).trigger === "mid-run");
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

    it("keeps the compaction reminder armed when a session start follows the fold", async () => {
        // A reload right after a fold rebuilds the appendix and fires `session_start`, whose resume finds
        // nothing after the fold. That used to arm the memory reminder and drop the fold's own one; the fold
        // reminder covers the memory re-read too, so it has to survive the resume until a turn sees it.
        const manager = sessionManager("/tmp/reminder-project");
        manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 1));
        manager.appendCompaction("folded", null, 1234);
        ctx = stubSessionContext(manager, { cwd: "/tmp/reminder-project" });

        const stub = harness();
        await startSession(stub);

        const folded = await userTurn(stub);
        expect(folded?.message?.content).toContain("compacted");
        expect(folded?.message?.content).toContain("TODO.md");
        expect(folded?.message?.content).not.toContain("memory_system");

        const entry = stub.entries.findLast(
            (candidate) => candidate.customType === "pi-coder-reminder:debug",
        );
        expect(entry?.data).toMatchObject({ reminder: "compaction", trigger: "session" });
    });

    it("arms the memory reminder again once a post-fold turn has seen the fold", async () => {
        // The counterpart to the case above: a reminder delivered after the fold makes the resume state defined,
        // so the fold is covered and a later session start goes back to arming the memory reminder.
        const manager = sessionManager("/tmp/reminder-project");
        manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 1));
        manager.appendCompaction("folded", null, 1234);
        appendUser(manager, "after the fold", 2);
        appendReminder(manager, "compaction", 1);
        ctx = stubSessionContext(manager, { cwd: "/tmp/reminder-project" });

        const stub = harness();
        await startSession(stub);

        const resumed = await userTurn(stub);
        expect(resumed?.message?.content).toContain("memory_system");
        expect(resumed?.message?.content).not.toContain("compacted");
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

        // The run must continue to a next inference for a steer to have a destination, which a tool result
        // guarantees. The exploring pool offers delegation, which is the steer's reminder.
        await step(stub);

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

    it("does not steer immediately after a turn reminder when the context has not grown", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        // The armed turn renders before the run's usage exists, so its context must not become the baseline:
        // the first step would otherwise steer the whole context as growth.
        await step(stub, { growth: 0 });

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("keeps the branch's threshold baseline across a reload's armed reminder", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        // A branch whose last reminder was stamped at 5000; the reload resumes that, and the run's prompt is
        // only 150 tokens past it - already over the 100-token threshold, but nowhere near the whole context.
        const manager = sessionManager("/tmp/reminder-project");
        appendUser(manager, "first", 1);
        appendReminder(manager, "delegation", 1, 5_000);
        manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 2));
        ctx = stubSessionContext(manager, {
            cwd: "/tmp/reminder-project",
            getContextUsage: () => ({ tokens: 5_150, contextWindow: 200_000, percent: 0.026 }),
        });

        const stub = harness();
        await startSession(stub);
        expect((await userTurn(stub))?.message?.content).toContain("memory_system");

        await step(stub);

        // Had the seed been dropped, the baseline would be the reload context (5150) and the growth zero.
        expect(stub.sentMessages).toHaveLength(1);
    });

    it("stamps a change-point reminder with the baseline it leaves in force", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const manager = sessionManager("/tmp/reminder-project");
        appendUser(manager, "first", 1);
        appendReminder(manager, "delegation", 1, 5_000);
        ctx = stubSessionContext(manager, {
            cwd: "/tmp/reminder-project",
            getContextUsage: () => ({ tokens: 5_150, contextWindow: 200_000, percent: 0.026 }),
        });

        const stub = harness();
        await startSession(stub);
        const result = (await stub.requireHandler("before_agent_start")(
            { systemPrompt: "", prompt: "do the thing" },
            ctx,
        )) as { message?: { details?: { id?: string; contextTokens?: number } } };

        // The memory reminder renders before the run's usage, so it stamps the branch baseline it leaves in
        // force rather than the reload's own context, or the next resume would re-anchor and reset the cooldown.
        expect(result?.message?.details).toMatchObject({ id: "memory-read", contextTokens: 5_000 });
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
        await stub.requireHandler("message_update")(
            {
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
            },
            ctx,
        );

        // Streaming alone decides nothing: the boundary has not happened yet, and a delta is not a step.
        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not steer on a text-only assistant message", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        // A response with no tool result may be the run's last, so nothing is steered into it.
        await step(stub, { toolResults: false });

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

        // Three steps in the same user turn: the first steers, the rest are past the per-turn budget.
        for (let crossing = 0; crossing < 3; crossing += 1) {
            await step(stub);
        }

        expect(stub.sentMessages).toHaveLength(1);
    });

    it("steers the outline nudge after a second search in a run", async () => {
        // The nudge is event-driven rather than a rotation entry, so both deterministic triggers are off and
        // the only thing that can reach the agent here is the search habit itself.
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await step(stub, {
            toolCalls: [toolCall("bash", { command: 'grep -rn "TODO" src' }, "c1")],
        });
        // One search can be a legitimate log, config, or string search: the threshold is the second one.
        expect(stub.sentMessages).toHaveLength(0);

        await step(stub, {
            toolCalls: [toolCall("bash", { command: 'rg -n "outline" src' }, "c2")],
        });

        const steered = stub.sentMessages.findLast(
            (entry) => entry.message.customType === "pi-coder-reminder",
        );
        expect(steered?.message.details).toMatchObject({ id: "outline" });
        expect(String(steered?.message.content)).toContain("`digest`");
    });

    it("does not repeat the outline nudge in the same run", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        for (let search = 0; search < 3; search += 1) {
            await step(stub, {
                toolCalls: [toolCall("bash", { command: "rg symbol src" }, `c${search}`)],
            });
        }

        expect(stub.sentMessages).toHaveLength(1);
    });

    it("quietens the outline nudge while the tool was just used", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await step(stub, {
            toolCalls: [
                toolCall("outline", { action: "digest", path: "src" }, "c1"),
                toolCall("bash", { command: "rg symbol src" }, "c2"),
                toolCall("bash", { command: "grep -rn symbol src" }, "c3"),
            ],
        });

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not nudge the outline tool in a memory-scoped child", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        useExploringBranch();
        const stub = harness({ scope: "memory" });
        await startSession(stub);
        await userTurn(stub);

        await step(stub, {
            toolCalls: [
                toolCall("bash", { command: "rg symbol src" }, "c1"),
                toolCall("bash", { command: "grep -rn symbol src" }, "c2"),
            ],
        });

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("decides nothing while the message is still streaming", async () => {
        // The regression this pins: the consult used to run on `message_update`, so a long streamed answer asked
        // the same question after every delta - 51,878 decision records in one session, 98.9% of them re-asks of
        // an unchanged state, all of them discarded by the per-turn cap. A delta is not a step.
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        useExploringBranch();
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await stub.requireHandler("message_start")({ message: { role: "assistant" } }, ctx);
        for (let delta = 0; delta < 20; delta += 1) {
            await stub.requireHandler("message_update")(
                {
                    message: { role: "assistant" },
                    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
                },
                ctx,
            );
        }

        expect(midRunRecords(stub)).toEqual([]);
        expect(stub.sentMessages).toEqual([]);

        // The step boundary decides once, and the growth the stream accumulated is what it measures.
        await stub.requireHandler("turn_end")(
            { message: { role: "assistant", content: [] }, toolResults: [{ role: "toolResult" }] },
            ctx,
        );

        expect(midRunRecords(stub)).toHaveLength(1);
        expect(stub.sentMessages).toHaveLength(1);
    });

    it("does not deliver mid-run when the threshold is off", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await step(stub);

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not deliver mid-run in a memory-scoped child", async () => {
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness({ scope: "memory" });
        await startSession(stub);
        await userTurn(stub);

        await step(stub);

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not deliver mid-run when reminders are disabled", async () => {
        vi.stubEnv("PI_CODER_REMINDER", "false");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "100");
        const stub = harness();
        await startSession(stub);

        await step(stub);

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

/**
 * The automatic memory audit, driven through the hooks: an edit that leaves a memory unparseable has to reach
 * the run that caused it, without the agent ever calling the tool.
 */
describe("automatic memory audit", () => {
    const roots: string[] = [];

    async function makeRoot(prefix: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        return root;
    }

    function memoryText(description: string): string {
        return `---\nname: a\ndescription: ${description}\n---\n\n# a\n\nBody.\n`;
    }

    /** A project whose memory tree holds one valid memory, plus an isolated user tree for the audit. */
    async function projectWithMemory(): Promise<string> {
        const projectRoot = await makeRoot("pi-reminder-audit-");
        const agentDir = await makeRoot("pi-reminder-audit-agent-");
        vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
        await mkdir(join(projectRoot, ".pi", "agent", "memory"), { recursive: true });
        await writeFile(memoryPath(projectRoot), memoryText("A memory that parses."), "utf8");
        return projectRoot;
    }

    function memoryPath(projectRoot: string): string {
        return join(projectRoot, ".pi", "agent", "memory", "a.md");
    }

    afterEach(async () => {
        await Promise.all(
            roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
        );
    });

    it("steers the findings of a memory edit in the run that made it", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        const projectRoot = await projectWithMemory();
        ctx = stubContext({
            cwd: projectRoot,
            sessionManager: stubSessionManager({ getBranch: () => [] }),
        });
        const stub = harness();
        await startSession(stub);

        await writeFile(memoryPath(projectRoot), memoryText("Breaks: the frontmatter"), "utf8");
        await step(stub);

        expect(stub.sentMessages).toHaveLength(1);
        expect(stub.sentMessages[0]?.message).toMatchObject({
            customType: "pi-coder-reminder",
            display: false,
            details: { id: "memory-audit" },
        });
        const content = String(stub.sentMessages[0]?.message.content);
        expect(content).toContain("[frontmatter]");
        expect(content).toContain("project/a.md");
        expect(stub.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
    });

    it("says nothing for a step whose memory edit audited clean", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        const projectRoot = await projectWithMemory();
        ctx = stubContext({
            cwd: projectRoot,
            sessionManager: stubSessionManager({ getBranch: () => [] }),
        });
        const stub = harness();
        await startSession(stub);

        await writeFile(memoryPath(projectRoot), memoryText("Still parses fine."), "utf8");
        await step(stub);

        expect(stub.sentMessages).toHaveLength(0);
    });

    it("does not repeat findings the agent has already been shown", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        const projectRoot = await projectWithMemory();
        ctx = stubContext({
            cwd: projectRoot,
            sessionManager: stubSessionManager({ getBranch: () => [] }),
        });
        const stub = harness();
        await startSession(stub);

        await writeFile(memoryPath(projectRoot), memoryText("Breaks: the frontmatter"), "utf8");
        await step(stub);
        expect(stub.sentMessages).toHaveLength(1);

        // An unchanged tree is not even parsed; another memory edit that adds no finding is parsed and
        // silenced, because the news did not change.
        await step(stub);
        await writeFile(
            join(projectRoot, ".pi", "agent", "memory", "b.md"),
            "---\nname: b\ndescription: Another memory that parses.\n---\n\n# b\n",
            "utf8",
        );
        await step(stub);

        expect(stub.sentMessages).toHaveLength(1);
    });

    it("combines a held rotation reminder with an audit finding into one steer", async () => {
        // The regression this pins: the audit used to be sent directly while a held rotation payload was flushed
        // separately, so two messages left at one boundary. pi delivered the first to the next inference and
        // carried the second to the next *user prompt*, which put a broken memory one turn late in a live run.
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "1");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        const projectRoot = await projectWithMemory();
        // A branch holding one read, so the inferred state is `exploring` and the rotation has a pool.
        const manager = sessionManager(projectRoot);
        manager.appendMessage(assistantEntry([toolCall("read", { path: "src/a.ts" }, "c1")], 1));
        const entries = manager.getBranch();
        ctx = stubContext({
            cwd: projectRoot,
            sessionManager: stubSessionManager({ getBranch: () => entries }),
            getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.005 }),
        });
        const stub = harness();
        await startSession(stub);
        // A run in flight, so the deferred rotation pick is held instead of sent as `nextTurn`.
        await stub.requireHandler("agent_start")({}, ctx);
        await userTurn(stub);
        await userTurn(stub);

        const sentBefore = stub.sentMessages.length;
        await writeFile(memoryPath(projectRoot), memoryText("Breaks: the frontmatter"), "utf8");
        await step(stub);

        // One message, one wrapper, both reminders in it: the defect and the held rotation pick.
        const atAudit = stub.sentMessages.slice(sentBefore);
        expect(atAudit).toHaveLength(1);
        const content = String(atAudit[0]?.message.content);
        expect(content.match(/<pi_coder_reminder>/g)).toHaveLength(1);
        expect(content).toContain("[frontmatter]");
        expect(content).toContain("scout");
        expect(atAudit[0]?.message).toMatchObject({ details: { id: "memory-audit" } });
        expect((atAudit[0]?.message.details as { ids?: string[] }).ids).toEqual(
            expect.arrayContaining(["delegation", "memory-audit"]),
        );
        expect(atAudit[0]?.options).toEqual({ deliverAs: "steer" });

        // Nothing is left waiting: the combined message was the whole delivery.
        await step(stub);
        expect(stub.sentMessages.slice(sentBefore)).toHaveLength(1);
    });

    it("can be turned off without touching the tool", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_MEMORY_AUDIT", "false");
        const projectRoot = await projectWithMemory();
        ctx = stubContext({
            cwd: projectRoot,
            sessionManager: stubSessionManager({ getBranch: () => [] }),
        });
        const stub = harness();
        await startSession(stub);

        await writeFile(memoryPath(projectRoot), memoryText("Breaks: the frontmatter"), "utf8");
        await step(stub);

        expect(stub.sentMessages).toHaveLength(0);
    });
});

describe("context reminders", () => {
    /** A branch whose newest row is a fold, optionally with the first post-fold reply already in it. */
    function foldBranch(options: { model?: string; postFoldReply?: boolean } = {}): SessionManager {
        const manager = sessionManager("/tmp/reminder-project");
        manager.appendMessage(
            assistantEntry(
                [toolCall("read", { path: "src/a.ts" }, "c1")],
                1,
                countedUsage(5_000, 100),
            ),
        );
        const keptId = manager.appendMessage(userEntry("keep going", 2));
        manager.appendCompaction(
            "a summary of the work",
            keptId,
            6_000,
            { version: 1, provider: "anthropic", model: options.model ?? "stub-model" },
            false,
            countedUsage(1_500, 200),
        );
        if (options.postFoldReply === true) {
            manager.appendMessage(
                assistantEntry([textPart("continued")], 3, countedUsage(2_000, 40)),
            );
        }

        return manager;
    }

    function contextWith(
        manager: SessionManager,
        usage: () => ContextUsage | undefined,
        model = stubModel(),
    ): ExtensionContext {
        return stubSessionContext(manager, {
            cwd: "/tmp/reminder-project",
            model,
            getContextUsage: usage,
        });
    }

    it("states the measured context in the fold reminder", async () => {
        ctx = contextWith(foldBranch({ postFoldReply: true }), () => ({
            tokens: 12_345,
            contextWindow: 200_000,
            percent: 6.17,
        }));
        const stub = harness();
        await startSession(stub);

        const folded = await userTurn(stub);

        expect(folded?.message?.content).toContain(
            "Measured context after the fold: 12,345 of 200,000 tokens used (6%), 187,655 free.",
        );
        expect(folded?.message?.content).toContain(
            "The token count from before the fold no longer applies",
        );
    });

    it("estimates the post-fold context when nothing has replied yet", async () => {
        ctx = contextWith(foldBranch(), () => undefined);
        const stub = harness();
        await startSession(stub);

        const folded = await userTurn(stub);

        expect(folded?.message?.content).toMatch(
            /Estimated context after the fold: about [\d,]+ of 200,000 tokens used/u,
        );
    });

    it("skips the estimate after a model change and steers the measured number later", async () => {
        const manager = foldBranch();
        const state: { usage?: ContextUsage } = {};
        ctx = contextWith(manager, () => state.usage, stubModel({ id: "other-model" }));
        const stub = harness();
        await startSession(stub);

        const folded = await userTurn(stub);
        expect(folded?.message?.content).toContain("no longer applies");
        expect(folded?.message?.content).not.toContain("Estimated context");

        // The first reply under the new model is what makes a count trustworthy again.
        manager.appendMessage(assistantEntry([textPart("continued")], 4, countedUsage(1_800, 30)));
        state.usage = { tokens: 9_000, contextWindow: 200_000, percent: 4.5 };
        await step(stub);

        const steered = String(stub.sentMessages.at(-1)?.message.content);
        expect(steered).toContain(
            "Measured context: 9,000 of 200,000 tokens used (5%), 191,000 free.",
        );
        expect(steered).toContain("available again after the fold");
    });

    it("steers the 50% reminder at a step boundary and the 75% one later", async () => {
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        const manager = sessionManager("/tmp/reminder-project");
        manager.appendMessage(
            assistantEntry(
                [toolCall("read", { path: "src/a.ts" }, "c1")],
                1,
                countedUsage(50_000, 100),
            ),
        );
        let usage: ContextUsage = { tokens: 102_000, contextWindow: 200_000, percent: 51 };
        ctx = contextWith(manager, () => usage);
        const stub = harness();
        await startSession(stub);
        await userTurn(stub);

        await step(stub);
        expect(String(stub.sentMessages.at(-1)?.message.content)).toContain(
            "Half the context window",
        );

        // The same threshold is not repeated on the next step.
        await step(stub);
        expect(stub.sentMessages).toHaveLength(1);

        usage = { tokens: 152_000, contextWindow: 200_000, percent: 76 };
        await step(stub);
        expect(String(stub.sentMessages.at(-1)?.message.content)).toContain(
            "Three quarters of the context window",
        );
        expect(String(stub.sentMessages.at(-1)?.message.content)).toContain(
            "Measured context: 152,000 of 200,000 tokens used (76%), 48,000 free.",
        );
    });

    it("can be turned off without touching the fold reminder", async () => {
        vi.stubEnv("PI_CODER_REMINDER_CONTEXT", "false");
        vi.stubEnv("PI_CODER_REMINDER_EVERY_TURNS", "0");
        vi.stubEnv("PI_CODER_REMINDER_THRESHOLD", "0");
        ctx = contextWith(foldBranch(), () => ({
            tokens: 152_000,
            contextWindow: 200_000,
            percent: 76,
        }));
        const stub = harness();
        await startSession(stub);

        const folded = await userTurn(stub);
        expect(folded?.message?.content).toContain("compacted");
        expect(folded?.message?.content).not.toContain("token count from before the fold");

        await step(stub);
        expect(stub.sentMessages).toHaveLength(0);
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
