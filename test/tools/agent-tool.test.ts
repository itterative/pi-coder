import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import { registerStatusWidget } from "../../src/tui/status";
import registerAgentTool, { clearCompletedWorkspaceSetupRun } from "../../src/tools/agent";
import { registerAgentTool as registerAgentToolDefinition } from "../../src/tools/agent/presentation/tool";
import { AGENT_EVENT_CHANNEL } from "../../src/tools/agent/observability/events";
import { ZERO_USAGE, type AgentRunSummary, type ChildAgentHandle } from "../../src/tools/agent/runs/manager";
import type {
    AgentWorkspace,
    AgentWorkspaceResult,
} from "../../src/tools/agent/contracts/workspaces";
import * as runCatalog from "../../src/tools/agent/storage/run-catalog";
import * as workspaceActions from "../../src/tools/agent/workspaces/actions";
import * as workspaceResults from "../../src/tools/agent/workspaces/results";
import * as workspaceFinalization from "../../src/tools/agent/workspaces/finalization";
import * as workspaceGit from "../../src/tools/agent/workspaces/git";
import * as workspaceSetup from "../../src/tools/agent/workspaces/setup";
import * as workspaceStore from "../../src/tools/agent/workspaces/store";
import { executeParentWorkspaceAction } from "../../src/tools/agent/workspaces/parent-actions";
import { AGENT_TRACE_ENV } from "../../src/tools/agent/observability/trace";
import { mockTheme, renderText, snapshotText } from "../helpers";

interface Handler {
    (event: any, ctx: any): Promise<unknown> | unknown;
}

const TEST_WORKER_DEFINITION = {
    name: "worker",
    source: "builtin",
    capabilities: ["edit"],
    description: "Test worker",
    systemPrompt: "Test worker prompt",
};

const tempDirs: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function revisionActionFixture() {
    const record = {
        ownerSessionId: "parent-session",
        runId: "worker-1",
        runInstanceId: "worker-instance-1",
        parentCwd: process.cwd(),
        title: "Implement fix",
        agent: "worker",
        agentSource: "builtin",
        definitionFingerprint: "definition-before-revise",
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
    const workspace = {
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
        latestResult: {
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
        },
        createdAt: 1,
        updatedAt: 2,
    };
    const definition = TEST_WORKER_DEFINITION;
    const continuationOutcome = {
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
        getPersistedRun: vi.fn(() => record),
        reserveRunIdentity: vi.fn(() => ({ runId: "worker-1", runInstanceId: "worker-instance-1" })),
        startContinuation: vi.fn(async () => continuationOutcome),
    };
    const ctx = {
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "parent-session" },
        ui: { notify: () => {} },
    };
    return {
        record,
        workspace,
        definition,
        continuationOutcome,
        manager,
        ctx,
        progress: vi.fn(),
        events: {} as any,
        discover: vi.fn(() => ({ agents: [definition], diagnostics: [] })),
    };
}

function configureRevisionAction(fixture: ReturnType<typeof revisionActionFixture>) {
    vi.spyOn(workspaceGit, "git").mockResolvedValue("worker-head");
    vi.spyOn(workspaceGit, "hasAncestor").mockResolvedValue(true);
    vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([fixture.record] as any);
    vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(fixture.workspace as any);
    return vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockResolvedValue();
}

async function executeRevisionAction(fixture: ReturnType<typeof revisionActionFixture>): Promise<unknown> {
    return executeParentWorkspaceAction(
        { action: "revise", runId: fixture.record.runId, guidance: "Apply feedback" },
        {
            ctx: fixture.ctx as any,
            manager: fixture.manager as any,
            signal: undefined,
            progress: fixture.progress,
            events: fixture.events,
            discover: fixture.discover,
        },
    );
}

