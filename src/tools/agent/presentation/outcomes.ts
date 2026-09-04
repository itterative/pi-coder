import fs from "node:fs";

import type { Usage } from "@earendil-works/pi-ai";

import { AgentRunManager, BACKGROUND_AGENT_WAIT_GUIDANCE, deriveAgentTitle } from "../runs/manager";
import { cloneUsage, ZERO_USAGE } from "../runs/usage";
import { isAgentTerminalStatus } from "../contracts/runs";
import type {
    AgentRunDetails,
    AgentRunOutcome,
    AgentRunStatus,
    AgentRunSummary,
} from "../contracts/runs";
import type { AgentParameters } from "../definitions/prompt";
import type { AgentWorkspace, AgentWorkspaceResult } from "../contracts/workspaces";

/**
 * A fresh zero-usage frame. Goes through the shared clone so no frame can reach the module-level
 * `ZERO_USAGE` objects, which every run in the process clones from.
 */
function zeroUsage(): Usage {
    return cloneUsage(ZERO_USAGE);
}

/**
 * One row of the listing: a live run, or a run the durable catalog implies but no manager holds.
 *
 * `catalogAction` and `catalogOnly` exist because a catalog row must not read like a collectable or
 * continuable run, and `workspace` carries the note that says which checkout is involved.
 */
interface ListedRun {
    run: AgentRunSummary;
    catalogAction?: string;
    catalogOnly?: boolean;
    workspace?: AgentWorkspace;
}

/**
 * What makes one catalog workspace unavailable, computed once per workspace.
 *
 * `result` and `blockingResult` are deliberately different: the *raw* latest result decides whether
 * a row counts as finished and whether the workspace has any result at all, while only a prepared
 * result — or any result while the workspace awaits review — actually holds the workspace open and
 * gets a row of its own. Collapsing the two would label a released result as a live blocker.
 */
interface WorkspaceBlocker {
    workspace: AgentWorkspace;
    result?: AgentWorkspaceResult;
    /** The result that keeps this workspace out of reuse: prepared, or any result under review. */
    blockingResult?: AgentWorkspaceResult;
    needsReview: boolean;
    missingWorktree: boolean;
}

/** Catalog workspaces the manager no longer runs, but which still occupy a worker slot. */
function unavailableBlockers(workspaces: readonly AgentWorkspace[]): WorkspaceBlocker[] {
    const blockers: WorkspaceBlocker[] = [];
    for (const workspace of workspaces) {
        const result = workspace.latestResult;
        const needsReview = workspace.status === "review_required";
        const blockingResult =
            result && (result.status === "prepared" || needsReview) ? result : undefined;
        const missingWorktree = !fs.existsSync(workspace.worktreePath);
        if (!workspace.leaseRunId && !blockingResult && !missingWorktree) {
            continue;
        }

        blockers.push({ workspace, result, blockingResult, needsReview, missingWorktree });
    }
    return blockers;
}

/**
 * The runs a blocker implicates, in listing order.
 *
 * A lease and a blocking result can name the same run, which is why the pair is de-duplicated rather
 * than rendered as two rows for one workspace.
 */
function blockedRunIds(blocker: WorkspaceBlocker): string[] {
    const ids: string[] = [];
    if (blocker.workspace.leaseRunId) {
        ids.push(blocker.workspace.leaseRunId);
    }
    if (blocker.blockingResult) {
        ids.push(blocker.blockingResult.runId);
    }
    // Nothing else names a subject for a vanished worktree, so the workspace itself stands in.
    if (ids.length === 0 && blocker.missingWorktree) {
        ids.push(`workspace-${blocker.workspace.id}`);
    }
    return [...new Set(ids)];
}

/** What the listing calls the run behind a blocker. */
function blockerAgent(blocker: WorkspaceBlocker, hasResult: boolean): string {
    // A setup lease that produced no result of its own never ran a task, so it must not be presented
    // as a worker; `mutating` follows this label.
    if (blocker.workspace.leaseKind === "setup" && !hasResult) {
        return "workspace-setup";
    }
    // A vanished worktree with neither lease nor result is a catalog bookkeeping gap, not a run.
    // Reading the raw result here is what distinguishes it from the synthetic id in `blockedRunIds`.
    if (blocker.missingWorktree && !blocker.workspace.leaseRunId && !blocker.result) {
        return "workspace-registry";
    }
    return "worker";
}

/** Whether the run behind a blocker reached an end state or stopped short of one. */
function blockerStatus(blocker: WorkspaceBlocker, hasResult: boolean): AgentRunStatus {
    return hasResult || blocker.needsReview ? "completed" : "interrupted";
}

/**
 * How to clear the workspace, which is never `continue` or `collect`: the manager holds no run to
 * drive, so the parent has to resolve the catalog state in `/agents` first.
 */
