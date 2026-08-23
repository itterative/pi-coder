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
            ui: { notify: () => {} },
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
            ui: { notify: () => {} },
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
            ui: { notify: (message: string) => notifications.push(message) },
        };

        await handlers.before_agent_start[0]({ systemPrompt: "Parent" }, ctx);
        await handlers.before_agent_start[0]({ systemPrompt: "Parent" }, ctx);

        expect(notifications.filter((message) => message.includes("reserved"))).toHaveLength(1);
        await handlers.session_shutdown[0]({}, ctx);
    });

    it("registers the trace command only when its environment flag is enabled", () => {
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
            expect(commands).toEqual([]);

            process.env[AGENT_TRACE_ENV] = "1";
            registerAgentTool(pi, async () => { throw new Error("not used"); });
            expect(commands).toEqual(["agent-trace"]);
        } finally {
            if (previous === undefined) delete process.env[AGENT_TRACE_ENV];
            else process.env[AGENT_TRACE_ENV] = previous;
        }
    });
});
