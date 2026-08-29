import { describe, expect, it } from "vitest";

import { validateAgentParameters } from "../../src/tools/agent/definitions/validate";
import type { AgentParameters } from "../../src/tools/agent/definitions/prompt";
import { unusedAgentContextWarning } from "../../src/tools/agent/prompts/renderer";

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
            validate({ action: "start", agent: "worker", task: "Implement", isolation: "worktree", title: "Impl", background: true }),
        ).toMatchObject({ action: "start", isolation: "worktree", background: true });
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
            'Unknown action "restart". Valid actions: list, start, resume, cancel, inspect, apply, discard, revise, status, collect.',
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

    it("preserves context sections for start", () => {
        const context = {
            sections: [{ id: "goal", title: "Goal", content: "Do X", source: "parent" }],
        };
        const request = validate({ action: "start", agent: "scout", task: "t", context });
        if (request.action !== "start") throw new Error("expected start");
        expect(request.context).toEqual(context);
    });

    it("warns when an agent ignores additional context", () => {
        const context = {
            sections: [
                { id: "parent_summary", title: "Summary", content: "Known", source: "parent" as const },
                { id: "recent_context", title: "Recent", content: "Recent", source: "parent" as const },
            ],
        };

        expect(unusedAgentContextWarning("scout", context, undefined)).toBe(
            'Warning: Agent "scout" does not accept additional context; ignored sections: "parent_summary", "recent_context".',
        );
        expect(unusedAgentContextWarning("advisor", context, {
            sectionIds: ["parent_summary"],
            maxChars: 1_000,
        })).toBe(
            'Warning: Agent "advisor" ignored additional context section: "recent_context".',
        );
        expect(unusedAgentContextWarning("advisor", {
            sections: [{ id: "parent_summary", title: "Summary", content: "Known", source: "parent" }],
        }, {
            sectionIds: ["parent_summary"],
            maxChars: 1_000,
        })).toBeUndefined();
    });
});