describe("agent extension registration", () => {
    it("keeps setup status for non-completed task outcomes", () => {
        const setupRuns = new Map<string, AgentRunSummary>([
            ["setup-1", { workspaceId: "workspace-1" } as AgentRunSummary],
        ]);

        for (const status of ["failed", "canceled", "interrupted"] as const) {
            expect(clearCompletedWorkspaceSetupRun(setupRuns, {
                agent: "worker",
                status,
                workspaceId: "workspace-1",
            })).toBe(false);
            expect(setupRuns.has("setup-1")).toBe(true);
        }

        expect(clearCompletedWorkspaceSetupRun(setupRuns, {
            agent: "worker",
            status: "completed",
            workspaceId: "workspace-1",
        })).toBe(true);
        expect(setupRuns.has("setup-1")).toBe(false);
    });

    it("registers the tool, advertises agents, and marks failed results as errors", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const events: Array<{ channel: string; data: unknown }> = [];
        const pi = {
            events: {
                emit(channel: string, data: unknown) {
                    events.push({ channel, data });
                },
            },
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
        } as any;
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
        registerAgentTool(pi, async () => child);

        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            sessionManager: { getSessionFile: () => undefined },
            ui: { notify: () => {}, setWidget: () => {} },
        };
        await handlers.session_start[0]({ reason: "startup" }, ctx);
        const prompt = await handlers.before_agent_start[0]({ systemPrompt: "Parent prompt" }, ctx) as any;
        const result = await tool.execute(
            "call-1",
            { action: "start", agent: "scout", task: "Inspect" },
            undefined,
            undefined,
            ctx,
        );
        const errorHook = await handlers.tool_result[0]({
            toolName: "agent",
            details: { status: "failed" },
        }, ctx);

        expect(tool.name).toBe("agent");
        expect(tool.executionMode).toBe("sequential");
        await expect([
            tool.description,
            ...tool.promptGuidelines,
        ].join("\n")).toMatchFileSnapshot("__snapshots__/agent-tool.delegation-guidance.txt");
        await expect(prompt.systemPrompt).toMatchFileSnapshot("__snapshots__/agent-tool.parent-system-prompt.txt");
        const repeatedPrompt = await handlers.before_agent_start[0](prompt, ctx) as any;
        expect(repeatedPrompt).toEqual(prompt);
        expect(result.details).toMatchObject({ status: "completed", agent: "scout" });
        expect(events).toContainEqual({
            channel: AGENT_EVENT_CHANNEL,
            data: expect.objectContaining({ cwd: process.cwd(), type: "run", action: "created", runId: "scout-1" }),
        });
        expect(events).toContainEqual({
            channel: AGENT_EVENT_CHANNEL,
            data: expect.objectContaining({ type: "run", action: "status_changed", status: "running", runId: "scout-1" }),
        });
        expect(events).toContainEqual({
            channel: AGENT_EVENT_CHANNEL,
            data: expect.objectContaining({ type: "run", action: "removed", reason: "terminal", runId: "scout-1" }),
        });
        expect(errorHook).toEqual({ isError: true });
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("warns the parent when an agent ignores additional context", async () => {
        let tool: any;
        const handlers: Record<string, Handler[]> = {};
        const pi = {
            events: createEventBus(),
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
        } as any;
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
        registerAgentTool(pi, async () => child);

        const result = await tool.execute(
            "call-context-warning",
            {
                action: "start",
                agent: "scout",
                task: "Inspect",
                context: {
                    sections: [{ id: "parent_summary", title: "Summary", content: "Known", source: "parent" }],
                },
            },
            undefined,
            undefined,
            {
                cwd: process.cwd(),
                isProjectTrusted: () => false,
                sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => undefined },
                ui: { notify: () => {}, setWidget: () => {} },
            },
        );

        expect(result.details.status).toBe("completed");
        expect(result.content[0].text).toContain(
            'Warning: Agent "scout" does not accept additional context; ignored section: "parent_summary".',
        );
        expect(result.content[0].text).toContain("Done");
        await handlers.session_shutdown?.[0]?.({}, {});
    });

    it("renders the full prompt and preserves response whitespace without metadata", async () => {
        let tool: any;
        const prompt = "Review the implementation.\nPlease inspect the relevant modules and report any regressions.";
        const response = "\n  leading spaces\ntrailing spaces  \n";
        registerAgentToolDefinition({
            registerTool(definition: any) {
                tool = definition;
            },
        } as any, async () => ({
            content: response,
            details: {
                title: "Natural validation run",
                agent: "scout",
                status: "completed",
                task: prompt,
                response,
                toolCounts: { read: 2, grep: 1 },
                failedToolCalls: 1,
            },
            usage: ZERO_USAGE,
            isError: false,
        } as any));

        const result = await tool.execute(
            "call-render",
            { action: "start", agent: "scout", task: prompt },
            undefined,
            undefined,
            {} as any,
        );
        result.content[0].text = `<metadata>generated metadata</metadata>\n\n${response}`;
        const rendered = snapshotText(renderText(tool.renderResult(result, { expanded: true }, mockTheme), 10_000));

        await expect(rendered).toMatchFileSnapshot("__snapshots__/agent-tool.tui.markdown.txt");
    });

    it("applies a parent workspace result and verifies the lease is cleared", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const pi = {
            events: { emit() {} },
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
        } as any;
        const result = {
            id: "result-1",
            workspaceId: "workspace-1",
            runId: "worker-1",
            baseRevision: "base",
            workerHead: "worker",
            commitRange: "base..worker",
            commits: ["worker"],
            preparedAt: 1,
            status: "prepared",
        } as const;
        const workspace = {
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
        } as any;
        const releasedWorkspace = {
            ...workspace,
            status: "review_required",
            leaseOwnerSessionId: undefined,
            leaseRunId: undefined,
            leaseKind: undefined,
            latestResult: { ...result, status: "applied" },
        };
        vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([{
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
        }]);
        vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValueOnce(workspace);
        const executeWorkspaceAction = vi.spyOn(workspaceActions, "executeWorkspaceAction").mockResolvedValue({
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
        registerAgentTool(pi, async () => { throw new Error("not used"); });

        const outcome = await tool.execute(
            "call-apply",
            { action: "apply", runId: "worker-1" },
            undefined,
            undefined,
            {
                cwd: process.cwd(),
                sessionManager: { getSessionId: () => "parent-1" },
                ui: { notify() {}, setWidget() {} },
            },
        );

        expect(executeWorkspaceAction).toHaveBeenCalledWith({
            action: "apply",
            workspace,
            ownerSessionId: "parent-1",
            runId: "worker-1",
        });
        expect(outcome.details.workspaceResult).toMatchObject({ status: "applied" });
        expect(releasedWorkspace.leaseRunId).toBeUndefined();
    });

    it("renders and executes a complete start, wait, resume flow", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
        } as any;
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
                    output = "Implementation A is preferred because it preserves the existing contract.";
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
        registerAgentTool(pi, async () => child);
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            ui: { notify: () => {}, setWidget: () => {} },
        };

        const waiting = await tool.execute(
            "call-1",
            { action: "start", agent: "scout", task: "Compare implementations" },
            undefined,
            undefined,
            ctx,
        );
        const waitingText = snapshotText(renderText(
            tool.renderResult(waiting, { expanded: false }, mockTheme),
            120,
        ));
        expect(waiting.details.status).toBe("waiting_for_parent");
        await expect(waiting.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.foreground-waiting.txt");
        await expect(waitingText).toMatchFileSnapshot("__snapshots__/agent-tool.tui.foreground-waiting.txt");

        const completed = await tool.execute(
            "call-2",
            { action: "resume", runId: "scout-1", guidance: "Yes, compare both." },
            undefined,
            undefined,
            ctx,
        );
        const completedText = snapshotText(renderText(
            tool.renderResult(completed, { expanded: true }, mockTheme),
            120,
        ));
        expect(completed.details.status).toBe("completed");
        await expect(completed.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.foreground-completed.txt");
        await expect(completedText).toMatchFileSnapshot("__snapshots__/agent-tool.tui.foreground-completed.txt");
        expect(promptCount).toBe(2);
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("executes a spawn, status, and collect flow", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const sentMessages: Array<{ message: any; options: any }> = [];
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
            events: createEventBus(),
            sendMessage(message: any, options: any) {
                sentMessages.push({ message, options });
            },
        } as any;
        let background = false;
        let reportProgress: ((progress: { output: string; recentActivity: string[] }) => void) | undefined;
        let childProgress = { output: "", recentActivity: [] as string[] };
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
        registerAgentTool(pi, async (context) => {
            background = context.background === true;
            reportProgress = context.onProgress;
            return child;
        });
        const widgets: Array<string[] | undefined> = [];
        const widgetPlacements: Array<string | undefined> = [];
        let widgetComponent: { render(width: number): string[] } | undefined;
        const widgetTui = {
            requestRender() {
                if (widgetComponent) widgets.push(widgetComponent.render(200));
            },
        };
        const ctx = {
            cwd: process.cwd(),
            mode: "tui",
            hasUI: true,
            isProjectTrusted: () => false,
            isIdle: () => false,
            ui: {
                notify: () => {},
                setWidget: (
                    _id: string,
                    value: string[] | ((tui: typeof widgetTui, theme: unknown) => { render(width: number): string[] }) | undefined,
                    options?: { placement?: string },
                ) => {
                    if (typeof value === "function") {
                        widgetComponent = value(widgetTui, {});
                        widgets.push(widgetComponent.render(200));
                    } else {
                        widgetComponent = undefined;
                        widgets.push(value);
                    }
                    if (value) widgetPlacements.push(options?.placement);
                },
            },
        };
        registerStatusWidget(pi);
        await handlers.session_start.at(-1)?.({}, ctx);

        const spawned = await tool.execute(
            "call-1",
            { action: "spawn", agent: "scout", task: "Inspect concurrently" },
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
        const prompt = await handlers.before_agent_start[0](
            { systemPrompt: "Parent prompt" },
            ctx,
        ) as any;
        expect(sentMessages).toEqual([]);
        await handlers.agent_settled[0]({}, { ...ctx, isIdle: () => true });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
        expect(sentMessages[0]?.message).toMatchObject({
            customType: "pi-coder-agent-mailbox",
            display: false,
        });
        await expect(sentMessages[0]?.message.content).toMatchFileSnapshot("__snapshots__/agent-tool.agent.background-mailbox-completion.txt");
        const listWorkspaces = vi.spyOn(workspaceStore, "listAgentWorkspaces").mockResolvedValue([]);
        const listed = await tool.execute(
            "call-list",
            { action: "list" },
            undefined,
            undefined,
            ctx,
        );
        expect(listWorkspaces).toHaveBeenCalledWith(process.cwd(), { includeMissingWorktrees: true });
        const collected = await tool.execute(
            "call-3",
            { action: "collect", runId: "scout-1" },
            undefined,
            undefined,
            ctx,
        );

        expect(spawned.details).toMatchObject({ status: "starting", background: true });
        await expect(spawned.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.background-spawn.txt");
        expect(status.details.status).toBe("completed");
        await expect(status.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.background-status.txt");
        const promptAfterSpawn = await handlers.before_agent_start[0]({ systemPrompt: "Parent prompt" }, ctx) as any;
        expect(promptAfterSpawn).toEqual(prompt);
        await expect(listed.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.background-list.txt");
        expect(collected.details.status).toBe("completed");
        await expect(collected.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.background-collect.txt");
        const widgetLines = widgets.flatMap((lines) => lines ?? []).map((line) => line.trimEnd());
        await expect(widgetLines.join("\n")).toMatchFileSnapshot("__snapshots__/agent-tool.tui.background-widget.txt");
        expect(widgets[widgets.length - 1]).toBeUndefined();
        expect(widgetPlacements).toContain("aboveEditor");
        expect(background).toBe(true);
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("prepares an isolated result before collecting it in the parent", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
            sendMessage() {},
        } as any;
        const workspace = {
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
        } as AgentWorkspace;
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
        const transferSpy = vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockResolvedValue();
        const getWorkspaceSpy = vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(workspace);
        const prepareResultSpy = vi.spyOn(workspaceResults, "prepareAgentWorkspaceApplication").mockResolvedValue(result);
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
        registerAgentTool(pi, async () => child);
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            sessionManager: {
                getSessionId: () => "parent-session",
                getSessionFile: () => undefined,
            },
            ui: { notify: () => {}, setWidget: () => {} },
        };
        await handlers.session_start[0]({}, ctx);
        await tool.execute(
            "call-1",
            { action: "spawn", agent: "worker", task: "Implement in isolation", isolation: "worktree" },
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
        expect(transferSpy).toHaveBeenCalledWith(
            workspace.id,
            {
                ownerSessionId: "parent-session",
                fromLeaseRunId: "provisional-1",
                toLeaseRunId: "worker-1",
                leaseKind: "task",
                fromLeaseRunInstanceId: "provisional-instance-1",
                toLeaseRunInstanceId: expect.any(String),
            },
        );
        expect(getWorkspaceSpy).toHaveBeenCalledWith(workspace.id);
        expect(prepareResultSpy).toHaveBeenCalledWith(workspace, {
            ownerSessionId: "parent-session",
            leaseRunId: "worker-1",
            leaseRunInstanceId: expect.any(String),
        });
        expect(collected.details.workspaceResult).toEqual(result);
        await expect(collected.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.isolated-collect.txt");
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("revises an isolated result by continuing its persisted child session", async () => {
        const childSessionFile = "/tmp/agent-child.jsonl";
        const record = {
            ownerSessionId: "parent-session",
            runId: "worker-1",
            runInstanceId: "worker-instance-1",
            parentCwd: process.cwd(),
            title: "Implement fix",
            agent: "worker",
            agentSource: "builtin",
            definitionFingerprint: "definition-before-revise",
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
        const workspace = {
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
            latestResult: {
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
            },
            createdAt: 1,
            updatedAt: 2,
        };
        const definition = {
            ...TEST_WORKER_DEFINITION,
            systemPrompt: "Current definition changed",
        };
        const continuationOutcome = {
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
            getPersistedRun: vi.fn(() => record),
            reserveRunIdentity: vi.fn(() => ({ runId: "worker-1", runInstanceId: "worker-instance-1" })),
            startContinuation: vi.fn(async () => continuationOutcome),
        };
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => true,
            sessionManager: { getSessionId: () => "parent-session" },
            ui: { notify: () => {} },
        };
        const progress = vi.fn();
        const events = {} as any;
        const discover = vi.fn(() => ({ agents: [definition], diagnostics: [] }));
        vi.spyOn(workspaceGit, "git").mockResolvedValue("worker-head");
        vi.spyOn(workspaceGit, "hasAncestor").mockResolvedValue(true);
        vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([record] as any);
        vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(workspace as any);
        const transferSpy = vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockResolvedValue();
        vi.spyOn(workspaceFinalization, "prepareForegroundWorkspaceResult").mockResolvedValue(continuationOutcome as any);

        const result = await executeParentWorkspaceAction(
            { action: "revise", runId: "worker-1", guidance: "Apply feedback" },
            {
                ctx: ctx as any,
                manager: manager as any,
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
            {
                signal: undefined,
                onProgress: progress,
                title: "Implement fix revision",
                identity: { runId: "worker-1", runInstanceId: "worker-instance-1" },
            },
        );
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("revises a collected reviewer result by continuing its persisted child session", async () => {
        const childSessionFile = "/tmp/reviewer-child.jsonl";
        const definition = {
            name: "reviewer",
            source: "builtin",
            capabilities: ["read", "search", "memories", "scratchpad", "safe-bash", "command-runner"],
            description: "Code and Git-history review with validation",
            systemPrompt: "Reviewer prompt",
        };
        const record = {
            ownerSessionId: "parent-session",
            runId: "reviewer-1",
            runInstanceId: "reviewer-instance-1",
            parentCwd: process.cwd(),
            executionCwd: process.cwd(),
            title: "Review changes",
            agent: "reviewer",
            agentSource: "builtin",
            definitionFingerprint: "reviewer-definition",
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
        const continuationOutcome = {
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
            getPersistedRun: vi.fn(() => record),
            reserveRunIdentity: vi.fn(() => ({ runId: "reviewer-1", runInstanceId: "reviewer-instance-1" })),
            startContinuation: vi.fn(async () => continuationOutcome),
        };
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => true,
            sessionManager: { getSessionId: () => "parent-session" },
            ui: { notify: () => {} },
        };
        const progress = vi.fn();
        const discover = vi.fn(() => ({ agents: [definition], diagnostics: [] }));
        vi.spyOn(runCatalog, "listAgentRunCatalog").mockResolvedValue([record] as any);

        const result = await executeParentWorkspaceAction(
            { action: "revise", runId: "reviewer-1", guidance: "Please re-check the API compatibility findings." },
            {
                ctx: ctx as any,
                manager: manager as any,
                signal: undefined,
                progress,
                events: {} as any,
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
                title: "Review changes revision",
                identity: { runId: "reviewer-1", runInstanceId: "reviewer-instance-1" }
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
        const secondOutcome = {
            ...continuationOutcome,
            content: "The second review continuation completed.",
            details: {
                ...continuationOutcome.details,
                runInstanceId: "reviewer-instance-1",
                updatedAt: 7,
            },
        };
        manager.getPersistedRun.mockReturnValue(continuedRecord);
        manager.reserveRunIdentity.mockReturnValue({ runId: "reviewer-1", runInstanceId: "reviewer-instance-1" });
        manager.startContinuation.mockResolvedValue(secondOutcome);

        const secondResult = await executeParentWorkspaceAction(
            { action: "revise", runId: "reviewer-1", guidance: "Follow up on the remaining concern." },
            {
                ctx: ctx as any,
                manager: manager as any,
                signal: undefined,
                progress,
                events: {} as any,
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
                title: "Review changes revision",
                identity: { runId: "reviewer-1", runInstanceId: "reviewer-instance-1" }
            }),
        );
    });

    it("does not fall back to catalog-only runs when branch persistence is active", async () => {
        const fixture = revisionActionFixture();
        configureRevisionAction(fixture);
        fixture.manager.getPersistedRun.mockReturnValue(undefined as any);
        (fixture.manager as any).hasPersistence = true;

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
            "is not based on workspace base base-revision",
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
            "has no persisted agent definition snapshot; it cannot be revised",
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
        vi.spyOn(workspaceFinalization, "prepareForegroundWorkspaceResult").mockRejectedValue(finalizationError);

        await expect(executeRevisionAction(fixture)).rejects.toBe(finalizationError);
        expect(transferSpy).not.toHaveBeenCalled();
    });

    it("prepares and releases a no-change isolated foreground result", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
        } as any;
        const workspace = {
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
        } as AgentWorkspace;
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
        const transferSpy = vi.spyOn(workspaceStore, "transferAgentWorkspaceLease").mockImplementation(async () => {
            order.push("transfer");
        });
        vi.spyOn(workspaceStore, "getAgentWorkspace").mockResolvedValue(workspace);
        const prepareResultSpy = vi.spyOn(workspaceResults, "prepareAgentWorkspaceApplication").mockResolvedValue(result);
        const releaseSpy = vi.spyOn(workspaceResults, "releaseAgentWorkspaceAfterNoChanges").mockResolvedValue();
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
        registerAgentTool(pi, async () => child);
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            sessionManager: {
                getSessionId: () => "parent-session",
                getSessionFile: () => undefined,
            },
            ui: { notify: () => {}, setWidget: () => {} },
        };
        await handlers.session_start[0]({}, ctx);

        const completed = await tool.execute(
            "call-foreground",
            { action: "start", agent: "worker", task: "Inspect in isolation", isolation: "worktree" },
            undefined,
            undefined,
            ctx,
        );

        expect(order.indexOf("transfer")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("transfer")).toBeLessThan(order.indexOf("prompt"));
        expect(transferSpy).toHaveBeenCalledWith(
            workspace.id,
            {
                ownerSessionId: "parent-session",
                fromLeaseRunId: "provisional-foreground",
                toLeaseRunId: "worker-1",
                leaseKind: "task",
                fromLeaseRunInstanceId: "provisional-instance-foreground",
                toLeaseRunInstanceId: expect.any(String),
            },
        );
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
        await expect(completed.content[0].text).toMatchFileSnapshot("__snapshots__/agent-tool.agent.isolated-foreground.txt");
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("automatically delivers a background completion once the parent is idle", async () => {
        const handlers: Record<string, Handler[]> = {};
        let tool: any;
        const sentMessages: Array<{ message: any; options: any }> = [];
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
            sendMessage(message: any, options: any) {
                sentMessages.push({ message, options });
            },
        } as any;
        let releasePrompt: (() => void) | undefined;
        const child: ChildAgentHandle = {
            prompt: () => new Promise<void>((resolve) => {
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
        registerAgentTool(pi, async () => child);
        let idle = false;
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => idle,
            ui: { notify: () => {}, setWidget: () => {} },
        };

        await tool.execute(
            "call-1",
            { action: "spawn", agent: "scout", task: "Finish while idle" },
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
        await expect(sentMessages[0]?.message.content).toMatchFileSnapshot("__snapshots__/agent-tool.agent.idle-mailbox-completion.txt");
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("deduplicates discovery warning notifications for invalid overlays", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-tool-"));
        tempDirs.push(cwd);
        const agentsDir = path.join(cwd, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, "reserved.md"), [
            "---",
            "name: scout",
            "description: Invalid capability override",
            "capabilities: [edit]",
            "---",
            "Instructions",
        ].join("\n"));

        const handlers: Record<string, Handler[]> = {};
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool() {},
            registerCommand() {},
        } as any;
        registerAgentTool(pi, async () => { throw new Error("not used"); });
        const notifications: string[] = [];
        const ctx = {
            cwd,
            isProjectTrusted: () => true,
            ui: {
                notify: (message: string) => notifications.push(message),
                setWidget: () => {},
            },
        };

        await handlers.before_agent_start[0]({ systemPrompt: "Parent" }, ctx);
        await handlers.before_agent_start[0]({ systemPrompt: "Parent" }, ctx);

        const invalidOverlayNotifications = notifications.filter((message) => message.includes("capabilities cannot be overridden"));
        expect(invalidOverlayNotifications).toHaveLength(1);
        const normalizedNotifications = invalidOverlayNotifications.map((message) => message.replaceAll(cwd, "<fixture-cwd>"));
        await expect(normalizedNotifications.join("\n")).toMatchFileSnapshot("__snapshots__/agent-tool.tui.discovery-warning.txt");
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("registers the temporarily always-enabled trace command", () => {
        const previous = process.env[AGENT_TRACE_ENV];
        const commands: string[] = [];
        const pi = {
            on() {},
            registerTool() {},
            registerCommand(name: string) {
                commands.push(name);
            },
        } as any;

        try {
            delete process.env[AGENT_TRACE_ENV];
            registerAgentTool(pi, async () => { throw new Error("not used"); });
            expect(commands).toEqual(["agent-trace", "agents"]);

            process.env[AGENT_TRACE_ENV] = "0";
            registerAgentTool(pi, async () => { throw new Error("not used"); });
            expect(commands).toEqual([
                "agent-trace", "agents",
                "agent-trace", "agents",
            ]);
        } finally {
            if (previous === undefined) delete process.env[AGENT_TRACE_ENV];
            else process.env[AGENT_TRACE_ENV] = previous;
        }
    });
});
