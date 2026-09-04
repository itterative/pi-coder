import { describe, expect, it } from "vitest";
import {
    snapshotProgress,
    updateTracker,
    type ChildProgressTracker,
} from "../../src/tools/agent/child/progress";

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
    /**
     * `snapshotProgress` now feeds three callers: the parent's progress callback, the permission
     * frame, and the handle's `getProgress`. A dropped field therefore disappears quietly from
     * `runs/child-setup.ts`, which derives `waiting_for_permission` from `permissionPending`, so the
     * frame shape is asserted here rather than inferred from a render.
     */
    it("projects every progress field the parent reads from a frame", () => {
        const state = tracker();
        state.progress = {
            output: "working",
            lastAssistantMessage: "almost done",
            recentActivity: ["Reading src/a.ts"],
            phase: "running tools",
            lastToolActivity: "Reading src/a.ts",
            toolCounts: { read: 2 },
            failedToolCalls: 1,
            permissionPending: true,
            todo: { completed: 1, total: 3, current: "Wire it up" },
        };

        expect(snapshotProgress(state)).toStrictEqual({
            output: "working",
            lastAssistantMessage: "almost done",
            recentActivity: ["Reading src/a.ts"],
            phase: "running tools",
            lastToolActivity: "Reading src/a.ts",
            toolCounts: { read: 2 },
            failedToolCalls: 1,
            permissionPending: true,
            todo: { completed: 1, total: 3, current: "Wire it up" },
        });
    });

    /** Display state that is absent or empty stays absent, so consumers do not render placeholders. */
    it("omits optional progress fields that carry nothing", () => {
        expect(snapshotProgress(tracker())).toStrictEqual({
            output: "",
            recentActivity: [],
            toolCounts: {},
            permissionPending: undefined,
        });
    });

    it("tracks reasoning without exposing thinking content", () => {
        const state = tracker();
        const updates: unknown[] = [];

        updateTracker(
            {
                type: "message_start",
                message: { role: "assistant", content: [] },
            } as any,
            state,
            (progress) => updates.push(progress),
        );
        updateTracker(
            {
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
            } as any,
            state,
            (progress) => updates.push(progress),
        );

        expect(state.progress.phase).toBe("Thinking");
        expect(state.progress.output).toBe("");
        expect(state.progress.recentActivity).toEqual(["Thinking"]);
        expect(updates.at(-1)).not.toMatchObject({ output: "private reasoning" });
    });

    it("counts tool calls and preserves the last assistant response", () => {
        const state = tracker();
        updateTracker(
            {
                type: "message_start",
                message: { role: "assistant", content: [] },
            } as any,
            state,
            () => {},
        );
        updateTracker(
            {
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "I will inspect this.\nMore detail.",
                },
            } as any,
            state,
            () => {},
        );
        updateTracker(
            {
                type: "tool_execution_start",
                toolName: "read",
                args: { path: "src/index.ts" },
            } as any,
            state,
            () => {},
        );
        updateTracker(
            {
                type: "tool_execution_start",
                toolName: "grep",
                args: { path: "src", pattern: "widget" },
            } as any,
            state,
            () => {},
        );

        updateTracker(
            {
                type: "tool_execution_end",
                toolName: "read",
                isError: true,
            } as any,
            state,
            () => {},
        );

        expect(state.progress.output).toBe("I will inspect this.\nMore detail.");
        expect(state.progress.toolCounts).toEqual({ read: 1, grep: 1 });
        expect(state.progress.failedToolCalls).toBe(1);
        expect(state.progress.lastToolActivity).toBe('Searching "widget" in src');
    });
});
