import fs from "node:fs";

import type { Usage } from "@earendil-works/pi-ai";

import {
    AgentRunManager,
    BACKGROUND_AGENT_WAIT_GUIDANCE,
    deriveAgentTitle,
} from "../runs/manager";
import { ZERO_USAGE } from "../runs/usage";
import type { AgentRunDetails, AgentRunOutcome, AgentRunSummary } from "../contracts/runs";
import type { AgentParameters } from "../definitions/prompt";
import type { AgentWorkspace } from "../contracts/workspaces";

export function cloneUsage(): Usage {
    return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
}

interface ListedRun {
    run: AgentRunSummary;
    catalogAction?: string;
    catalogOnly?: boolean;
    workspace?: AgentWorkspace;
}

function workspaceBlockers(workspaces: readonly AgentWorkspace[]): ListedRun[] {
    const listed: ListedRun[] = [];
    const seen = new Set<string>();
    for (const workspace of workspaces) {
        const result = workspace.latestResult;
        const hasPreparedResult = result?.status === "prepared";
        const missingWorktree = !fs.existsSync(workspace.worktreePath);
        const isUnavailable = Boolean(workspace.leaseRunId)
            || hasPreparedResult
            || workspace.status === "review_required"
            || missingWorktree;
        if (!isUnavailable) continue;

        const runIds = [
            ...(workspace.leaseRunId ? [workspace.leaseRunId] : []),
            ...(result && (hasPreparedResult || workspace.status === "review_required")
                ? [result.runId]
                : []),
            ...(missingWorktree && !workspace.leaseRunId
                && !(result && (hasPreparedResult || workspace.status === "review_required"))
                ? [`workspace-${workspace.id}`]
                : []),
        ];
        for (const runId of new Set(runIds)) {
            const key = `${workspace.id}:${runId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const hasResult = result?.runId === runId;
            const status: AgentRunSummary["status"] = hasResult || workspace.status === "review_required"
                ? "completed"
                : "interrupted";
            const agent = workspace.leaseKind === "setup" && !hasResult
                ? "workspace-setup"
                : missingWorktree && !workspace.leaseRunId && !result
                    ? "workspace-registry"
                    : "worker";
            const nextAction = missingWorktree
                ? `inspect workspace ${JSON.stringify(workspace.slug)} in /agents; its worktree is missing and may be consuming workspace capacity`
                : hasPreparedResult
                    ? `review workspace ${JSON.stringify(workspace.slug)} and prepared result ${JSON.stringify(result!.id)} in /agents; apply, retain, reset, or discard it before reusing the workspace`
                    : workspace.status === "review_required"
                        ? `inspect workspace ${JSON.stringify(workspace.slug)} in /agents and review it before reusing the workspace`
                        : `inspect workspace ${JSON.stringify(workspace.slug)} in /agents; this catalog-only run is unavailable, so do not resume or collect it until the workspace state is confirmed`;
            listed.push({
                run: {
                    runId,
                    title: `Isolated workspace blocker · ${workspace.slug}`,
                    agent,
                    status,
                    background: false,
                    task: `Catalog-only isolated workspace blocker for ${workspace.slug}`,
                    startedAt: workspace.leaseAcquiredAt ?? workspace.createdAt,
                    updatedAt: workspace.updatedAt,
                    usage: cloneUsage(),
                    mutating: agent !== "workspace-setup",
                    workspaceId: workspace.id,
                },
                catalogAction: nextAction,
                catalogOnly: true,
                workspace,
            });
        }
    }
    return listed;
}

export function listOutcome(
    manager: AgentRunManager,
    workspaces: readonly AgentWorkspace[] = [],
): AgentRunOutcome {
    const runs: ListedRun[] = manager.listRuns().map((run) => ({ run }));
    for (const listed of workspaceBlockers(workspaces)) {
        const existing = runs.find((candidate) => (
            candidate.run.runId === listed.run.runId
            && (
                candidate.run.workspaceId === listed.run.workspaceId
            )
        ));
        if (existing) {
            if (listed.workspace?.latestResult?.status === "prepared"
                || listed.workspace?.status === "review_required") {
                existing.catalogAction = listed.catalogAction;
                existing.workspace = listed.workspace;
            }
            continue;
        }
        runs.push(listed);
    }

    const content = runs.length
        ? runs.map(({ run, catalogAction, catalogOnly, workspace }) => {
            const nextAction = catalogAction ?? (run.status === "waiting_for_parent" || run.status === "interrupted"
                ? `resume with guidance using runId=${JSON.stringify(run.runId)}`
                : run.status === "completed" || run.status === "failed" || run.status === "aborted" || run.status === "canceled"
                    ? `collect with runId=${JSON.stringify(run.runId)}`
                    : BACKGROUND_AGENT_WAIT_GUIDANCE);
            const catalogNote = workspace
                ? `\n  Workspace: ${JSON.stringify(workspace.slug)} · ${JSON.stringify(workspace.worktreePath)}`
                : "";
            return `- ${JSON.stringify(run.runId)} · ${JSON.stringify(run.title)} · ${run.agent} · ${run.status}${catalogOnly ? " · catalog-only workspace blocker" : ""}\n  Task: ${JSON.stringify(run.task)}${catalogNote}\n  Next: ${nextAction}`;
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
    // Params may be partial when validation rejects a malformed call, so keep
    // every access optional.
    const task = isNewRun ? (params.task ?? "") : "";
    return {
        content: `Agent action failed: ${message}`,
        details: {
            runId,
            title: isNewRun ? deriveAgentTitle(task, params.title) : "Agent action",
            agent: isNewRun ? (params.agent ?? "unknown") : "unknown",
            status: "failed",
            background: params.action === "spawn",
            task: task.slice(0, 2_000),
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
