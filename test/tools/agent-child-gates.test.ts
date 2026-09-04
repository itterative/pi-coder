import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    BUILTIN_REVIEWER,
    BUILTIN_SCOUT,
    BUILTIN_WORKER,
} from "../../src/tools/agent/definitions/discovery";
import type { AgentDefinition } from "../../src/tools/agent/definitions/types";
import type { ChildProgress } from "../../src/tools/agent/contracts/runs";
import { stubContext } from "../helpers/pi-stub";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildGateRuntime } from "../../src/tools/agent/child/gates";
import { buildChildRun, probeDefinition, type ChildRunMode } from "./child-run-fixture";

/**
 * Which gates a child arms, in what order, and against what shared state.
 *
 * pi runs `tool_call` handlers in registration order and these gates consult each other: the
 * file-access gate records approvals that the confinement gate later honours, and the command gate
 * claims the tools the heuristic bash guard would otherwise classify. The sequence is therefore a
 * specification, not an implementation detail, and every expectation below is written out from that
 * specification rather than generated from the code.
 */

function registrationRecord(target: AgentDefinition, mode: ChildRunMode = {}): string[] {
    return buildChildRun(target, mode).install().calls;
}

function toolCallHandlers(target: AgentDefinition, mode: ChildRunMode = {}): number {
    return buildChildRun(target, mode).install().toolCall.length;
}

function runtimeFor(target: AgentDefinition, mode: ChildRunMode = {}) {
    const fixture = buildChildRun(target, mode);
    const runtime = createChildGateRuntime({
        pi: { on: () => {}, registerTool: () => {} } as unknown as ExtensionAPI,
        parentContext: fixture.parentContext,
        cwd: fixture.cwd,
        tracker: fixture.tracker,
        options: fixture.grant.extensionOptions,
    });
    return { fixture, runtime };
}

const COMMAND_AND_EDIT: AgentDefinition = probeDefinition("gate-probe", ["command-runner", "edit"]);

describe("child gate composition", () => {
    it("arms bash-output, interaction, and confinement for a read-only child", () => {
        expect(registrationRecord(probeDefinition("gate-probe", ["safe-bash"]))).toEqual([
            "on:session_start",
            "on:tool_result",
            "tool:ask_user",
            "tool:ask_parent",
            "on:tool_call",
        ]);
    });

    it("withholds ask_user when the parent cannot answer", () => {
        expect(
            registrationRecord(probeDefinition("gate-probe", ["safe-bash"]), {
                parentKind: "no-ui",
            }),
        ).toEqual(["on:session_start", "on:tool_result", "tool:ask_parent", "on:tool_call"]);
    });

    it("keeps the read-only heuristic guard instead of a command gate", () => {
        // One handler, because no command gate claimed the tools: below the `command` rung the
        // confinement handler classifies bash itself.
        expect(toolCallHandlers(BUILTIN_SCOUT)).toBe(1);
    });

    it("adds the command gate for a command-capable child", () => {
        expect(registrationRecord(BUILTIN_REVIEWER)).toEqual([
            "on:session_start",
            "on:tool_result",
            "tool:ask_user",
            "tool:ask_parent",
            "on:tool_call",
            "on:tool_result",
            "on:tool_call",
        ]);
    });

    it("arms the file-access gate only for a worker sharing the parent checkout", () => {
        const shared = registrationRecord(BUILTIN_WORKER);
        const isolated = registrationRecord(BUILTIN_WORKER, {
            isolated: true,
            workspaceId: "workspace-1",
        });

        // Two operations x three hooks, installed ahead of the gates that consult their approvals.
        expect(shared.slice(0, 8)).toEqual([
            "on:session_start",
            "on:tool_result",
            "on:session_start",
            "on:tool_call",
            "on:tool_result",
            "on:session_start",
            "on:tool_call",
            "on:tool_result",
        ]);
        expect(isolated.slice(0, 2)).toEqual(["on:session_start", "on:tool_result"]);
        expect(shared).toHaveLength(isolated.length + 6);
    });

    it("treats a restored run with a workspace id as isolated", () => {
        expect(registrationRecord(BUILTIN_WORKER, { workspaceId: "workspace-1" })).toEqual(
            registrationRecord(BUILTIN_WORKER, { isolated: true, workspaceId: "workspace-1" }),
        );
    });

    it("arms the same gates for the internal setup child", () => {
        // Setup is command-capable without edit, and carries its Bash timeout as run mode rather than
        // being recognized by name inside the gate.
        expect(
            registrationRecord(probeDefinition("workspace-setup", ["command-runner"]), {
                isolated: true,
                workspaceId: "workspace-1",
                defaultBashTimeoutSeconds: 600,
            }),
        ).toEqual(registrationRecord(BUILTIN_REVIEWER));
    });
});

