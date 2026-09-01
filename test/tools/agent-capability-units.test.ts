import { describe, expect, it, vi } from "vitest";

import { READ_ONLY_AGENT_TOOLS } from "../../src/tools/agent/definitions/types";
import type { AgentCapability, AgentDefinition } from "../../src/tools/agent/definitions/types";
import {
    appliedUnits,
    capabilityExtensions,
    capabilityReadRoots,
    capabilityTools,
} from "../../src/tools/agent/child/capabilities";
import { getUserMemoryDirectory } from "../../src/common/constants";
import type { TodoProgress } from "../../src/modules/todolist/progress";
import type { ChildProgressTracker } from "../../src/tools/agent/child/progress";

/**
 * The capability unit registry: what each capability grants, and the order those grants appear in.
 *
 * These are the invariants the child assembly relies on. The rendered prompts are pinned elsewhere
 * (`agent-prompt.test.ts`), and the full assembly differential lives in the refactor's oracle.
 */

function definition(
    capabilities: AgentCapability[],
    extra: Partial<AgentDefinition> = {},
): AgentDefinition {
    return {
        name: "unit-probe",
        description: "Probe definition for capability units",
        capabilities,
        systemPrompt: "You are a probe.",
        source: "user",
        ...extra,
    };
}

function unitIds(capabilities: AgentCapability[]): string[] {
    return appliedUnits(definition(capabilities)).map((unit) => unit.id);
}

function trackerStub(): ChildProgressTracker {
    return {
        progress: { output: "", recentActivity: [], toolCounts: {} },
        pendingQuestion: undefined,
        lastUpdateAt: 0,
        changedFiles: new Set(),
        readFiles: new Set(),
        bashApproved: false,
        interrupted: false,
    } as unknown as ChildProgressTracker;
}

describe("capability units", () => {
    it("grants the baseline read-only tools through the read and search units", () => {
        // The two units split `READ_ONLY_AGENT_TOOLS` between them, so this is the check that keeps
        // the split honest: a child that declares nothing still sees the same four tools, in order.
        expect(capabilityTools(definition([]))).toEqual([...READ_ONLY_AGENT_TOOLS]);
        expect(capabilityTools(definition(["read", "search"]))).toEqual([...READ_ONLY_AGENT_TOOLS]);
    });

    it("keeps the session allowlist order the child has always had", () => {
        expect(capabilityTools(definition(["edit", "safe-bash"]))).toEqual([
            ...READ_ONLY_AGENT_TOOLS,
            "edit",
            "write",
            "bash",
        ]);
    });

    it("reaches bash through the declaration layer's implication, not a second rule", () => {
        // `command-runner` contributes no tool of its own; bash appears because declaring it implies
        // `safe-bash` in `definitions/types.ts`, which is also what the parent catalog advertises.
        expect(unitIds(["command-runner"])).toContain("safe-bash");
        expect(capabilityTools(definition(["command-runner"]))).toContain("bash");
        expect(capabilityTools(definition(["command-runner"]))).toEqual(
            capabilityTools(definition(["command-runner", "safe-bash"])),
        );
    });

    it("publishes the definition's own paths before the memory root", () => {
        const extra = "/opt/read-only";
        const withMemories = definition(["memories"], { additionalPaths: [extra] });

        expect(capabilityReadRoots(withMemories)).toEqual([extra, getUserMemoryDirectory()]);
        expect(capabilityReadRoots(definition([]))).toEqual([]);
    });

    it("does not list the memory root twice when a definition names it explicitly", () => {
        const memoryRoot = getUserMemoryDirectory();
        const roots = capabilityReadRoots(
            definition(["memories"], { additionalPaths: [memoryRoot] }),
        );

        expect(roots).toEqual([memoryRoot]);
    });

    it("registers one extension per resource capability, in registry order", () => {
        const tracker = trackerStub();
        const onProgress = vi.fn();
        const entries = capabilityExtensions({ tracker, onProgress }, definition(["todolist"]));

        // `todolist` implies `scratchpad`, so both extensions arrive; memory is absent because it was
        // not declared. Order is registry order and is load-bearing for handler sequencing.
        expect(entries.map((entry) => entry.name)).toEqual([
            "pi-coder-scratchpad-child",
            "pi-coder-todolist-child",
        ]);
        expect(entries.every((entry) => entry.hidden === true)).toBe(true);
    });

    it("stores a todo frame on the tracker before reporting it", async () => {
        // Ordering invariant: the parent must never receive a progress frame whose todo list is ahead
        // of, or behind, the tracker it was projected from.
        vi.resetModules();
        let publish: ((todo: TodoProgress | undefined) => void) | undefined;
        vi.doMock("../../src/modules/todolist", () => ({
            default: (
                _pi: unknown,
                options: { onTodoProgress: (todo: TodoProgress | undefined) => void },
            ) => {
                publish = options.onTodoProgress;
            },
        }));
        const { TODOLIST_UNIT } = await import("../../src/tools/agent/child/capabilities/todolist");

        const tracker = trackerStub();
        const frames: Array<string> = [];
        const extension = TODOLIST_UNIT.extension!({
            tracker,
            onProgress: () => {
                frames.push(JSON.stringify(tracker.progress.todo ?? null));
            },
        });
        (extension.factory as (pi: unknown) => void)({ on: vi.fn(), registerTool: vi.fn() });
        expect(publish).toBeTypeOf("function");

        publish!({ completed: 1, total: 2, current: "wire it up" });
        publish!(undefined);

        expect(frames).toEqual(['{"completed":1,"total":2,"current":"wire it up"}', "null"]);
        vi.doUnmock("../../src/modules/todolist");
    });
});
