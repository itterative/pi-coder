import { type Static, Type } from "typebox";

import { agentCanEdit, agentCanRunCommands, agentCapabilities, type AgentDefinition } from "./types";

const agentContextSchema = Type.Optional(Type.Object({
    sections: Type.Array(Type.Object({
        id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        content: Type.String({ minLength: 1, maxLength: 12_000 }),
        source: Type.String({ enum: ["parent", "repository", "workspace"] }),
    }, { additionalProperties: false }), { maxItems: 12 }),
}, { additionalProperties: false }));

// Flat single-object schema: constrained-decoding engines (e.g. llama.cpp)
// reliably support plain objects, required/optional properties, and enums,
// but not anyOf/oneOf discriminated unions. Per-action requiredness is
// enforced by validateAgentParameters (definitions/validate.ts), which
// returns model-facing error messages for missing or misplaced fields.
export const parameters = Type.Object({
    action: Type.String({
        enum: [
            "list",
            "start",
            "resume",
            "cancel",
            "inspect",
            "apply",
            "discard",
            "revise",
            "status",
            "collect",
        ],
    }),
    agent: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", maxLength: 64 })),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    isolation: Type.Optional(Type.Literal("worktree")),
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
    context: agentContextSchema,
    background: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type AgentParameters = Static<typeof parameters>;

export function availableAgentsPrompt(agents: AgentDefinition[]): string {
    const lines = ["## Delegated agents"];
    for (const agent of agents.slice(0, 20)) {
        const description = agent.description.replace(/\s+/g, " ").slice(0, 300);
        const capabilities = agentCapabilities(agent).join(", ");
        const mode = agentCanEdit(agent)
            ? "edit-capable"
            : agentCanRunCommands(agent)
                ? "command-capable"
                : "read-only";
        const context = agent.contextPolicy?.sectionIds.length
            ? `; context sections: ${agent.contextPolicy.sectionIds.join(", ")}`
            : "";
        lines.push(`- ${agent.name} (${agent.source}): [${mode}; ${capabilities}${context}] ${JSON.stringify(description)}`);
    }
    if (agents.length > 20) lines.push(`- …and ${agents.length - 20} more agents`);
    lines.push(
        "Use the agent tool with action=\"start\" for foreground delegation, or action=\"start\" with background=true to launch concurrent background work.",
        "Write every delegation task as a self-contained brief for a child that cannot see the parent's conversation or infer unstated context. Include the objective, relevant files/symbols and current state, scope and non-goals, constraints, expected report or changes, and validation steps. Include all other details the child needs; do not optimize the task for brevity.",
        "Delegation tasks may and should be multiline. A short title is only a display label and does not limit the task's length or detail. Put relevant parent, repository, or workspace facts explicitly in the task or in context.sections; context sections supplement the task and do not replace its instructions.",
        "Use the agent tool with action=\"list\" to recover delegated run IDs, titles, statuses, and next actions; this is preferable to polling each run.",
        "Background-agent progress and results arrive asynchronously. Do not duplicate the same investigation in the parent unless you intentionally want overlapping work. If you have no other work to do, report your current progress to the user and end your turn; do not poll with the agent tool's action=\"status\" or wait by sleeping; an automatic mailbox notification will arrive when the run finishes or needs parent guidance.",
        "After a terminal agent notification, use the agent tool with action=\"collect\" to retrieve the full result; mailbox markers never inject full child output automatically.",
        "A waiting agent result is paused, not completed. Investigate or obtain guidance, then use the agent tool to resume it; cancel it if no longer needed. An interrupted durable run never resumes automatically; wait for explicit user direction before resuming or canceling it.",
        "The parent agent may use its own active built-in tools (including read, edit, write, and bash) directly; delegation is optional and is for substantial, parallel, or isolated work.",
        "Start accepts an optional background flag and context.sections for concise parent, repository, or workspace context; each agent's context policy selects what it receives, and context is reference material rather than instructions.",
        "Scout and advisor are read-only. Reviewer and custom agents with command-runner may execute Bash through the permission flow; they do not receive direct edit/write tools. Use advisor for explicit implementation guidance and tradeoff review. The built-in worker is the only direct edit-capable child. Without isolation=\"worktree\", it edits the parent's current checkout: in-cwd edits use the parent's file access, outside-cwd file access uses the shared file prompt, already-allowed/session-approved bash runs without another prompt, and unmatched bash uses a parent-visible prompt. With isolation=\"worktree\", it edits a separate worktree and uses independent permission prompts; changes reach the parent only after an explicit apply. Same-checkout workers are single-flight, while distinct isolated workers may run concurrently.",
        "Use isolation=\"worktree\" when the worker should run in a persistent isolated Git worktree; a new worktree may prompt for an optional setup worker.",
        "For an isolated result, the parent can use agent action=\"inspect\", \"apply\", or \"discard\" with the runId, or action=\"revise\" with guidance to continue work in the same workspace; isolated revise is available only while its prepared task lease is held.",
        "After collecting a terminal read-only or command-capable run, such as reviewer, use agent action=\"revise\" with its runId and parent guidance to continue the existing child session without an isolated workspace.",
        "Durable revision resolution is limited to the exact persisted parent session and active parent-tree branch.",
    );
    return `<delegated_agents>\n${lines.join("\n")}\n</delegated_agents>`;
}
