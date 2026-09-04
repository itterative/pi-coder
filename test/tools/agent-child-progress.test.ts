import { describe, expect, it } from "vitest";
import { snapshotProgress, updateTracker } from "../../src/tools/agent/child/progress";

import { partialTracker } from "../helpers/agent-doubles";
import {
    messageStartEvent,
    textDeltaEvent,
    thinkingDeltaEvent,
    toolExecutionEndEvent,
    toolExecutionStartEvent,
} from "../helpers/session-events";

describe("child progress", () => {
    /**
     * `snapshotProgress` now feeds three callers: the parent's progress callback, the permission
     * frame, and the handle's `getProgress`. A dropped field therefore disappears quietly from
     * `runs/child-setup.ts`, which derives `waiting_for_permission` from `permissionPending`, so the
     * frame shape is asserted here rather than inferred from a render.
     */
    it("projects every progress field the parent reads from a frame", () => {
        const state = partialTracker();
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
        // The empty `toolCounts` map is the one field this frame carries by hand: `snapshotProgress` drops
        // the key entirely when the tracker has none, so the assertion below pins the seeded-child shape.
        const state = partialTracker({
            progress: { output: "", recentActivity: [], toolCounts: {} },
        });

        expect(snapshotProgress(state)).toStrictEqual({
            output: "",
            recentActivity: [],
            toolCounts: {},
            permissionPending: undefined,
        });
    });

    it("tracks reasoning without exposing thinking content", () => {
        const state = partialTracker();
        const updates: unknown[] = [];

        updateTracker(messageStartEvent(), state, (progress) => updates.push(progress));
        updateTracker(thinkingDeltaEvent("private reasoning"), state, (progress) =>
            updates.push(progress),
        );

        expect(state.progress.phase).toBe("Thinking");
        expect(state.progress.output).toBe("");
        expect(state.progress.recentActivity).toEqual(["Thinking"]);
        expect(updates.at(-1)).not.toMatchObject({ output: "private reasoning" });
    });

    it("counts tool calls and preserves the last assistant response", () => {
        const state = partialTracker();
        updateTracker(messageStartEvent(), state, () => {});
        updateTracker(textDeltaEvent("I will inspect this.\nMore detail."), state, () => {});
        updateTracker(toolExecutionStartEvent("read", { path: "src/index.ts" }), state, () => {});
        updateTracker(
            toolExecutionStartEvent("grep", { path: "src", pattern: "widget" }),
            state,
            () => {},
        );

        updateTracker(toolExecutionEndEvent("read", { isError: true }), state, () => {});

        expect(state.progress.output).toBe("I will inspect this.\nMore detail.");
        expect(state.progress.toolCounts).toEqual({ read: 1, grep: 1 });
        expect(state.progress.failedToolCalls).toBe(1);
        expect(state.progress.lastToolActivity).toBe('Searching "widget" in src');
    });
});
