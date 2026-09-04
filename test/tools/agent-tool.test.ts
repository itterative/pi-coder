import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
    AgentToolResult,
    BeforeAgentStartEventResult,
    Theme,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { registerStatusWidget } from "../../src/tui/status";
import registerAgentTool, { clearCompletedWorkspaceSetupRun } from "../../src/tools/agent";
import { executeAgentAction } from "../../src/tools/agent/action-dispatch";
import type { AgentLifecycle } from "../../src/tools/agent/lifecycle";
import { registerAgentTool as registerAgentToolDefinition } from "../../src/tools/agent/presentation/tool";
import { AGENT_EVENT_CHANNEL } from "../../src/tools/agent/observability/events";
import type { AgentEventSink } from "../../src/tools/agent/observability/events";
import type { AgentDefinition } from "../../src/tools/agent/definitions/types";
import {
    ZERO_USAGE,
    type AgentRunDetails,
    type AgentRunManager,
    type AgentRunOutcome,
    type AgentRunSummary,
    type ChildAgentHandle,
    type ChildProgress,
} from "../../src/tools/agent/runs/manager";
import type {
    AgentRunCatalogRecord,
    AgentWorkspace,
    AgentWorkspaceResult,
} from "../../src/tools/agent/contracts/workspaces";
import * as runCatalog from "../../src/tools/agent/storage/run-catalog";
import * as workspaceActions from "../../src/tools/agent/workspaces/actions";
import * as workspaceCheckpoints from "../../src/tools/agent/workspaces/checkpoints";
import * as workspaceResults from "../../src/tools/agent/workspaces/results";
import * as workspaceFinalization from "../../src/tools/agent/workspaces/finalization";
import * as workspaceGit from "../../src/tools/agent/workspaces/git";
import * as workspaceSetup from "../../src/tools/agent/workspaces/setup";
import * as workspaceStore from "../../src/tools/agent/workspaces/store";
import { executeParentWorkspaceAction } from "../../src/tools/agent/workspaces/parent-actions";
import { AGENT_TRACE_ENV } from "../../src/tools/agent/observability/trace";
import {
    createPiStub,
    handlerView,
    stubContext,
    stubSessionManager,
    stubUi,
    type PiStub,
} from "../helpers/pi-stub";
import { partialDetails, partialWorkspace, partialWorkspaceResult } from "../helpers/agent-doubles";
import { mockTheme, renderText, snapshotText } from "../helpers";

/** What the agent tool really puts in `details`; pi erases that generic on a registered tool. */
type AgentToolCall = AgentToolResult<AgentRunDetails>;

/**
 * The registered `agent` tool, narrowed to what these suites drive.
 *
 * `pi` types a registered tool's `execute` result with its erased `details` generic and declares
 * `renderResult`'s fourth argument as a required render context that the package never exports, so no
 * suite can call the real signature. Both are restored once here instead of cast at every call site.
 */
interface AgentTool {
    readonly definition: ToolDefinition;
    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
    ): Promise<AgentToolCall>;
    renderResult(result: AgentToolCall, options: { expanded: boolean }, theme: Theme): Component;
}

/** pi declares the fourth renderer argument as a required render context type it never exports. */
const noRenderContext = undefined as never;

function agentTool(stub: PiStub): AgentTool {
    const registered = stub.requireTool<AgentRunDetails>("agent");
    const render = registered.definition.renderResult;
    if (!render) {
        throw new Error(`tool "${registered.name}" declares no result renderer`);
    }

    return {
        definition: registered.definition,
        execute: async (toolCallId, params, signal, onUpdate, ctx) =>
            await registered.execute(toolCallId, params, signal, onUpdate, ctx),
        renderResult: (result, options, theme) =>
            render(result, { ...options, isPartial: false }, theme, noRenderContext),
    };
}

/** The guidelines are optional in pi's type but this suite snapshots them. */
function requirePromptGuidelines(definition: ToolDefinition): string[] {
    if (!definition.promptGuidelines) {
        throw new Error("the agent tool declares no prompt guidelines");
    }

    return definition.promptGuidelines;
}

/** The agent tool always answers with a single text block; pi types content as a text-or-image union. */
function agentTextPart(result: AgentToolCall): TextContent {
    const part = result.content[0];
    if (!part || part.type !== "text") {
        throw new Error("the agent tool returned no text content");
    }

    return part;
}

function agentToolText(result: AgentToolCall): string {
    return agentTextPart(result).text;
}

const TEST_WORKER_DEFINITION: AgentDefinition = {
    name: "worker",
    source: "builtin",
    capabilities: ["edit"],
    description: "Test worker",
    systemPrompt: "Test worker prompt",
};

const tempDirs: string[] = [];
beforeEach(() => {
    vi.spyOn(workspaceCheckpoints, "createAgentWorkspaceCheckpointCallback").mockReturnValue(
        async () => {},
    );
    vi.spyOn(workspaceCheckpoints, "latestAgentWorkspaceCheckpoint").mockResolvedValue({
        id: "checkpoint-1",
        workspaceId: "workspace-1",
        runId: "worker-1",
        runInstanceId: "worker-instance-1",
        sequence: 1,
        kind: "terminal",
        runStatus: "completed",
        baseRevision: "base-revision",
        headRevision: "worker-head",
        durableRef: "refs/pi-coder/workspace-checkpoints/workspace-1/checkpoint-1",
        childSessionLeafId: "leaf-1",
        createdAt: 3,
    });
    vi.spyOn(workspaceCheckpoints, "restoreAgentWorkspaceCheckpoint").mockResolvedValue();
    vi.spyOn(workspaceGit, "hasAncestor").mockResolvedValue(true);
});

afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The parent-side continuation fixture: a persisted catalog record whose workspace holds a prepared
 * result, a manager double recording the continuation calls, and the stub context the action reads.
 *
 * `record` is typed as the catalog shape because `resolveParentRunRecord` maps the persisted record into
 * it before use; the manager double is cast as a whole where it is handed to production, so no single
 * method has to lie about its return type.
 */
