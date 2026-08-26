import { describe, expect, it } from "vitest";
import { updateTracker, type ChildProgressTracker } from "../../src/tools/agent/child/progress";

function tracker(): ChildProgressTracker {
    return {
        progress: { output: "", recentActivity: [], toolCounts: {} },
        lastUpdateAt: 0,
        changedFiles: new Set(),
        readFiles: new Set(),
        bashApproved: false,
        interrupted: false,
    };
}

describe("child progress", () => {
    it("tracks reasoning without exposing thinking content", () => {
        const state = tracker();
        const updates: unknown[] = [];

        updateTracker({
            type: "message_start",
            message: { role: "assistant", content: [] },
        } as any, state, (progress) => updates.push(progress));
        updateTracker({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
        } as any, state, (progress) => updates.push(progress));

        expect(state.progress.phase).toBe("Thinking");
        expect(state.progress.output).toBe("");
        expect(state.progress.recentActivity).toEqual(["Thinking"]);
        expect(updates.at(-1)).not.toMatchObject({ output: "private reasoning" });
    });

    it("counts tool calls and preserves the last assistant response", () => {
        const state = tracker();
        updateTracker({
            type: "message_start",
            message: { role: "assistant", content: [] },
        } as any, state, () => {});
        updateTracker({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "I will inspect this.\nMore detail." },
        } as any, state, () => {});
        updateTracker({
            type: "tool_execution_start",
            toolName: "read",
            args: { path: "src/index.ts" },
        } as any, state, () => {});
        updateTracker({
            type: "tool_execution_start",
            toolName: "grep",
            args: { path: "src", pattern: "widget" },
        } as any, state, () => {});

        updateTracker({
            type: "tool_execution_end",
            toolName: "read",
            isError: true,
        } as any, state, () => {});

        expect(state.progress.output).toBe("I will inspect this.\nMore detail.");
        expect(state.progress.toolCounts).toEqual({ read: 1, grep: 1 });
        expect(state.progress.failedToolCalls).toBe(1);
        expect(state.progress.lastToolActivity).toBe('Searching "widget" in src');
    });
});