describe("gate runtime services", () => {
    it("labels a run for the end user with its title and id", () => {
        const { runtime } = runtimeFor(COMMAND_AND_EDIT);

        expect(runtime.runLabel).toBe("Probe title · gate-probe-1");
    });

    it("falls back to the run id when no title was given", () => {
        const { runtime } = runtimeFor(COMMAND_AND_EDIT, { runTitle: "" });

        expect(runtime.runLabel).toBe("gate-probe-1");
    });

    it("shares the parent approval state only with a same-checkout child", () => {
        const shared = runtimeFor(BUILTIN_WORKER);
        const isolated = runtimeFor(BUILTIN_WORKER, { isolated: true, workspaceId: "workspace-1" });

        // The isolated child still resolves the parent's state, because a rule the end user explicitly
        // remembers there is written back into it, but it must not *read* it.
        expect(shared.runtime.permissionState).toBe(shared.runtime.parentPermissionState);
        expect(isolated.runtime.permissionState).toBeUndefined();
        expect(isolated.runtime.parentPermissionState).toBeDefined();
    });

    it("bounds the activity trail and reports the frame that carries it", () => {
        const fixture = buildChildRun(COMMAND_AND_EDIT);
        const runtime = createChildGateRuntime({
            pi: { on: () => {}, registerTool: () => {} } as unknown as ExtensionAPI,
            parentContext: fixture.parentContext,
            cwd: fixture.cwd,
            tracker: fixture.tracker,
            options: {
                ...fixture.grant.extensionOptions,
                onProgress: (progress: ChildProgress) => {
                    fixture.frames.push({
                        ...progress,
                        recentActivity: [...progress.recentActivity],
                    });
                },
                onTrace: (type: string) => {
                    fixture.traces.push(type);
                },
            },
        });

        for (let index = 0; index < 10; index += 1) {
            runtime.reportPermissionPending(true, `Waiting ${index}`);
        }

        expect(fixture.tracker.progress.recentActivity).toEqual([
            "Waiting 2",
            "Waiting 3",
            "Waiting 4",
            "Waiting 5",
            "Waiting 6",
            "Waiting 7",
            "Waiting 8",
            "Waiting 9",
        ]);
        expect(fixture.tracker.progress.permissionPending).toBe(true);
        expect(fixture.traces).toEqual(Array.from({ length: 10 }, () => "mutation.permission"));
        // The frame the parent receives carries what the tracker already holds, never a stale value.
        expect(fixture.frames.at(-1)?.permissionPending).toBe(true);
        expect(fixture.frames.at(-1)?.recentActivity).toHaveLength(8);

        runtime.reportPermissionPending(false, "Working");
        expect(fixture.tracker.progress.permissionPending).toBe(false);
    });

    it("validates reported Bash output paths before treating them as read roots", () => {
        const { fixture, runtime } = runtimeFor(BUILTIN_WORKER);

        // Nothing outside the temp directory counts, and a path that no longer matches what was
        // recorded is dropped rather than kept usable.
        runtime.bashOutputs.remember({ fullOutputPath: path.join(fixture.cwd, "not-temp.txt") });
        runtime.bashOutputs.remember({ fullOutputPath: "/no/such/output" });
        expect(runtime.bashOutputs.active()).toEqual([]);

        const output = path.join(
            fs.realpathSync(os.tmpdir()),
            `child-gates-${process.pid}-${Date.now()}.txt`,
        );
        fs.writeFileSync(output, "truncated output\n");
        try {
            runtime.bashOutputs.remember({ fullOutputPath: output });
            expect(runtime.bashOutputs.active()).toEqual([output]);
            expect(runtime.readRoots(stubContext({ cwd: fixture.cwd }))).toContain(output);

            fs.rmSync(output);
            expect(runtime.bashOutputs.active()).toEqual([]);
        } finally {
            fs.rmSync(output, { force: true });
        }
    });
});
