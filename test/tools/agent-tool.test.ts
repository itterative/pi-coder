import { describe, expect, it } from "vitest";

import registerAgentTool from "../../src/tools/agent";
import { ZERO_USAGE, type ChildAgentHandle } from "../../src/tools/agent/runtime";

interface Handler {
    (event: any, ctx: any): Promise<unknown> | unknown;
}

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
});
