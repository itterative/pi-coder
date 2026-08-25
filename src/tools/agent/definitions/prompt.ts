import { type Static, Type } from "typebox";

import type { AgentDefinition } from "./types";

export const parameters = Type.Union([
    Type.Object({
        action: Type.Literal("list"),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("start"),
        agent: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 16_000 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        isolation: Type.Optional(Type.Literal("worktree")),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("spawn"),
        agent: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 16_000 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        isolation: Type.Optional(Type.Literal("worktree")),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("resume"),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
        guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("cancel"),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Union([
            Type.Literal("inspect"),
            Type.Literal("apply"),
            Type.Literal("discard"),
        ]),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("revise"),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
        guidance: Type.String({ minLength: 1, maxLength: 16_000 }),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Union([Type.Literal("status"), Type.Literal("collect")]),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
    }, { additionalProperties: false }),
]);

export type AgentParameters = Static<typeof parameters>;

export function availableAgentsPrompt(agents: AgentDefinition[]): string {
    const lines = ["## Delegated agents"];
    for (const agent of agents.slice(0, 20)) {
        const description = agent.description.replace(/\s+/g, " ").slice(0, 300);
        const capabilities = ["codebase-read", ...agent.capabilities].join(", ");
        lines.push(`- ${agent.name} (${agent.source}): [${agent.mutating ? "mutation-capable" : "read-only"}; ${capabilities}] ${JSON.stringify(description)}`);
    }
    if (agents.length > 20) lines.push(`- …and ${agents.length - 20} more agents`);
    lines.push(
        "Use the agent tool with action=\"start\" for foreground delegation or action=\"spawn\" to launch concurrent background work.",
        "Use the agent tool with action=\"list\" to recover delegated run IDs, titles, statuses, and next actions; this is preferable to polling each run.",
        "Background-agent progress and results arrive asynchronously. Do not duplicate the same investigation in the parent unless you intentionally want overlapping work. If you have no other work to do, report your current progress to the user and end your turn; do not poll with the agent tool's action=\"status\" or wait by sleeping; an automatic mailbox notification will arrive when the run finishes or needs parent guidance.",
        "After a terminal agent notification, use the agent tool with action=\"collect\" to retrieve the full result; mailbox markers never inject full child output automatically.",
        "A waiting agent result is paused, not completed. Investigate or obtain guidance, then use the agent tool to resume it; cancel it if no longer needed. An interrupted durable run never resumes automatically; wait for explicit user direction before resuming or canceling it.",
        "The parent agent may use its own active built-in tools (including read, edit, write, and bash) directly; delegation is optional and is for substantial, parallel, or isolated work.",
        "Scout and custom agents are read-only. The built-in worker is the only mutation-capable child; each worker edit/write/bash action requires an explicit user permission prompt. Same-checkout workers are single-flight, while workers in distinct isolated worktrees may run concurrently.",
        "Use isolation=\"worktree\" when the worker should run in a persistent isolated Git worktree; a new worktree may prompt for an optional setup worker.",
        "For an isolated result, the parent can use agent action=\"inspect\", \"apply\", or \"discard\" with the runId, or action=\"revise\" with guidance to continue work in the same workspace.",
    );
    return `<delegated_agents>\n${lines.join("\n")}\n</delegated_agents>`;
}
