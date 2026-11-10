import { type Static, Type } from "typebox";

import {
    agentCanEdit,
    agentCanRunCommands,
    agentCapabilities,
    type AgentDefinition,
} from "./types";

const agentContextSchema = Type.Optional(
    Type.Object(
        {
            sections: Type.Array(
                Type.Object(
                    {
                        id: Type.String({
                            pattern: "^[a-z][a-z0-9_-]{0,63}$",
                            description: "Section id the child receives alongside its task",
                        }),
                        title: Type.String({
                            minLength: 1,
                            maxLength: 200,
                            description: "Heading for the section",
                        }),
                        content: Type.String({
                            minLength: 1,
                            maxLength: 12_000,
                            description:
                                "The fact or excerpt itself, bounded to one section's worth",
                        }),
                        source: Type.String({
                            enum: ["parent", "repository", "workspace"],
                            description: "Where the content comes from",
                        }),
                    },
                    { additionalProperties: false },
                ),
                {
                    maxItems: 12,
                    description: "Supplemental context the child receives with the task",
                },
            ),
        },
        { additionalProperties: false, description: "Supplemental context for this run" },
    ),
);

// Flat single-object schema: constrained-decoding engines (e.g. llama.cpp)
// reliably support plain objects, required/optional properties, and enums,
// but not anyOf/oneOf discriminated unions. Per-action requiredness is
// enforced by validateAgentParameters (definitions/validate.ts), which
// returns model-facing error messages for missing or misplaced fields.
export const parameters = Type.Object(
    {
        action: Type.String({
            enum: [
                "list",
                "start",
                "continue",
                "cancel",
                "inspect",
                "apply",
                "discard",
                "status",
                "collect",
            ],
            description:
                "start runs a task; list, status, collect, continue, and cancel manage retained runs; inspect, apply, and discard dispose of an isolated workspace's result",
        }),
        agent: Type.Optional(
            Type.String({
                pattern: "^[a-z][a-z0-9_-]{0,63}$",
                maxLength: 64,
                description:
                    "Agent name from the delegated-agents catalog, for example scout or worker",
            }),
        ),
        task: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 16_000,
                description:
                    "The child's complete assignment: objective, relevant files and symbols, scope, constraints, and the expected result. Required for start",
            }),
        ),
        title: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 80,
                description: "Short display label for the run, shown in the agent list",
            }),
        ),
        isolation: Type.Optional(
            Type.Literal("worktree", {
                description:
                    'Set to "worktree" to run the worker in its own Git worktree; its changes reach this checkout only after apply',
            }),
        ),
        runId: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 100,
                description: "Run identifier returned by start or list",
            }),
        ),
        guidance: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 16_000,
                description: "Instructions delivered to the run's existing child session",
            }),
        ),
        context: agentContextSchema,
        background: Type.Optional(
            Type.Boolean({
                description:
                    "Return without waiting; progress and the final result arrive as messages",
            }),
        ),
    },
    { additionalProperties: false },
);

export type AgentParameters = Static<typeof parameters>;

/**
 * The parent's guide to delegation: the discovered catalog, the permission model, and how to run and
 * collect a delegation. Pi wraps this in an `agent_tool_guide` section while the `agent` tool is declared.
 */
export function agentGuidePrompt(agents: AgentDefinition[]): string {
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
            ? `; context sections limited to: ${agent.contextPolicy.sectionIds.join(", ")}`
            : "";
        lines.push(
            `- ${agent.name} (${agent.source}): [${mode}; ${capabilities}${context}] ${JSON.stringify(description)}`,
        );
    }

    if (agents.length > 20) {
        lines.push(`- …and ${agents.length - 20} more agents`);
    }

    lines.push(
        "",
        "Roles:",
        "- scout and advisor are read-only; reviewer and command-capable custom agents run Bash through the permission flow without direct edit tools; worker is the only edit-capable built-in.",
        "- A same-checkout worker edits this checkout under the parent's file access and its approved Bash rules, and asks the parent before running anything else.",
        "- An isolated worker edits its own worktree under independent prompts, and only `apply` moves its changes into this checkout.",
        "- Same-checkout workers are single-flight; distinct isolated workers may run concurrently.",
        "",
        "Delegating:",
        "- Judge whether you already have enough context to do the work yourself. If you do, use ask_user to offer delegation instead, including the same-checkout versus isolated-worktree choice; start unasked only when it is genuinely needed, such as parallel work or an isolated checkout, and skip that check when no user can answer. Read-only agents need no confirmation.",
        "- Every task is the child's complete assignment: objective, relevant files and symbols, current state, scope and non-goals, constraints, expected report or changes, and validation steps. A child cannot see this conversation or infer unstated context, so do not optimize the task for brevity, and do not treat a title as a substitute for it.",
        "- Put supplemental parent, repository, or workspace context in `context.sections`; every agent receives the sections it is given, and a definition may narrow the ids it accepts.",
        "- Prefer the foreground when you need the result before continuing; use `background=true` with a short title for independent work that can run alongside your own.",
        "- Progress arrives on its own: do not poll `status` or sleep, and do not duplicate the same investigation while a run is working. A terminal notice means `collect`, and a mailbox update never carries the full result.",
        "- A waiting run is paused, not finished: `continue` it with guidance, or `cancel` it. When a child asks for guidance, answer through `continue` rather than starting a new run.",
        "- Start with `list` when resuming after compaction or a session switch: it recovers run IDs and statuses. Use the returned run ID exactly, keep in mind that runs are cwd-confined, and know that durable continuation is limited to this parent session and branch; an interrupted run never resumes on its own, so wait for the user before continuing it and treat its tool outcomes as uncertain.",
        "- An isolated result is parent-controlled: `inspect` the workspace first, `apply` is the only way its changes reach this checkout, and `discard` or `continue` with guidance are the alternatives.",
    );

    return lines.join("\n");
}
