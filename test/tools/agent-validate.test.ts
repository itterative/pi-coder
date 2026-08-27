import { describe, expect, it } from "vitest";

import { validateAgentParameters } from "../../src/tools/agent/definitions/validate";
import type { AgentParameters } from "../../src/tools/agent/definitions/prompt";

function validate(params: AgentParameters) {
    return validateAgentParameters(params);
}

describe("validateAgentParameters", () => {
    it("accepts minimal valid calls for every action", () => {
        expect(validate({ action: "list" })).toEqual({ action: "list" });
        expect(
            validate({ action: "start", agent: "scout", task: "Inspect the repo" }),
        ).toMatchObject({ action: "start", agent: "scout", task: "Inspect the repo" });
        expect(
            validate({ action: "spawn", agent: "worker", task: "Implement", isolation: "worktree", title: "Impl" }),
        ).toMatchObject({ action: "spawn", isolation: "worktree" });
        expect(validate({ action: "resume", runId: "scout-1" })).toEqual({ action: "resume", runId: "scout-1" });
        expect(
            validate({ action: "resume", runId: "scout-1", guidance: "Compare both." }),
        ).toMatchObject({ guidance: "Compare both." });
        expect(validate({ action: "cancel", runId: "scout-1" })).toEqual({ action: "cancel", runId: "scout-1" });
        expect(validate({ action: "inspect", runId: "worker-1" })).toEqual({ action: "inspect", runId: "worker-1" });
        expect(validate({ action: "apply", runId: "worker-1" })).toEqual({ action: "apply", runId: "worker-1" });
        expect(validate({ action: "discard", runId: "worker-1" })).toEqual({ action: "discard", runId: "worker-1" });
        expect(
            validate({ action: "revise", runId: "worker-1", guidance: "Fix the tests" }),
        ).toMatchObject({ guidance: "Fix the tests" });
        expect(validate({ action: "status", runId: "scout-1" })).toEqual({ action: "status", runId: "scout-1" });
        expect(validate({ action: "collect", runId: "scout-1" })).toEqual({ action: "collect", runId: "scout-1" });
    });

    it("rejects unknown actions with the valid action list", () => {
        expect(() => validate({ action: "restart" } as AgentParameters)).toThrow(
            'Unknown action "restart". Valid actions: list, start, spawn, resume, cancel, inspect, apply, discard, revise, status, collect.',
        );
    });

    it("rejects missing required fields with per-field hints", () => {
        expect(() => validate({ action: "start", agent: "scout" } as AgentParameters)).toThrow(
            'Action "start" requires "task" (self-contained task brief for the child agent).',
        );
        expect(() => validate({ action: "start" } as AgentParameters)).toThrow(
            'Action "start" requires "agent" (name of an available delegated agent), and "task" (self-contained task brief for the child agent).',
        );
        expect(() => validate({ action: "revise", runId: "worker-1" } as AgentParameters)).toThrow(
            'Action "revise" requires "guidance" (guidance text for the run).',
        );
        expect(() => validate({ action: "cancel" } as AgentParameters)).toThrow(
            'Action "cancel" requires "runId" (run ID of an existing run, as listed by action "list").',
        );
    });

    it("rejects fields that do not belong to the action", () => {
        expect(() => validate({ action: "cancel", runId: "scout-1", task: "x" } as AgentParameters)).toThrow(
            'Action "cancel" does not accept "task". Parameters for action "cancel": "runId".',
        );
        expect(() => validate({ action: "list", task: "x" } as AgentParameters)).toThrow(
            'Action "list" does not accept "task". Action "list" takes no parameters.',
        );
        expect(
            () => validate({ action: "status", runId: "scout-1", guidance: "nope" } as AgentParameters),
        ).toThrow('Action "status" does not accept "guidance". Parameters for action "status": "runId".');
    });

    it("preserves context sections for start and spawn", () => {
        const context = {
            sections: [{ id: "goal", title: "Goal", content: "Do X", source: "parent" }],
        };
        const request = validate({ action: "start", agent: "scout", task: "t", context });
        if (request.action !== "start") throw new Error("expected start");
        expect(request.context).toEqual(context);
    });
});
