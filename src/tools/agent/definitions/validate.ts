import { AgentActionError } from "../runs/manager";
import type { AgentContext } from "../contracts/context";
import type { AgentParameters } from "./prompt";

/**
 * Strict per-action parameter shape produced by validateAgentParameters.
 * The wire schema is deliberately flat (see definitions/prompt.ts), so this
 * union is what the dispatch code narrows on after validation.
 */
export type AgentRequest =
    | { action: "list" }
    | { action: "start"; agent: string; task: string; title?: string; isolation?: "worktree"; context?: AgentContext; background?: boolean }
    | { action: "resume"; runId: string; guidance?: string }
    | { action: "cancel"; runId: string }
    | { action: "inspect"; runId: string }
    | { action: "apply"; runId: string }
    | { action: "discard"; runId: string }
    | { action: "revise"; runId: string; guidance: string }
    | { action: "status"; runId: string }
    | { action: "collect"; runId: string };

type ActionSpec = {
    readonly required: readonly string[];
    readonly optional: readonly string[];
};

const ACTION_FIELDS: Record<string, ActionSpec> = {
    list: { required: [], optional: [] },
    start: { required: ["agent", "task"], optional: ["title", "isolation", "context", "background"] },
    resume: { required: ["runId"], optional: ["guidance"] },
    cancel: { required: ["runId"], optional: [] },
    inspect: { required: ["runId"], optional: [] },
    apply: { required: ["runId"], optional: [] },
    discard: { required: ["runId"], optional: [] },
    revise: { required: ["runId", "guidance"], optional: [] },
    status: { required: ["runId"], optional: [] },
    collect: { required: ["runId"], optional: [] },
};

const FIELD_HINTS: Record<string, string> = {
    agent: "name of an available delegated agent",
    task: "self-contained task brief for the child agent",
    runId: "run ID of an existing run, as listed by action \"list\"",
    guidance: "guidance text for the run",
};

function describeField(field: string): string {
    const hint = FIELD_HINTS[field];
    return hint ? `${JSON.stringify(field)} (${hint})` : JSON.stringify(field);
}

function joinFields(fields: string[]): string {
    if (fields.length <= 1) {
        return fields.join("");
    }
    return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

/**
 * Enforces per-action parameter requirements that the flat tool schema cannot
 * express. Throws AgentActionError with a message the calling model can act on
 * directly (retry with the corrected parameters).
 */
export function validateAgentParameters(params: AgentParameters): AgentRequest {
    const spec = ACTION_FIELDS[params.action];
    if (!spec) {
        throw new AgentActionError(
            `Unknown action ${JSON.stringify(params.action)}. Valid actions: ${Object.keys(ACTION_FIELDS).join(", ")}.`,
        );
    }

    const value = params as Record<string, unknown>;
    const allowed = [...spec.required, ...spec.optional];
    const provided = Object.keys(value).filter((key) => key !== "action" && value[key] !== undefined);

    const unexpected = provided.filter((key) => !allowed.includes(key));
    if (unexpected.length > 0) {
        const quoted = (field: string) => JSON.stringify(field);
        const accepted = allowed.length > 0
            ? `Parameters for action ${JSON.stringify(params.action)}: ${allowed.map(quoted).join(", ")}.`
            : `Action ${JSON.stringify(params.action)} takes no parameters.`;
        throw new AgentActionError(
            `Action ${JSON.stringify(params.action)} does not accept ${joinFields(unexpected.map(quoted))}. ${accepted}`,
        );
    }

    const missing = spec.required.filter((key) => value[key] === undefined);
    if (missing.length > 0) {
        throw new AgentActionError(
            `Action ${JSON.stringify(params.action)} requires ${joinFields(missing.map(describeField))}.`,
        );
    }

    return value as AgentRequest;
}