function blockedRunGuidance(blocker: WorkspaceBlocker): string {
    const slug = JSON.stringify(blocker.workspace.slug);
    if (blocker.missingWorktree) {
        return `inspect workspace ${slug} in /agents; its worktree is missing and may be consuming workspace capacity`;
    }
    const prepared = blocker.result?.status === "prepared" ? blocker.result : undefined;
    if (prepared) {
        return `review workspace ${slug} and prepared result ${JSON.stringify(prepared.id)} in /agents; apply, retain, reset, or discard it before reusing the workspace`;
    }
    if (blocker.needsReview) {
        return `inspect workspace ${slug} in /agents and review it before reusing the workspace`;
    }
    return `inspect workspace ${slug} in /agents; this catalog-only run is unavailable, so do not continue or collect it until the workspace state is confirmed`;
}

function listedBlocker(blocker: WorkspaceBlocker, runId: string): ListedRun {
    const { workspace } = blocker;
    const hasResult = blocker.result?.runId === runId;
    const agent = blockerAgent(blocker, hasResult);

    return {
        run: {
            runId,
            title: `Isolated workspace blocker · ${workspace.slug}`,
            agent,
            status: blockerStatus(blocker, hasResult),
            background: false,
            task: `Catalog-only isolated workspace blocker for ${workspace.slug}`,
            startedAt: workspace.leaseAcquiredAt ?? workspace.createdAt,
            updatedAt: workspace.updatedAt,
            usage: zeroUsage(),
            mutating: agent !== "workspace-setup",
            workspaceId: workspace.id,
        },
        catalogAction: blockedRunGuidance(blocker),
        catalogOnly: true,
        workspace,
    };
}

function listedBlockerRuns(workspaces: readonly AgentWorkspace[]): ListedRun[] {
    return unavailableBlockers(workspaces).flatMap((blocker) =>
        blockedRunIds(blocker).map((runId) => listedBlocker(blocker, runId)),
    );
}

/**
 * Fold catalog blockers into the runs the manager reports.
 *
 * Matching on the `runId`/`workspaceId` pair is what keeps a same-named same-checkout run from being
 * mistaken for an isolated one. A match is annotated rather than duplicated only when a result or a
 * review status holds the workspace: a bare lease is not evidence about the live run, so the blocker
 * keeps its own row and the live row keeps its own guidance.
 */
function withWorkspaceBlockers(
    listed: ListedRun[],
    workspaces: readonly AgentWorkspace[],
): ListedRun[] {
    for (const blocker of listedBlockerRuns(workspaces)) {
        const live = listed.find(
            (candidate) =>
                candidate.run.runId === blocker.run.runId &&
                candidate.run.workspaceId === blocker.run.workspaceId,
        );
        if (!live) {
            listed.push(blocker);
            continue;
        }
        const heldByResult =
            blocker.workspace?.latestResult?.status === "prepared" ||
            blocker.workspace?.status === "review_required";
        if (!heldByResult) {
            continue;
        }
        live.catalogAction = blocker.catalogAction;
        live.workspace = blocker.workspace;
    }
    return listed;
}

/** What to do with a run next, derived from the state the manager reports for it. */
function runGuidance(run: AgentRunSummary): string {
    if (run.status === "waiting_for_parent" || run.status === "interrupted") {
        return `continue with guidance using runId=${JSON.stringify(run.runId)}`;
    }
    if (isAgentTerminalStatus(run.status)) {
        return `collect with runId=${JSON.stringify(run.runId)}`;
    }
    // Still in flight: `starting`, `running`, and `waiting_for_permission` are all reported by the
    // mailbox rather than by an explicit action, so nothing is asked of the parent here.
    return BACKGROUND_AGENT_WAIT_GUIDANCE;
}

function runLine({ run, catalogAction, catalogOnly, workspace }: ListedRun): string {
    const note = workspace
        ? `\n  Workspace: ${JSON.stringify(workspace.slug)} · ${JSON.stringify(workspace.worktreePath)}`
        : "";
    const marker = catalogOnly ? " · catalog-only workspace blocker" : "";
    return `- ${JSON.stringify(run.runId)} · ${JSON.stringify(run.title)} · ${run.agent} · ${run.status}${marker}\n  Task: ${JSON.stringify(run.task)}${note}\n  Next: ${catalogAction ?? runGuidance(run)}`;
}

export function listOutcome(
    manager: AgentRunManager,
    workspaces: readonly AgentWorkspace[] = [],
): AgentRunOutcome {
    const listed = withWorkspaceBlockers(
        manager.listRuns().map((run) => ({ run })),
        workspaces,
    );
    const now = Date.now();

    return {
        content: listed.length
            ? listed.map(runLine).join("\n")
            : "No delegated agent runs are currently tracked.",
        details: {
            runId: "list",
            title: "Delegated agent runs",
            agent: "runtime",
            status: "completed",
            background: false,
            task: "List delegated agent runs",
            recentActivity: [],
            usage: zeroUsage(),
            startedAt: now,
            updatedAt: now,
        },
        usage: zeroUsage(),
        isError: false,
    };
}

export function failedOutcome(params: AgentParameters, error: unknown): AgentRunOutcome {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    const isNewRun = params.action === "start";
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
            background: params.action === "start" && params.background === true,
            task: task.slice(0, 2_000),
            recentActivity: [],
            usage: zeroUsage(),
            startedAt: now,
            updatedAt: now,
            error: message,
        },
        usage: zeroUsage(),
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
