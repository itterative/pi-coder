import type { Usage } from "@earendil-works/pi-ai";

import {
    AgentRunManager,
    BACKGROUND_AGENT_WAIT_GUIDANCE,
    deriveAgentTitle,
} from "../runs/manager";
import { ZERO_USAGE } from "../runs/usage";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import type { AgentParameters } from "../definitions/prompt";

export function cloneUsage(): Usage {
    return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
}

export function listOutcome(manager: AgentRunManager): AgentRunOutcome {
    const runs = manager.listRuns();
    const content = runs.length
        ? runs.map((run) => {
            const nextAction = run.status === "waiting_for_parent" || run.status === "interrupted"
                ? `resume with guidance using runId=${JSON.stringify(run.runId)}`
                : run.status === "completed" || run.status === "failed" || run.status === "aborted" || run.status === "canceled"
                    ? `collect with runId=${JSON.stringify(run.runId)}`
                    : BACKGROUND_AGENT_WAIT_GUIDANCE;
            return `- ${JSON.stringify(run.runId)} · ${JSON.stringify(run.title)} · ${run.agent} · ${run.status}\n  Task: ${JSON.stringify(run.task)}\n  Next: ${nextAction}`;
        }).join("\n")
        : "No delegated agent runs are currently tracked.";
    const now = Date.now();
    return {
        content,
        details: {
            runId: "list",
            title: "Delegated agent runs",
            agent: "runtime",
            status: "completed",
            background: false,
            task: "List delegated agent runs",
            recentActivity: [],
            usage: cloneUsage(),
            startedAt: now,
            updatedAt: now,
        },
        usage: cloneUsage(),
        isError: false,
    };
}

export function failedOutcome(params: AgentParameters, error: unknown): AgentRunOutcome {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    const isNewRun = params.action === "start" || params.action === "spawn";
    const runId = isNewRun ? "unstarted" : "unknown";
    return {
        content: `Agent action failed: ${message}`,
        details: {
            runId,
            title: isNewRun ? deriveAgentTitle(params.task, params.title) : "Agent action",
            agent: isNewRun ? params.agent : "unknown",
            status: "failed",
            background: params.action === "spawn",
            task: isNewRun ? params.task.slice(0, 2_000) : "",
            recentActivity: [],
            usage: cloneUsage(),
            startedAt: now,
            updatedAt: now,
            error: message,
        },
        usage: cloneUsage(),
        isError: true,
    };
}

export function updateResult(details: AgentRunDetails) {
    const activity = details.recentActivity[details.recentActivity.length - 1];
    const text = activity
        ? `Agent ${details.title} (${details.runId}): ${activity}`
        : `Agent ${details.title} (${details.runId}): ${details.status}`;
    return {
        content: [{ type: "text" as const, text }],
        details,
    };
}