function revisionActionFixture() {
    const record: AgentRunCatalogRecord = {
        ownerSessionId: "parent-session",
        runId: "worker-1",
        runInstanceId: "worker-instance-1",
        parentCwd: process.cwd(),
        title: "Implement fix",
        agent: "worker",
        agentSource: "builtin",
        definitionSnapshot: TEST_WORKER_DEFINITION,
        task: "Original task",
        status: "removed",
        background: true,
        mutating: true,
        workspaceId: "workspace-1",
        childSessionFile: "/tmp/agent-child.jsonl",
        childSessionLeafId: "leaf-1",
        startedAt: 1,
        updatedAt: 2,
        usageSnapshot: ZERO_USAGE,
    };
    const workspace = partialWorkspace({
        id: "workspace-1",
        cwd: process.cwd(),
        repositoryRoot: process.cwd(),
        worktreePath: "/tmp/workspace-1",
        slug: "workspace-1",
        baseRevision: "base-revision",
        setupState: "ready",
        status: "review_required",
        leaseOwnerSessionId: "parent-session",
        leaseRunId: "worker-1",
        leaseRunInstanceId: "worker-instance-1",
        leaseKind: "task",
        latestResult: partialWorkspaceResult({
            id: "result-1",
            workspaceId: "workspace-1",
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
            baseRevision: "base-revision",
            workerHead: "worker-head",
            commitRange: "base-revision..worker-head",
            commits: ["worker-head"],
            preparedAt: 3,
            status: "prepared",
        }),
        createdAt: 1,
        updatedAt: 2,
    });
    const definition = TEST_WORKER_DEFINITION;
    const continuationOutcome: AgentRunOutcome = {
        content: "Revised result",
        details: {
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
            title: "Implement fix revision",
            agent: "worker",
            status: "completed",
            background: false,
            task: "Original task",
            workspaceId: "workspace-1",
            recentActivity: [],
            usage: ZERO_USAGE,
            startedAt: 4,
            updatedAt: 5,
        },
        usage: ZERO_USAGE,
        isError: false,
    };
    const manager = {
        hasPersistence: false,
        flushPersistence: vi.fn(async () => {}),
        getPersistedRun: vi.fn((): AgentRunCatalogRecord | undefined => record),
        reserveRunIdentity: vi.fn(() => ({
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
        })),
        reserveContinuationLease: vi.fn(() => undefined),
        startContinuation: vi.fn(async (): Promise<AgentRunOutcome> => continuationOutcome),
    };
    const ctx = stubContext({
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        sessionManager: stubSessionManager({ getSessionId: () => "parent-session" }),
        ui: stubUi(),
    });
    const events: AgentEventSink = { emit: () => {} };
    return {
        record,
        workspace,
        definition,
        continuationOutcome,
        manager,
        ctx,
        progress: vi.fn(),
        events,
        discover: vi.fn((): ReturnType<AgentLifecycle["discover"]> => ({
            agents: [definition],
            diagnostics: [],
        })),
    };
}

function configureRevisionAction(fixture: ReturnType<typeof revisionActionFixture>) {
    vi.spyOn(workspaceGit, "git").mockResolvedValue("worker-head");
    vi.spyOn(workspaceGit, "hasAncestor").mockResolvedValue(true);
    vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([fixture.record]);
    vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(fixture.workspace);
    return vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockResolvedValue();
}

async function executeRevisionAction(
    fixture: ReturnType<typeof revisionActionFixture>,
): Promise<unknown> {
    return executeParentWorkspaceAction(
        { action: "continue", runId: fixture.record.runId, guidance: "Apply feedback" },
        {
            ctx: fixture.ctx,
            manager: fixture.manager as unknown as AgentRunManager,
            signal: undefined,
            progress: fixture.progress,
            events: fixture.events,
            discover: fixture.discover,
        },
    );
}

