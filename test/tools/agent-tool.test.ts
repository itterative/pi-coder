import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import registerAgentTool, { clearCompletedWorkspaceSetupRun } from "../../src/tools/agent";
import { ZERO_USAGE, type AgentRunSummary, type ChildAgentHandle } from "../../src/tools/agent/runtime";
import { AGENT_TRACE_ENV } from "../../src/tools/agent/trace";
import { mockTheme, renderText } from "../helpers";

interface Handler {
    (event: any, ctx: any): Promise<unknown> | unknown;
}

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
        const pi = {
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
        expect(prompt.systemPrompt).toContain("<delegated_agents>");
        expect(prompt.systemPrompt).toContain("scout (builtin)");
        expect(prompt.systemPrompt).toContain("worker (builtin): [mutation-capable]");
        const repeatedPrompt = await handlers.before_agent_start[0](prompt, ctx) as any;
        expect(repeatedPrompt.systemPrompt.match(/<delegated_agents>/g)).toHaveLength(1);
        expect(result.details).toMatchObject({ status: "completed", agent: "scout" });
        expect(errorHook).toEqual({ isError: true });
        await handlers.session_shutdown[0]({}, ctx);
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
            getProgress: () => ({ output, recentActivity: [] }),
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
        const waitingText = renderText(
            tool.renderResult(waiting, { expanded: false }, mockTheme),
            120,
        );
        expect(waiting.details.status).toBe("waiting_for_parent");
        expect(waitingText).toContain("Question: Should I compare both implementations?");
        expect(waitingText).toContain("Resume required: scout-1");

        const completed = await tool.execute(
            "call-2",
            { action: "resume", runId: "scout-1", guidance: "Yes, compare both." },
            undefined,
            undefined,
            ctx,
        );
        const completedText = renderText(
            tool.renderResult(completed, { expanded: false }, mockTheme),
            120,
        );
        expect(completed.details.status).toBe("completed");
        expect(completedText).toContain("Result: Implementation A is preferred");
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
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            isIdle: () => false,
            ui: {
                notify: () => {},
                setWidget: (
                    _id: string,
                    value: string[] | undefined,
                    options?: { placement?: string },
                ) => {
                    widgets.push(value);
                    if (value) widgetPlacements.push(options?.placement);
                },
            },
        };

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
        expect(sentMessages[0]?.message.content).toContain('Run ID: "scout-1"');
        expect(sentMessages[0]?.message.content).toContain("Status: completed");
        expect(sentMessages[0]?.message.content).toContain("This is not a new user request");
        const listed = await tool.execute(
            "call-list",
            { action: "list" },
            undefined,
            undefined,
            ctx,
        );
        const collected = await tool.execute(
            "call-3",
            { action: "collect", runId: "scout-1" },
            undefined,
            undefined,
            ctx,
        );

        expect(spawned.details).toMatchObject({ status: "starting", background: true });
        expect(spawned.content[0].text).toContain("Do not poll its status");
        expect(spawned.content[0].text).toContain("automatic notification");
        expect(status.details.status).toBe("completed");
        expect(status.content[0].text).toContain("action=\"collect\"");
        const promptAfterSpawn = await handlers.before_agent_start[0]({ systemPrompt: "Parent prompt" }, ctx) as any;
        expect(promptAfterSpawn.systemPrompt).not.toContain("scout-1");
        expect(promptAfterSpawn.systemPrompt).not.toContain("Tracked background runs");
        expect(listed.content[0].text).toContain('"scout-1"');
        expect(listed.content[0].text).toContain('"Inspect concurrently"');
        expect(collected.details.status).toBe("completed");
        expect(collected.content[0].text).toBe("Background result");
        const widgetLines = widgets.flatMap((lines) => lines ?? []);
        expect(widgetLines).toContain(
            "● scout-1 — Reading src/tools/agent/runtime.ts · “Inspecting the run manager lifecycle.”",
        );
        expect(widgetLines).toContain(
            "✓ scout-1 — Ready to collect · “Inspecting the run manager lifecycle.”",
        );
        expect(widgets[widgets.length - 1]).toBeUndefined();
        expect(widgetPlacements).toContain("aboveEditor");
        expect(background).toBe(true);
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
        expect(sentMessages[0]?.message.content).toContain("Status: completed");
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("deduplicates discovery warning notifications", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-agent-tool-"));
        tempDirs.push(cwd);
        const agentsDir = path.join(cwd, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, "reserved.md"), [
            "---",
            "name: scout",
            "description: Invalid reserved override",
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

        expect(notifications.filter((message) => message.includes("reserved"))).toHaveLength(1);
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
