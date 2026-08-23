import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import registerAgentTool from "../../src/tools/agent";
import { ZERO_USAGE, type ChildAgentHandle } from "../../src/tools/agent/runtime";
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
            ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
        };
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
        expect(prompt.systemPrompt).toContain("scout (builtin)");
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
            ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
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
        const pi = {
            on(event: string, handler: Handler) {
                (handlers[event] ??= []).push(handler);
            },
            registerTool(definition: any) {
                tool = definition;
            },
            registerCommand() {},
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
        const statuses: Array<string | undefined> = [];
        const widgets: Array<string[] | undefined> = [];
        const ctx = {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
            ui: {
                notify: () => {},
                setStatus: (_id: string, value: string | undefined) => statuses.push(value),
                setWidget: (_id: string, value: string[] | undefined) => widgets.push(value),
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
        const collected = await tool.execute(
            "call-3",
            { action: "collect", runId: "scout-1" },
            undefined,
            undefined,
            ctx,
        );

        expect(spawned.details).toMatchObject({ status: "starting", background: true });
        expect(status.details.status).toBe("completed");
        expect(status.content[0].text).toContain("action=\"collect\"");
        expect(prompt.systemPrompt).toContain("scout-1 (scout): completed");
        expect(collected.details.status).toBe("completed");
        expect(collected.content[0].text).toBe("Background result");
        expect(statuses).toContain("● scout-1");
        expect(statuses).toContain("✓ scout-1 ready");
        expect(statuses[statuses.length - 1]).toBeUndefined();
        const widgetLines = widgets.flatMap((lines) => lines ?? []);
        expect(widgetLines).toContain(
            "● scout-1 — Reading src/tools/agent/runtime.ts · “Inspecting the run manager lifecycle.”",
        );
        expect(widgetLines).toContain(
            "✓ scout-1 — Ready to collect · “Inspecting the run manager lifecycle.”",
        );
        expect(widgets[widgets.length - 1]).toBeUndefined();
        expect(background).toBe(true);
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
                setStatus: () => {},
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
            expect(commands).toEqual(["agent-trace"]);

            process.env[AGENT_TRACE_ENV] = "0";
            registerAgentTool(pi, async () => { throw new Error("not used"); });
            expect(commands).toEqual(["agent-trace", "agent-trace"]);
        } finally {
            if (previous === undefined) delete process.env[AGENT_TRACE_ENV];
            else process.env[AGENT_TRACE_ENV] = previous;
        }
    });
});