describe("agent extension registration", () => {
    it("rolls back a transferred workspace lease when manager startup rejects", async () => {
        const workspace = partialWorkspace({
            id: "workspace-start-failure",
            cwd: process.cwd(),
            repositoryRoot: process.cwd(),
            worktreePath: "/tmp/workspace-start-failure",
            slug: "workspace-start-failure",
            baseRevision: "base-revision",
            setupState: "ready",
            status: "available",
            createdAt: 1,
            updatedAt: 1,
        });
        const reservation = {
            workspace,
            ownerSessionId: "parent-session",
            provisionalLeaseRunId: "provisional-1",
            provisionalLeaseRunInstanceId: "provisional-instance-1",
        };
        const startError = new Error("manager startup failed");
        vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockResolvedValue(reservation);
        const transferSpy = vi
            .spyOn(workspaceStore, "transferAgentWorkspaceLease")
            .mockResolvedValue();
        const manager = {
            reserveRunIdentity: vi.fn(() => ({
                runId: "worker-1",
                runInstanceId: "worker-instance-1",
            })),
            start: vi.fn().mockRejectedValue(startError),
        };
        const definition = TEST_WORKER_DEFINITION;
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => true,
            isIdle: () => true,
            sessionManager: stubSessionManager({ getSessionId: () => "parent-session" }),
            ui: stubUi(),
        });
        const lifecycle = {
            manager,
            factory: vi.fn(),
            discover: vi.fn(() => ({ agents: [definition], diagnostics: [] })),
            backgroundUpdate: vi.fn(() => () => {}),
            updateSetupRun: vi.fn(),
            clearCompletedWorkspaceSetup: vi.fn(),
            emitWorkspaceEvent: vi.fn(),
            events: undefined,
            eventBus: undefined,
        };

        const outcome = await executeAgentAction(
            {
                action: "start",
                agent: "worker",
                task: "Implement the change",
                isolation: "worktree",
                background: true,
            },
            {
                signal: undefined,
                progress: vi.fn(),
                ctx,
                lifecycle: lifecycle as unknown as AgentLifecycle,
            },
        );

        expect(outcome.details.status).toBe("failed");
        expect(transferSpy).toHaveBeenNthCalledWith(1, workspace.id, {
            ownerSessionId: reservation.ownerSessionId,
            fromLeaseRunId: reservation.provisionalLeaseRunId,
            fromLeaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
            toLeaseRunId: "worker-1",
            toLeaseRunInstanceId: "worker-instance-1",
            leaseKind: "task",
        });
        expect(transferSpy).toHaveBeenNthCalledWith(2, workspace.id, {
            ownerSessionId: reservation.ownerSessionId,
            fromLeaseRunId: "worker-1",
            fromLeaseRunInstanceId: "worker-instance-1",
            toLeaseRunId: reservation.provisionalLeaseRunId,
            toLeaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
            leaseKind: "task",
        });
    });

    it("keeps setup status for non-completed task outcomes", () => {
        const setupRuns = new Map<string, AgentRunSummary>([
            ["setup-1", { workspaceId: "workspace-1" } as AgentRunSummary],
        ]);

        for (const status of ["failed", "canceled", "interrupted"] as const) {
            expect(
                clearCompletedWorkspaceSetupRun(setupRuns, {
                    agent: "worker",
                    status,
                    workspaceId: "workspace-1",
                }),
            ).toBe(false);
            expect(setupRuns.has("setup-1")).toBe(true);
        }

        expect(
            clearCompletedWorkspaceSetupRun(setupRuns, {
                agent: "worker",
                status: "completed",
                workspaceId: "workspace-1",
            }),
        ).toBe(true);
        expect(setupRuns.has("setup-1")).toBe(false);
    });

    it("registers the tool, advertises agents, and marks failed results as errors", async () => {
        const stub = createPiStub();
        const events: Array<{ channel: string; data: unknown }> = [];
        stub.pi.events?.on(AGENT_EVENT_CHANNEL, (data) => {
            events.push({ channel: AGENT_EVENT_CHANNEL, data });
        });
        const child: ChildAgentHandle = {
            prompt: async () => {},
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "Done", recentActivity: [] }),
            getFinalOutput: () => "Done",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        // Built after registration, so every list is the double's own and keeps handler order.
        const handlers = handlerView(
            stub,
            "session_start",
            "before_agent_start",
            "tool_result",
            "session_shutdown",
        );
        const tool = agentTool(stub);
        const [shortcut] = stub.shortcuts;

        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            sessionManager: stubSessionManager({ getSessionFile: () => undefined }),
            ui: stubUi({ setWidget: () => {} }),
        });
        await handlers.session_start[0]({ reason: "startup" }, ctx);
        const prompt = (await handlers.before_agent_start[0](
            { systemPrompt: "Parent prompt" },
            ctx,
        )) as BeforeAgentStartEventResult;
        const result = await tool.execute(
            "call-1",
            { action: "start", agent: "scout", task: "Inspect" },
            undefined,
            undefined,
            ctx,
        );
        const errorHook = await handlers.tool_result[0](
            {
                toolName: "agent",
                details: { status: "failed" },
            },
            ctx,
        );

        expect(stub.order).toEqual([
            "shortcut:ctrl+alt+b",
            "command:agent-trace",
            "command:agents",
            "on:session_start",
            "on:agent_settled",
            "on:before_agent_start",
            "on:session_before_tree",
            "on:session_tree",
            "on:session_shutdown",
            "on:tool_result",
            "tool:agent",
        ]);
        expect(tool.definition.executionMode).toBe("sequential");
        expect(shortcut?.key).toBe("ctrl+alt+b");
        expect(shortcut?.options.description).toBe("Move foreground delegated agent to background");
        await expect(
            [tool.definition.description, ...requirePromptGuidelines(tool.definition)].join("\n"),
        ).toMatchFileSnapshot("__snapshots__/agent-tool.delegation-guidance.txt");
        await expect(prompt.systemPrompt).toMatchFileSnapshot(
            "__snapshots__/agent-tool.parent-system-prompt.txt",
        );
        const repeatedPrompt = (await handlers.before_agent_start[0](
            prompt,
            ctx,
        )) as BeforeAgentStartEventResult;
        expect(repeatedPrompt).toEqual(prompt);
        expect(result.details).toMatchObject({ status: "completed", agent: "scout" });
        expect(events).toContainEqual({
            channel: AGENT_EVENT_CHANNEL,
            data: expect.objectContaining({
                cwd: process.cwd(),
                type: "run",
                action: "created",
                runId: "scout-1",
            }),
        });
        expect(events).toContainEqual({
            channel: AGENT_EVENT_CHANNEL,
            data: expect.objectContaining({
                type: "run",
                action: "status_changed",
                status: "running",
                runId: "scout-1",
            }),
        });
        expect(events).toContainEqual({
            channel: AGENT_EVENT_CHANNEL,
            data: expect.objectContaining({
                type: "run",
                action: "removed",
                reason: "terminal",
                runId: "scout-1",
            }),
        });
        expect(errorHook).toEqual({ isError: true });
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("keeps an ignored-context warning in metadata", async () => {
        const stub = createPiStub();
        const child: ChildAgentHandle = {
            prompt: async () => {},
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "Done", recentActivity: [] }),
            getFinalOutput: () => "Done",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        const handlers = handlerView(stub, "session_shutdown");
        const tool = agentTool(stub);

        const result = await tool.execute(
            "call-context-warning",
            {
                action: "start",
                agent: "scout",
                task: "Inspect",
                context: {
                    sections: [
                        {
                            id: "parent_summary",
                            title: "Summary",
                            content: "Known",
                            source: "parent",
                        },
                    ],
                },
            },
            undefined,
            undefined,
            stubContext({
                cwd: process.cwd(),
                isProjectTrusted: () => false,
                isIdle: () => false,
                sessionManager: stubSessionManager({
                    getSessionId: () => "parent-session",
                    getSessionFile: () => undefined,
                }),
                ui: stubUi({ setWidget: () => {} }),
            }),
        );

        expect(result.details.status).toBe("completed");
        await expect(agentToolText(result)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.ignored-context-response.txt",
        );
        await handlers.session_shutdown?.[0]?.({}, {});
    });

    it("snapshots the Ctrl+Alt+B foreground-to-background result", async () => {
        const stub = createPiStub();
        let promptStarted = false;
        let releasePrompt: (() => void) | undefined;
        let output = "";
        const child: ChildAgentHandle = {
            prompt: async () => {
                promptStarted = true;
                await new Promise<void>((resolve) => {
                    releasePrompt = resolve;
                });
                output = "Finished after manual backgrounding.";
            },
            abort: async () => {
                releasePrompt?.();
            },
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output, recentActivity: [] }),
            getFinalOutput: () => output,
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        const handlers = handlerView(stub, "session_shutdown");
        const tool = agentTool(stub);
        const [shortcut] = stub.shortcuts;

        const ctx = stubContext({
            cwd: process.cwd(),
            mode: "tui",
            hasUI: true,
            isProjectTrusted: () => false,
            isIdle: () => false,
            sessionManager: stubSessionManager({
                getSessionId: () => "parent-session",
                getSessionFile: () => undefined,
            }),
            ui: stubUi({ setWidget: () => {} }),
        });
        const start = tool.execute(
            "call-manual-background",
            { action: "start", agent: "scout", task: "Inspect before continuing" },
            undefined,
            undefined,
            ctx,
        );

        await vi.waitFor(() => expect(promptStarted).toBe(true));
        await shortcut?.options.handler(ctx);
        const moved = await start;

        expect(moved.details).toMatchObject({ status: "running", background: true });
        await expect(agentToolText(moved)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.manual-background.txt",
        );

        releasePrompt?.();
        await vi.waitFor(() => expect(output).toBe("Finished after manual backgrounding."));
        await handlers.session_shutdown?.[0]?.({}, ctx);
    });

    it("renders the full prompt and preserves response whitespace without metadata", async () => {
        const stub = createPiStub();
        const prompt =
            "Review the implementation.\nPlease inspect the relevant modules and report any regressions.";
        const response = "\n  leading spaces\ntrailing spaces  \n";
        registerAgentToolDefinition(stub.pi, async (): Promise<AgentRunOutcome> => {
            return {
                content: response,
                details: partialDetails({
                    title: "Natural validation run",
                    agent: "scout",
                    status: "completed",
                    task: prompt,
                    response,
                    toolCounts: { read: 2, grep: 1 },
                    failedToolCalls: 1,
                }),
                usage: ZERO_USAGE,
                isError: false,
            };
        });
        const tool = agentTool(stub);

        const result = await tool.execute(
            "call-render",
            { action: "start", agent: "scout", task: prompt },
            undefined,
            undefined,
            {},
        );
        agentTextPart(result).text = `<metadata>generated metadata</metadata>\n\n${response}`;
        const rendered = snapshotText(
            renderText(tool.renderResult(result, { expanded: true }, mockTheme), 10_000),
        );

        await expect(rendered).toMatchFileSnapshot("__snapshots__/agent-tool.tui.markdown.txt");
    });

    it("applies a parent workspace result and verifies the lease is cleared", async () => {
        const stub = createPiStub();
        const result = partialWorkspaceResult({
            id: "result-1",
            workspaceId: "workspace-1",
            runId: "worker-1",
            baseRevision: "base",
            workerHead: "worker",
            commitRange: "base..worker",
            commits: ["worker"],
            preparedAt: 1,
            status: "prepared",
        });
        const workspace = partialWorkspace({
            id: "workspace-1",
            cwd: process.cwd(),
            repositoryRoot: process.cwd(),
            worktreePath: process.cwd(),
            slug: "test-workspace",
            baseRevision: "base",
            setupState: "ready",
            status: "review_required",
            leaseOwnerSessionId: "parent-1",
            leaseRunId: "worker-1",
            leaseKind: "task",
            latestResult: result,
            createdAt: 1,
            updatedAt: 1,
        });
        const releasedWorkspace: AgentWorkspace = {
            ...workspace,
            status: "review_required",
            leaseOwnerSessionId: undefined,
            leaseRunId: undefined,
            leaseKind: undefined,
            latestResult: { ...result, status: "applied" },
        };
        vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([
            {
                ownerSessionId: "parent-1",
                runId: "worker-1",
                parentCwd: process.cwd(),
                title: "Worker result",
                agent: "worker",
                agentSource: "builtin",
                task: "Implement the change",
                status: "removed",
                background: true,
                mutating: true,
                workspaceId: "workspace-1",
                startedAt: 1,
                updatedAt: 1,
                usageSnapshot: ZERO_USAGE,
            },
        ]);
        vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValueOnce(workspace);
        const executeWorkspaceAction = vi
            .spyOn(workspaceActions, "executeWorkspaceAction")
            .mockResolvedValue({
                workspace: releasedWorkspace,
                result: {
                    ...result,
                    status: "applied",
                    parentRevision: "base",
                    appliedAt: 2,
                },
                effects: ["result_changed", "lease_changed", "workspace_updated"],
                disposition: "applied",
            });
        registerAgentTool(stub.pi, async () => {
            throw new Error("not used");
        });
        const tool = agentTool(stub);

        const outcome = await tool.execute(
            "call-apply",
            { action: "apply", runId: "worker-1" },
            undefined,
            undefined,
            stubContext({
                cwd: process.cwd(),
                isIdle: () => false,
                sessionManager: stubSessionManager({ getSessionId: () => "parent-1" }),
                ui: stubUi({ setWidget: () => {} }),
            }),
        );

        expect(executeWorkspaceAction).toHaveBeenCalledWith({
            action: "apply",
            workspace,
            ownerSessionId: "parent-1",
            runId: "worker-1",
            resultId: "result-1",
        });
        expect(outcome.details.workspaceResult).toMatchObject({ status: "applied" });
        expect(releasedWorkspace.leaseRunId).toBeUndefined();
    });

    it("renders and executes a complete start, wait, continue flow", async () => {
        const stub = createPiStub();
        let promptCount = 0;
        let output = "";
        let question: { question: string; context: string } | undefined;
        const child: ChildAgentHandle = {
            async prompt() {
                promptCount++;
                if (promptCount === 1) {
                    output = "I found two plausible implementations.";
                    question = {
                        question: "Should I compare both implementations?",
                        context: "Implementation A is simpler; B has more callers.",
                    };
                } else {
                    output =
                        "Implementation A is preferred because it preserves the existing contract.";
                }
            },
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion() {
                const pending = question;
                question = undefined;
                return pending;
            },
            getProgress: () => ({
                output,
                recentActivity: [],
                toolCounts: { read: 2, grep: 1 },
                failedToolCalls: 1,
            }),
            getFinalOutput: () => output,
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        const handlers = handlerView(stub, "session_shutdown");
        const tool = agentTool(stub);
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            ui: stubUi({ setWidget: () => {} }),
        });

        const waiting = await tool.execute(
            "call-1",
            { action: "start", agent: "scout", task: "Compare implementations" },
            undefined,
            undefined,
            ctx,
        );
        const waitingText = snapshotText(
            renderText(tool.renderResult(waiting, { expanded: false }, mockTheme), 120),
        );
        expect(waiting.details.status).toBe("waiting_for_parent");
        await expect(agentToolText(waiting)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.foreground-waiting.txt",
        );
        await expect(waitingText).toMatchFileSnapshot(
            "__snapshots__/agent-tool.tui.foreground-waiting.txt",
        );

        const completed = await tool.execute(
            "call-2",
            { action: "continue", runId: "scout-1", guidance: "Yes, compare both." },
            undefined,
            undefined,
            ctx,
        );
        const completedText = snapshotText(
            renderText(tool.renderResult(completed, { expanded: true }, mockTheme), 120),
        );
        expect(completed.details.status).toBe("completed");
        await expect(agentToolText(completed)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.foreground-completed.txt",
        );
        await expect(completedText).toMatchFileSnapshot(
            "__snapshots__/agent-tool.tui.foreground-completed.txt",
        );
        expect(promptCount).toBe(2);
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("executes a background start, status, and collect flow", async () => {
        const stub = createPiStub();
        const sentMessages = stub.sentMessages;
        let background = false;
        let reportProgress: ((progress: ChildProgress) => void) | undefined;
        let childProgress: ChildProgress = { output: "", recentActivity: [] };
        const child: ChildAgentHandle = {
            async prompt() {
                childProgress = {
                    output: "Inspecting the run manager lifecycle.",
                    recentActivity: ["Reading src/tools/agent/runtime.ts"],
                };
                reportProgress?.(childProgress);
            },
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => childProgress,
            getFinalOutput: () => "Background result",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async (context) => {
            background = context.background === true;
            reportProgress = context.onProgress;
            return child;
        });
        const widgetPlacements: Array<string | undefined> = [];
        let widgetComponent: Component | undefined;
        const widgets: Array<string[] | undefined> = [];
        let lastWidgetState: string | undefined;
        // deduplicate widget renders so microtask changes don't completely change the snapshot
        const recordWidgetState = (lines: string[] | undefined): void => {
            const state = lines?.join("\n").trimEnd();
            if (state === lastWidgetState) {
                return;
            }
            lastWidgetState = state;
            widgets.push(lines);
        };
        // The status widget only ever calls `requestRender()` on the TUI it is handed.
        const widgetTui = {
            requestRender() {
                if (widgetComponent) recordWidgetState(widgetComponent.render(200));
            },
        } as TUI;
        const ui = stubUi({
            setWidget(_id, value, options) {
                if (typeof value === "function") {
                    widgetComponent = value(widgetTui, mockTheme);
                    recordWidgetState(widgetComponent.render(200));
                } else {
                    widgetComponent = undefined;
                    recordWidgetState(value);
                }
                if (value) widgetPlacements.push(options?.placement);
            },
        });
        const ctx = stubContext({
            cwd: process.cwd(),
            mode: "tui",
            hasUI: true,
            isProjectTrusted: () => false,
            isIdle: () => false,
            ui,
        });
        registerStatusWidget(stub.pi);
        // Built after both registrations: `session_start` keeps the widget handler last.
        const handlers = handlerView(
            stub,
            "session_start",
            "before_agent_start",
            "agent_settled",
            "session_shutdown",
        );
        const tool = agentTool(stub);

        await handlers.session_start.at(-1)?.({}, ctx);

        const started = await tool.execute(
            "call-1",
            { action: "start", agent: "scout", task: "Inspect concurrently", background: true },
            undefined,
            undefined,
            ctx,
        );
        for (let index = 0; index < 12; index++) await Promise.resolve();
        const status = await tool.execute(
            "call-2",
            { action: "status", runId: "scout-1" },
            undefined,
            undefined,
            ctx,
        );
        const prompt = (await handlers.before_agent_start[0](
            { systemPrompt: "Parent prompt" },
            ctx,
        )) as BeforeAgentStartEventResult;
        expect(sentMessages).toEqual([]);
        await handlers.agent_settled[0]({}, { ...ctx, isIdle: () => true });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
        expect(sentMessages[0]?.message).toMatchObject({
            customType: "pi-coder-agent-mailbox",
            display: false,
        });
        await expect(sentMessages[0]?.message.content).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.background-mailbox-completion.txt",
        );
        const listWorkspaces = vi
            .spyOn(workspaceStore, "listAgentWorkspaces")
            .mockResolvedValue([]);
        const listed = await tool.execute(
            "call-list",
            { action: "list" },
            undefined,
            undefined,
            ctx,
        );
        expect(listWorkspaces).toHaveBeenCalledWith(process.cwd(), {
            includeMissingWorktrees: true,
        });
        const collected = await tool.execute(
            "call-3",
            { action: "collect", runId: "scout-1" },
            undefined,
            undefined,
            ctx,
        );

        expect(started.details).toMatchObject({ status: "starting", background: true });
        await expect(agentToolText(started)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.background-start.txt",
        );
        expect(status.details.status).toBe("completed");
        await expect(agentToolText(status)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.background-status.txt",
        );
        const promptAfterSpawn = (await handlers.before_agent_start[0](
            { systemPrompt: "Parent prompt" },
            ctx,
        )) as BeforeAgentStartEventResult;
        expect(promptAfterSpawn).toEqual(prompt);
        await expect(agentToolText(listed)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.background-list.txt",
        );
        expect(collected.details.status).toBe("completed");
        await expect(agentToolText(collected)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.background-collect.txt",
        );
        const widgetLines = widgets.flatMap((lines) => lines ?? []).map((line) => line.trimEnd());
        await expect(widgetLines.join("\n")).toMatchFileSnapshot(
            "__snapshots__/agent-tool.tui.background-widget.txt",
        );
        expect(widgets[widgets.length - 1]).toBeUndefined();
        expect(widgetPlacements).toContain("aboveEditor");
        expect(background).toBe(true);
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("prepares an isolated result before collecting it in the parent", async () => {
        const stub = createPiStub({ eventBus: null });
        // No bus at all: `lifecycle.eventBus` is the `dialogEvents` argument asserted below, and pi marks
        // `events` required even though production treats it as optional.
        const workspace = partialWorkspace({
            id: "workspace-1",
            cwd: process.cwd(),
            repositoryRoot: process.cwd(),
            worktreePath: "/tmp/workspace-1",
            slug: "workspace-1",
            baseRevision: "base-revision",
            setupState: "ready",
            status: "available",
            createdAt: 1,
            updatedAt: 1,
        });
        const result: AgentWorkspaceResult = {
            id: "result-1",
            workspaceId: workspace.id,
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
            baseRevision: workspace.baseRevision,
            workerHead: "worker-head",
            commitRange: "base-revision..worker-head",
            commits: ["worker-head"],
            durableRef: "refs/pi-coder/workspace-results/workspace-1/result-1",
            preparedAt: 2,
            status: "prepared",
        };
        const setupSpy = vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockResolvedValue({
            workspace,
            ownerSessionId: "parent-session",
            provisionalLeaseRunId: "provisional-1",
            provisionalLeaseRunInstanceId: "provisional-instance-1",
        });
        const transferSpy = vi
            .spyOn(workspaceStore, "transferAgentWorkspaceLease")
            .mockResolvedValue();
        const getWorkspaceSpy = vi
            .spyOn(workspaceStore, "getAgentWorkspace")
            .mockResolvedValue(workspace);
        const prepareResultSpy = vi
            .spyOn(workspaceResults, "prepareAgentWorkspaceApplication")
            .mockResolvedValue(result);
        const child: ChildAgentHandle = {
            prompt: async () => {},
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "Finished", recentActivity: [] }),
            getFinalOutput: () => "Finished in isolation",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        const handlers = handlerView(stub, "session_start", "session_shutdown");
        const tool = agentTool(stub);
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            sessionManager: stubSessionManager({
                getSessionId: () => "parent-session",
                getSessionFile: () => undefined,
            }),
            ui: stubUi({ setWidget: () => {} }),
        });
        await handlers.session_start[0]({}, ctx);
        await tool.execute(
            "call-1",
            {
                action: "start",
                agent: "worker",
                task: "Implement in isolation",
                isolation: "worktree",
                background: true,
            },
            undefined,
            undefined,
            ctx,
        );
        for (let index = 0; index < 12; index++) await Promise.resolve();

        const collected = await tool.execute(
            "call-2",
            { action: "collect", runId: "worker-1" },
            undefined,
            undefined,
            ctx,
        );

        expect(setupSpy).toHaveBeenCalledOnce();
        expect(setupSpy).toHaveBeenCalledWith(
            process.cwd(),
            expect.objectContaining({
                definition: expect.objectContaining({ name: "worker" }),
                factory: expect.any(Function),
                manager: expect.anything(),
                ctx,
                signal: undefined,
                onUiUpdate: expect.any(Function),
                events: expect.anything(),
                dialogEvents: undefined,
            }),
        );
        expect(transferSpy).toHaveBeenCalledWith(workspace.id, {
            ownerSessionId: "parent-session",
            fromLeaseRunId: "provisional-1",
            toLeaseRunId: "worker-1",
            leaseKind: "task",
            fromLeaseRunInstanceId: "provisional-instance-1",
            toLeaseRunInstanceId: expect.any(String),
        });
        expect(getWorkspaceSpy).toHaveBeenCalledWith(workspace.id);
        expect(prepareResultSpy).toHaveBeenCalledWith(workspace, {
            ownerSessionId: "parent-session",
            leaseRunId: "worker-1",
            leaseRunInstanceId: expect.any(String),
        });
        expect(collected.details.workspaceResult).toEqual(result);
        await expect(agentToolText(collected)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.isolated-collect.txt",
        );
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("revises an isolated result by continuing its persisted child session", async () => {
        const childSessionFile = "/tmp/agent-child.jsonl";
        const record: AgentRunCatalogRecord = {
            ownerSessionId: "parent-session",
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
            parentCwd: process.cwd(),
            title: "Implement fix",
            agent: "worker",
            agentSource: "builtin",
            definitionSnapshot: TEST_WORKER_DEFINITION,
            task: "Original task",
            status: "removed",
            background: true,
            mutating: true,
            workspaceId: "workspace-1",
            childSessionFile,
            childSessionLeafId: "leaf-1",
            startedAt: 1,
            updatedAt: 2,
            usageSnapshot: ZERO_USAGE,
        };
        const workspace = partialWorkspace({
            id: "workspace-1",
            cwd: process.cwd(),
            repositoryRoot: process.cwd(),
            worktreePath: "/tmp/workspace-1",
            slug: "workspace-1",
            baseRevision: "base-revision",
            setupState: "ready",
            status: "review_required",
            leaseOwnerSessionId: "parent-session",
            leaseRunId: "worker-1",
            leaseRunInstanceId: "worker-instance-1",
            leaseKind: "task",
            latestResult: partialWorkspaceResult({
                id: "result-1",
                workspaceId: "workspace-1",
                runId: "worker-1",
                runInstanceId: "worker-instance-1",
                baseRevision: "base-revision",
                workerHead: "worker-head",
                commitRange: "base-revision..worker-head",
                commits: ["worker-head"],
                preparedAt: 3,
                status: "prepared",
            }),
            createdAt: 1,
            updatedAt: 2,
        });
        const definition: AgentDefinition = {
            ...TEST_WORKER_DEFINITION,
            systemPrompt: "Current definition changed",
        };
        const continuationOutcome: AgentRunOutcome = {
            content: "Revised result",
            details: {
                runId: "worker-1",
                runInstanceId: "worker-instance-1",
                title: "Implement fix revision",
                agent: "worker",
                status: "completed",
                background: false,
                task: "Original task",
                workspaceId: "workspace-1",
                recentActivity: [],
                usage: ZERO_USAGE,
                startedAt: 4,
                updatedAt: 5,
            },
            usage: ZERO_USAGE,
            isError: false,
        };
        const manager = {
            flushPersistence: vi.fn(async () => {}),
            getPersistedRun: vi.fn((): AgentRunCatalogRecord | undefined => record),
            reserveRunIdentity: vi.fn(() => ({
                runId: "worker-1",
                runInstanceId: "worker-instance-1",
            })),
            startContinuation: vi.fn(async (): Promise<AgentRunOutcome> => continuationOutcome),
        };
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => true,
            sessionManager: stubSessionManager({ getSessionId: () => "parent-session" }),
            ui: stubUi(),
        });
        const progress = vi.fn();
        const events: AgentEventSink = { emit: () => {} };
        const discover = vi.fn((): ReturnType<AgentLifecycle["discover"]> => ({
            agents: [definition],
            diagnostics: [],
        }));
        vi.spyOn(workspaceGit, "git").mockResolvedValue("worker-head");
        vi.spyOn(workspaceGit, "hasAncestor").mockResolvedValue(true);
        vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([record]);
        vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(workspace);
        const transferSpy = vi
            .spyOn(workspaceStore, "transferAgentWorkspaceLease")
            .mockResolvedValue();
        vi.spyOn(workspaceFinalization, "prepareForegroundWorkspaceResult").mockResolvedValue(
            continuationOutcome,
        );

        const result = await executeParentWorkspaceAction(
            { action: "continue", runId: "worker-1", guidance: "Apply feedback" },
            {
                ctx,
                manager: manager as unknown as AgentRunManager,
                signal: undefined,
                progress,
                events,
                discover,
            },
        );

        expect(result).toBe(continuationOutcome);
        expect(discover).toHaveBeenCalledWith(ctx);
        expect(manager.startContinuation).toHaveBeenCalledWith(
            record.definitionSnapshot,
            "Original task",
            "Apply feedback",
            expect.objectContaining({
                cwd: "/tmp/workspace-1",
                workspaceId: "workspace-1",
                childSessionFile,
                childSessionLeafId: "leaf-1",
            }),
            expect.objectContaining({
                signal: undefined,
                onProgress: progress,
                title: "Implement fix revision",
                identity: { runId: "worker-1", runInstanceId: "worker-instance-1" },
                onWorkspaceCheckpoint: expect.any(Function),
            }),
        );
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("revises a collected reviewer result by continuing its persisted child session", async () => {
        const childSessionFile = "/tmp/reviewer-child.jsonl";
        const definition: AgentDefinition = {
            name: "reviewer",
            source: "builtin",
            capabilities: [
                "read",
                "search",
                "memories",
                "scratchpad",
                "safe-bash",
                "command-runner",
            ],
            description: "Code and Git-history review with validation",
            systemPrompt: "Reviewer prompt",
        };
        const record: AgentRunCatalogRecord = {
            ownerSessionId: "parent-session",
            runId: "reviewer-1",
            runInstanceId: "reviewer-instance-1",
            parentCwd: process.cwd(),
            executionCwd: process.cwd(),
            title: "Review changes",
            agent: "reviewer",
            agentSource: "builtin",
            definitionSnapshot: definition,
            task: "Review the current changes",
            status: "removed",
            background: true,
            mutating: false,
            childSessionFile,
            childSessionLeafId: "leaf-1",
            startedAt: 1,
            updatedAt: 2,
            usageSnapshot: ZERO_USAGE,
        };
        const continuationOutcome: AgentRunOutcome = {
            content: "The revised review found no additional issues.",
            details: {
                runId: "reviewer-1",
                runInstanceId: "reviewer-instance-1",
                title: "Review changes revision",
                agent: "reviewer",
                status: "completed",
                background: false,
                task: "Review the current changes",
                recentActivity: [],
                usage: ZERO_USAGE,
                startedAt: 4,
                updatedAt: 5,
            },
            usage: ZERO_USAGE,
            isError: false,
        };
        const manager = {
            flushPersistence: vi.fn(async () => {}),
            getPersistedRun: vi.fn((): AgentRunCatalogRecord | undefined => record),
            reserveRunIdentity: vi.fn(() => ({
                runId: "reviewer-1",
                runInstanceId: "reviewer-instance-1",
            })),
            startContinuation: vi.fn(async (): Promise<AgentRunOutcome> => continuationOutcome),
        };
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => true,
            sessionManager: stubSessionManager({ getSessionId: () => "parent-session" }),
            ui: stubUi(),
        });
        const progress = vi.fn();
        const onBackgroundUpdate = vi.fn();
        const events: AgentEventSink = { emit: () => {} };
        const discover = vi.fn((): ReturnType<AgentLifecycle["discover"]> => ({
            agents: [definition],
            diagnostics: [],
        }));
        vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([record]);

        const result = await executeParentWorkspaceAction(
            {
                action: "continue",
                runId: "reviewer-1",
                guidance: "Please re-check the API compatibility findings.",
            },
            {
                ctx,
                manager: manager as unknown as AgentRunManager,
                signal: undefined,
                progress,
                events,
                onBackgroundUpdate,
                discover,
            },
        );

        expect(result).toBe(continuationOutcome);
        expect(manager.reserveRunIdentity).toHaveBeenCalledWith(
            definition,
            "Review the current changes",
            expect.objectContaining({
                cwd: process.cwd(),
                parentCwd: process.cwd(),
                childSessionFile,
                childSessionLeafId: "leaf-1",
            }),
            "reviewer-1",
            "reviewer-instance-1",
        );
        expect(manager.startContinuation).toHaveBeenCalledWith(
            definition,
            "Review the current changes",
            "Please re-check the API compatibility findings.",
            expect.objectContaining({
                cwd: process.cwd(),
                parentCwd: process.cwd(),
                childSessionFile,
                childSessionLeafId: "leaf-1",
            }),
            {
                signal: undefined,
                onProgress: progress,
                onBackgroundUpdate,
                title: "Review changes revision",
                identity: { runId: "reviewer-1", runInstanceId: "reviewer-instance-1" },
            },
        );
        expect(discover).toHaveBeenCalledWith(ctx);
        expect(result.details.discoveryDiagnostics).toEqual([]);

        const continuedRecord = {
            ...record,
            runInstanceId: "reviewer-instance-1",
            childSessionLeafId: "leaf-2",
            updatedAt: 6,
        };
        const secondOutcome: AgentRunOutcome = {
            ...continuationOutcome,
            content: "The second review continuation completed.",
            details: {
                ...continuationOutcome.details,
                runInstanceId: "reviewer-instance-1",
                updatedAt: 7,
            },
        };
        manager.getPersistedRun.mockReturnValue(continuedRecord);
        manager.reserveRunIdentity.mockReturnValue({
            runId: "reviewer-1",
            runInstanceId: "reviewer-instance-1",
        });
        manager.startContinuation.mockResolvedValue(secondOutcome);

        const secondResult = await executeParentWorkspaceAction(
            {
                action: "continue",
                runId: "reviewer-1",
                guidance: "Follow up on the remaining concern.",
            },
            {
                ctx,
                manager: manager as unknown as AgentRunManager,
                signal: undefined,
                progress,
                events,
                onBackgroundUpdate,
                discover,
            },
        );

        expect(secondResult).toBe(secondOutcome);
        expect(secondResult.details.runId).toBe(result.details.runId);
        expect(manager.startContinuation).toHaveBeenLastCalledWith(
            definition,
            "Review the current changes",
            "Follow up on the remaining concern.",
            expect.objectContaining({
                childSessionFile,
                childSessionLeafId: "leaf-2",
            }),
            expect.objectContaining({
                onBackgroundUpdate,
                title: "Review changes revision",
                identity: { runId: "reviewer-1", runInstanceId: "reviewer-instance-1" },
            }),
        );
    });

    it("does not fall back to catalog-only runs when branch persistence is active", async () => {
        const fixture = revisionActionFixture();
        configureRevisionAction(fixture);
        fixture.manager.getPersistedRun.mockReturnValue(undefined);
        fixture.manager.hasPersistence = true;

        await expect(executeRevisionAction(fixture)).rejects.toThrow(
            "Unknown or stale agent run ID: worker-1",
        );
        expect(fixture.manager.startContinuation).not.toHaveBeenCalled();
    });

    it("rejects a divergent workspace before starting a revision", async () => {
        const fixture = revisionActionFixture();
        const transferSpy = configureRevisionAction(fixture);
        vi.mocked(workspaceGit.git).mockResolvedValue("divergent-head");
        vi.mocked(workspaceGit.hasAncestor).mockResolvedValue(false);

        await expect(executeRevisionAction(fixture)).rejects.toThrow(
            "Cannot continue workspace workspace-1",
        );
        expect(fixture.manager.reserveRunIdentity).not.toHaveBeenCalled();
        expect(fixture.manager.startContinuation).not.toHaveBeenCalled();
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("fails clearly when an isolated result has no persisted definition snapshot", async () => {
        const fixture = revisionActionFixture();
        delete fixture.record.definitionSnapshot;
        const transferSpy = configureRevisionAction(fixture);

        await expect(executeRevisionAction(fixture)).rejects.toThrow(
            "has no persisted agent definition snapshot; it cannot be continued",
        );
        expect(fixture.manager.reserveRunIdentity).not.toHaveBeenCalled();
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("does not transfer the workspace when continuation setup fails", async () => {
        const fixture = revisionActionFixture();
        const transferSpy = configureRevisionAction(fixture);
        const startError = new Error("child session could not be reopened");
        fixture.manager.startContinuation.mockRejectedValue(startError);

        await expect(executeRevisionAction(fixture)).rejects.toBe(startError);
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("preserves the stable workspace lease when revised result finalization fails", async () => {
        const fixture = revisionActionFixture();
        const transferSpy = configureRevisionAction(fixture);
        const finalizationError = new Error("result finalization failed");
        vi.spyOn(workspaceFinalization, "prepareForegroundWorkspaceResult").mockRejectedValue(
            finalizationError,
        );

        await expect(executeRevisionAction(fixture)).rejects.toBe(finalizationError);
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("prepares and releases a no-change isolated foreground result", async () => {
        const stub = createPiStub();
        const workspace = partialWorkspace({
            id: "workspace-foreground",
            cwd: process.cwd(),
            repositoryRoot: process.cwd(),
            worktreePath: "/tmp/workspace-foreground",
            slug: "workspace-foreground",
            baseRevision: "base-revision",
            setupState: "ready",
            status: "available",
            createdAt: 1,
            updatedAt: 1,
        });
        const result: AgentWorkspaceResult = {
            id: "result-foreground",
            workspaceId: workspace.id,
            runId: "worker-1",
            runInstanceId: "worker-instance-foreground",
            baseRevision: workspace.baseRevision,
            workerHead: workspace.baseRevision,
            commitRange: `${workspace.baseRevision}..${workspace.baseRevision}`,
            commits: [],
            preparedAt: 2,
            status: "prepared",
        };
        vi.spyOn(workspaceSetup, "prepareIsolatedWorkspace").mockResolvedValue({
            workspace,
            ownerSessionId: "parent-session",
            provisionalLeaseRunId: "provisional-foreground",
            provisionalLeaseRunInstanceId: "provisional-instance-foreground",
        });
        const order: string[] = [];
        const transferSpy = vi
            .spyOn(workspaceStore, "transferAgentWorkspaceLease")
            .mockImplementation(async () => {
                order.push("transfer");
            });
        vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(workspace);
        const prepareResultSpy = vi
            .spyOn(workspaceResults, "prepareAgentWorkspaceApplication")
            .mockResolvedValue(result);
        const releaseSpy = vi
            .spyOn(workspaceResults, "releaseAgentWorkspaceAfterNoChanges")
            .mockResolvedValue();
        const child: ChildAgentHandle = {
            prompt: async () => {
                order.push("prompt");
            },
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "Finished", recentActivity: [] }),
            getFinalOutput: () => "Finished in isolation",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        const handlers = handlerView(stub, "session_start", "session_shutdown");
        const tool = agentTool(stub);
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            sessionManager: stubSessionManager({
                getSessionId: () => "parent-session",
                getSessionFile: () => undefined,
            }),
            ui: stubUi({ setWidget: () => {} }),
        });
        await handlers.session_start[0]({}, ctx);

        const completed = await tool.execute(
            "call-foreground",
            {
                action: "start",
                agent: "worker",
                task: "Inspect in isolation",
                isolation: "worktree",
            },
            undefined,
            undefined,
            ctx,
        );

        expect(order.indexOf("transfer")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("transfer")).toBeLessThan(order.indexOf("prompt"));
        expect(transferSpy).toHaveBeenCalledWith(workspace.id, {
            ownerSessionId: "parent-session",
            fromLeaseRunId: "provisional-foreground",
            toLeaseRunId: "worker-1",
            leaseKind: "task",
            fromLeaseRunInstanceId: "provisional-instance-foreground",
            toLeaseRunInstanceId: expect.any(String),
        });
        expect(prepareResultSpy).toHaveBeenCalledWith(workspace, {
            ownerSessionId: "parent-session",
            leaseRunId: "worker-1",
            leaseRunInstanceId: expect.any(String),
        });
        expect(releaseSpy).toHaveBeenCalledWith(workspace.id, {
            ownerSessionId: "parent-session",
            leaseRunId: "worker-1",
            leaseRunInstanceId: expect.any(String),
        });
        expect(completed.details.workspaceResult).toEqual(result);
        await expect(agentToolText(completed)).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.isolated-foreground.txt",
        );
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("automatically delivers a background completion once the parent is idle", async () => {
        const stub = createPiStub();
        const sentMessages = stub.sentMessages;
        let releasePrompt: (() => void) | undefined;
        const child: ChildAgentHandle = {
            prompt: () =>
                new Promise<void>((resolve) => {
                    releasePrompt = resolve;
                }),
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "Idle result", recentActivity: [] }),
            getFinalOutput: () => "Idle result",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        registerAgentTool(stub.pi, async () => child);
        const handlers = handlerView(stub, "session_shutdown");
        const tool = agentTool(stub);
        let idle = false;
        const ctx = stubContext({
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => idle,
            ui: stubUi({ setWidget: () => {} }),
        });

        await tool.execute(
            "call-1",
            { action: "start", agent: "scout", task: "Finish while idle", background: true },
            undefined,
            undefined,
            ctx,
        );
        for (let index = 0; index < 12 && !releasePrompt; index++) await Promise.resolve();
        expect(sentMessages).toEqual([]);
        idle = true;
        releasePrompt!();
        for (let index = 0; index < 12; index++) await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.options).toEqual({
            deliverAs: "followUp",
            triggerTurn: true,
        });
        await expect(sentMessages[0]?.message.content).toMatchFileSnapshot(
            "__snapshots__/agent-tool.agent.idle-mailbox-completion.txt",
        );
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("deduplicates discovery warning notifications for invalid overlays", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-tool-"));
        tempDirs.push(cwd);
        const agentsDir = path.join(cwd, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
            path.join(agentsDir, "reserved.md"),
            [
                "---",
                "name: scout",
                "description: Invalid capability override",
                "capabilities: [edit]",
                "---",
                "Instructions",
            ].join("\n"),
        );

        const stub = createPiStub();
        registerAgentTool(stub.pi, async () => {
            throw new Error("not used");
        });
        const handlers = handlerView(stub, "before_agent_start", "session_shutdown");
        const notifications: string[] = [];
        const ctx = stubContext({
            cwd,
            isProjectTrusted: () => true,
            isIdle: () => false,
            ui: stubUi({
                notify: (message) => {
                    notifications.push(message);
                },
                setWidget: () => {},
            }),
        });

        await handlers.before_agent_start[0]({ systemPrompt: "Parent" }, ctx);
        await handlers.before_agent_start[0]({ systemPrompt: "Parent" }, ctx);

        const invalidOverlayNotifications = notifications.filter((message) =>
            message.includes("capabilities cannot be overridden"),
        );
        expect(invalidOverlayNotifications).toHaveLength(1);
        const normalizedNotifications = invalidOverlayNotifications.map((message) =>
            message.replaceAll(cwd, "<fixture-cwd>"),
        );
        await expect(normalizedNotifications.join("\n")).toMatchFileSnapshot(
            "__snapshots__/agent-tool.tui.discovery-warning.txt",
        );
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("registers the temporarily always-enabled trace command", () => {
        const previous = process.env[AGENT_TRACE_ENV];
        const stub = createPiStub();
        const commandNames = () => stub.commands.map((command) => command.name);

        try {
            delete process.env[AGENT_TRACE_ENV];
            registerAgentTool(stub.pi, async () => {
                throw new Error("not used");
            });
            expect(commandNames()).toEqual(["agent-trace", "agents"]);
            expect(stub.requireCommand("agent-trace").description).toBe(
                "Inspect bounded sanitized traces for delegated agents",
            );

            process.env[AGENT_TRACE_ENV] = "0";
            registerAgentTool(stub.pi, async () => {
                throw new Error("not used");
            });
            expect(commandNames()).toEqual(["agent-trace", "agents", "agent-trace", "agents"]);
        } finally {
            if (previous === undefined) delete process.env[AGENT_TRACE_ENV];
            else process.env[AGENT_TRACE_ENV] = previous;
        }
    });
});
