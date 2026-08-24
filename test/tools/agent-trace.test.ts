import { describe, expect, it } from "vitest";

import {
    AgentRunManager,
    ZERO_USAGE,
    type ChildAgentHandle,
} from "../../src/tools/agent/runs/manager";
import {
    AgentTraceStore,
    isAgentTraceEnabled,
    registerAgentTraceCommand,
} from "../../src/tools/agent/observability/trace";

describe("delegated-agent traces", () => {
    it("retains bounded terminal traces and bounded event timelines", () => {
        const store = new AgentTraceStore(2, 3);
        for (let run = 1; run <= 3; run++) {
            const runId = `scout-${run}`;
            store.start(runId, "scout");
            store.record(runId, "one");
            store.record(runId, "two");
            store.record(runId, "three");
            store.finish(runId, "completed");
        }

        expect(store.list().map((trace) => trace.runId)).toEqual(["scout-3", "scout-2"]);
        expect(store.get("scout-1")).toBeUndefined();
        expect(store.get("scout-3")).toMatchObject({
            terminalStatus: "completed",
            droppedEvents: 2,
        });
        expect(store.get("scout-3")?.events).toHaveLength(3);
    });

    it("captures the event sequence for an empty final response", async () => {
        const store = new AgentTraceStore();
        const child: ChildAgentHandle = {
            prompt: async () => {},
            abort: async () => {},
            dispose: () => {},
            takeParentQuestion: () => undefined,
            getProgress: () => ({ output: "", recentActivity: ["Using ask_user"] }),
            getFinalOutput: () => "",
            getError: () => undefined,
            getUsage: () => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }),
        };
        const manager = new AgentRunManager(async (context) => {
            context.onTrace?.("session.agent_start");
            context.onTrace?.("session.tool_end", {
                tool: "ask_user",
                isError: false,
                resultChars: 20,
            });
            context.onTrace?.("session.agent_settled");
            return child;
        }, 4, store);

        const result = await manager.start(
            "scout",
            "Investigate",
            { cwd: process.cwd(), parentContext: {} },
        );
        const trace = store.get("scout-1");
        const eventTypes = trace?.events.map((event) => event.type);

        expect(result.details.status).toBe("failed");
        expect(result.content).toContain("/agent-trace scout-1");
        expect(trace?.terminalStatus).toBe("failed");
        expect(eventTypes).toContain("child.session.tool_end");
        expect(eventTypes).toContain("operation.prompt_settled");
        expect(eventTypes).toContain("final_output.empty");
        expect(eventTypes?.slice(-1)[0]).toBe("run.terminal");
    });

    it("renders traces through the command in non-UI mode", async () => {
        const store = new AgentTraceStore();
        store.start("scout-1", "scout");
        store.record("scout-1", "session.agent_settled");
        store.finish("scout-1", "completed");
        let command: any;
        registerAgentTraceCommand({
            registerCommand(_name: string, definition: any) {
                command = definition;
            },
        } as any, store);
        const notifications: string[] = [];
        const ctx = {
            hasUI: false,
            ui: { notify: (message: string) => notifications.push(message) },
        } as any;

        await command.handler("scout-1", ctx);

        expect(notifications.join("\n")).toContain("session.agent_settled");
        expect(notifications.join("\n")).toContain("run.terminal");
    });

    it("is temporarily enabled regardless of the environment flag", () => {
        expect(isAgentTraceEnabled("1")).toBe(true);
        expect(isAgentTraceEnabled("0")).toBe(true);
        expect(isAgentTraceEnabled(undefined)).toBe(true);
    });
});
