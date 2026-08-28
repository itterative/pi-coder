import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import type { AgentWorkspace, AgentWorkspaceResult } from "../contracts/workspaces";
import { openAgentMetadataDatabase as openDatabase } from "../storage/metadata";
import { git, gitRaw, hasAncestor } from "./git";
import {
    inspectAgentWorkspaceGitState,
    listAgentWorkspaces,
    workspaceById,
    workspaceForLease,
    type AgentWorkspaceDirectoryOptions,
    type AgentWorkspaceLeaseOptions,
} from "./store";

const FINAL_RESULT_COMMIT_MESSAGE = "pi-coder: finalize isolated worker result";
const RESULT_REF_PREFIX = "refs/pi-coder/workspace-results";

function requireMatchingWorkspaceResult(
    workspace: AgentWorkspace,
    { leaseRunId, leaseRunInstanceId }: AgentWorkspaceLeaseOptions,
): AgentWorkspaceResult {
    const result = workspace.latestResult;
    if (
        !result
        || result.runId !== leaseRunId
        || (workspace.leaseRunInstanceId !== undefined && result.runInstanceId !== leaseRunInstanceId)
    ) {
        throw new Error(`Workspace ${workspace.id} has no result for run ${leaseRunId}.`);
    }
    return result;
}

async function resetReusableWorkspace(workspace: AgentWorkspace, targetRevision?: string): Promise<string> {
    const revision = targetRevision ?? await git(workspace.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(workspace.worktreePath, ["reset", "--hard", revision]);
    await git(workspace.worktreePath, ["clean", "-fd"]);
    return revision;
}

/** Finalize the isolated worker tree for an explicit apply request. */
export async function prepareAgentWorkspaceApplication(
    workspace: AgentWorkspace,
    options: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspaceResult> {
    const { ownerSessionId, leaseRunId, leaseRunInstanceId } = options;
    const { database, workspace: current } = await workspaceForLease(workspace.id, options);
    let durableRef: string | undefined;
    try {
        if (current.leaseKind !== "task") throw new Error(`Workspace ${workspace.id} does not have a task lease.`);
        if (current.baseRevision !== workspace.baseRevision) throw new Error(`Workspace ${workspace.id} base revision changed while it was leased.`);
        const state = await inspectAgentWorkspaceGitState(current);
        if (state.kind !== "available") throw new Error(state.error ?? "Workspace Git state is unavailable.");
        if (state.dirty) {
            await git(current.worktreePath, ["add", "-A"]);
            await git(current.worktreePath, ["commit", "--no-verify", "-m", FINAL_RESULT_COMMIT_MESSAGE]);
        }
        const workerHead = await git(current.worktreePath, ["rev-parse", "HEAD"]);
        if (!(await hasAncestor(current.worktreePath, current.baseRevision, workerHead))) {
            throw new Error(`Worker revision ${workerHead} is not based on workspace base ${current.baseRevision}.`);
        }
        const commitsOutput = await git(current.worktreePath, ["rev-list", "--reverse", `${current.baseRevision}..${workerHead}`]);
        const commits = commitsOutput ? commitsOutput.split("\n").filter(Boolean) : [];
        const resultId = randomUUID();
        if (workerHead !== current.baseRevision || commits.length > 0) {
            durableRef = `${RESULT_REF_PREFIX}/${current.id}/${resultId}`;
            await git(current.worktreePath, ["update-ref", durableRef, workerHead]);
        }
        const result: AgentWorkspaceResult = {
            id: resultId,
            workspaceId: current.id,
            runId: leaseRunId,
            ...(current.leaseRunInstanceId ?? leaseRunInstanceId
                ? { runInstanceId: current.leaseRunInstanceId ?? leaseRunInstanceId }
                : {}),
            baseRevision: current.baseRevision,
            workerHead,
            commitRange: `${current.baseRevision}..${workerHead}`,
            commits,
            ...(durableRef ? { durableRef } : {}),
            preparedAt: Date.now(),
            status: "prepared",
        };
        database.prepare(`
            INSERT INTO workspace_results (
                id, workspace_id, run_id, run_instance_id, base_revision, worker_head, commit_range,
                commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(result.id, result.workspaceId, result.runId, result.runInstanceId ?? null, result.baseRevision, result.workerHead,
            result.commitRange, JSON.stringify(result.commits), result.durableRef ?? null, result.preparedAt, result.status);
        return result;
    } catch (error) {
        if (durableRef) await git(current.worktreePath, ["update-ref", "-d", durableRef]).catch(() => {});
        throw error;
    } finally {
        database.close();
    }
}

/** Apply a prepared worker tree to its parent checkout without creating a parent commit. */
export async function applyAgentWorkspaceApplication(
    workspace: AgentWorkspace,
    options: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspaceResult> {
    const { leaseRunId, leaseRunInstanceId } = options;
    const { database, workspace: current } = await workspaceForLease(workspace.id, options);
    try {
        if (current.leaseKind !== "task") throw new Error(`Workspace ${current.id} does not have a task lease.`);
        const result = requireMatchingWorkspaceResult(current, options);
        if (result.status === "applied") return result;
        const workerHead = await git(current.worktreePath, ["rev-parse", "HEAD"]);
        const workerState = await inspectAgentWorkspaceGitState(current);
        if (workerState.kind !== "available" || workerState.dirty || workerHead !== result.workerHead) {
            throw new Error("The isolated workspace changed after application preparation; prepare it again.");
        }
        if (!(await hasAncestor(current.worktreePath, result.baseRevision, result.workerHead))) {
            throw new Error("The prepared worker revision is no longer based on the workspace base revision.");
        }
        const parentRevision = await git(current.repositoryRoot, ["rev-parse", "HEAD"]);
        if (!(await hasAncestor(current.repositoryRoot, result.baseRevision, parentRevision))) {
            throw new Error(`Parent checkout at ${parentRevision} no longer contains workspace base ${result.baseRevision}.`);
        }
        const parentStatus = await git(current.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
        if (parentStatus) throw new Error("Parent checkout has uncommitted changes; apply requires a clean checkout.");
        const patch = await gitRaw(current.worktreePath, ["diff", "--binary", "--no-ext-diff", `${result.baseRevision}..${result.workerHead}`]);
        const patchPath = path.join(os.tmpdir(), `pi-coder-apply-${randomUUID()}.patch`);
        try {
            fs.writeFileSync(patchPath, patch, { mode: 0o600 });
            if (patch) {
                await git(current.repositoryRoot, ["apply", "--check", "--binary", patchPath]);
                await git(current.repositoryRoot, ["apply", "--binary", patchPath]);
            }
        } finally {
            fs.rmSync(patchPath, { force: true });
        }
        const appliedAt = Date.now();
        database.prepare(`
            UPDATE workspace_results SET status = 'applied', parent_revision = ?, applied_at = ?
            WHERE id = ? AND workspace_id = ?
        `).run(parentRevision, appliedAt, result.id, current.id);
        return { ...result, status: "applied", parentRevision, appliedAt };
    } finally {
        database.close();
    }
}

/** Retain a changed prepared result for later review without applying it. */
export async function retainAgentWorkspaceResult(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const { ownerSessionId, leaseRunId, leaseRunInstanceId } = options;
    const { database, workspace } = await workspaceForLease(workspaceId, options);
    try {
        const result = workspace.latestResult && requireMatchingWorkspaceResult(workspace, options);
        if (workspace.leaseKind !== "task" || !result || result.status !== "prepared" || result.commits.length === 0) {
            throw new Error(`Workspace ${workspaceId} has no changed prepared result to retain.`);
        }
        const state = await inspectAgentWorkspaceGitState(workspace);
        const head = state.kind === "available" ? state.headRevision : undefined;
        if (state.kind !== "available" || state.dirty || head !== result.workerHead) {
            throw new Error(`Workspace ${workspaceId} changed after its result was prepared.`);
        }
        database.prepare(`
            UPDATE workspaces SET workspace_status = 'review_required', lease_owner_session_id = NULL,
                lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `).run(Date.now(), workspaceId, ownerSessionId, leaseRunId, leaseRunInstanceId ?? null, leaseRunInstanceId ?? null);
    } finally {
        database.close();
    }
}

/** Discard a prepared result and make its existing isolated workspace reusable. */
export async function discardAgentWorkspaceResult(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const { ownerSessionId, leaseRunId, leaseRunInstanceId } = options;
    const { database, workspace } = await workspaceForLease(workspaceId, options);
    try {
        if (workspace.leaseKind !== "task") {
            throw new Error(`Workspace ${workspaceId} has no prepared result to discard.`);
        }
        const result = requireMatchingWorkspaceResult(workspace, options);
        if (result.status !== "prepared") {
            throw new Error(`Workspace ${workspaceId} has no prepared result to discard.`);
        }
        const state = await inspectAgentWorkspaceGitState(workspace);
        if (state.kind !== "available" || state.dirty || state.headRevision !== result.workerHead) {
            throw new Error(`Workspace ${workspaceId} changed after its result was prepared; inspect it before discarding.`);
        }
        // Rebase the reusable worktree to the current parent HEAD, not the
        // discarded result's historical base. Otherwise a later isolated
        // worker can run against stale source after the parent advances.
        const targetRevision = await resetReusableWorkspace(workspace);
        if (result.durableRef) {
            await git(workspace.repositoryRoot, ["update-ref", "-d", result.durableRef]);
        }
        const updatedAt = Date.now();
        database.prepare("UPDATE workspace_results SET status = 'discarded', durable_ref = NULL WHERE id = ? AND workspace_id = ?")
            .run(result.id, workspaceId);
        database.prepare(`
            UPDATE workspaces SET workspace_status = 'available', base_revision = ?,
                lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL,
                lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `).run(targetRevision, updatedAt, workspaceId, ownerSessionId, leaseRunId, leaseRunInstanceId ?? null, leaseRunInstanceId ?? null);
    } finally {
        database.close();
    }
}

/** Release a task lease only after its prepared result was applied successfully. */
export async function releaseAgentWorkspaceAfterApplication(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const { ownerSessionId, leaseRunId, workspacesDir = PI_CODER_WORKSPACES_DIR, leaseRunInstanceId } = options;
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = workspaceById(database, workspaceId);
        if (
            workspace?.leaseOwnerSessionId !== ownerSessionId
            || workspace.leaseRunId !== leaseRunId
            || (workspace.leaseRunInstanceId !== undefined && workspace.leaseRunInstanceId !== leaseRunInstanceId)
        ) {
            throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
        }
        const result = requireMatchingWorkspaceResult(workspace, options);
        if (workspace.leaseKind !== "task" || result.status !== "applied") {
            throw new Error(`Workspace ${workspaceId} can be released only after successful application.`);
        }
        database.prepare(`
            UPDATE workspaces SET workspace_status = 'review_required', lease_owner_session_id = NULL,
                lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `).run(Date.now(), workspaceId, ownerSessionId, leaseRunId, leaseRunInstanceId ?? null, leaseRunInstanceId ?? null);
    } finally {
        database.close();
    }
}

/** Release a task lease when the worker produced no changes, making the clean workspace reusable. */
export async function releaseAgentWorkspaceAfterNoChanges(
    workspaceId: string,
    options: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const { ownerSessionId, leaseRunId, workspacesDir = PI_CODER_WORKSPACES_DIR, leaseRunInstanceId } = options;
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = workspaceById(database, workspaceId);
        if (
            workspace?.leaseOwnerSessionId !== ownerSessionId
            || workspace.leaseRunId !== leaseRunId
            || (workspace.leaseRunInstanceId !== undefined && workspace.leaseRunInstanceId !== leaseRunInstanceId)
        ) {
            throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
        }
        const result = requireMatchingWorkspaceResult(workspace, options);
        if (
            workspace.leaseKind !== "task"
            || result.status !== "prepared"
            || result.baseRevision !== result.workerHead
            || result.commits.length > 0
        ) {
            throw new Error(`Workspace ${workspaceId} can be released without application only when its prepared result has no changes.`);
        }
        const state = await inspectAgentWorkspaceGitState(workspace);
        if (state.kind !== "available" || state.dirty || state.headRevision !== result.baseRevision) {
            throw new Error(`Workspace ${workspaceId} changed after its no-change result was prepared.`);
        }
        const targetRevision = await resetReusableWorkspace(workspace);
        if (result.durableRef) {
            await git(workspace.worktreePath, ["update-ref", "-d", result.durableRef]);
        }
        database.prepare("UPDATE workspace_results SET status = 'discarded', durable_ref = NULL WHERE id = ? AND workspace_id = ?")
            .run(result.id, workspaceId);
        database.prepare(`
            UPDATE workspaces SET workspace_status = 'available', base_revision = ?,
                lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL,
                lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `).run(targetRevision, Date.now(), workspaceId, ownerSessionId, leaseRunId, leaseRunInstanceId ?? null, leaseRunInstanceId ?? null);
    } finally {
        database.close();
    }
}

/** Inspect a prepared workspace result without returning its full patch. */
export async function inspectAgentWorkspaceResult(workspace: AgentWorkspace): Promise<string> {
    const result = workspace.latestResult;
    if (!result || result.status === "discarded") return "No saved worker result is available for this workspace.";
    if (result.baseRevision === result.workerHead) return "No changes: the worker revision matches the workspace base revision.";
    const stat = await git(workspace.worktreePath, ["diff", "--stat", "--no-ext-diff", `${result.baseRevision}..${result.workerHead}`]);
    const commits = result.commits.length > 0 ? result.commits.join(", ") : "none";
    return [
        `Workspace: ${workspace.slug}`,
        `Base revision: ${result.baseRevision}`,
        `Worker revision: ${result.workerHead}`,
        `Commit range: ${result.commitRange}`,
        `Commits: ${commits}`,
        `Durable ref: ${result.durableRef ?? "none"}`,
        "",
        "Changed files:",
        stat || "(none)",
    ].join("\n");
}

/** Reconcile previously collected no-change results from before automatic release existed. */
export async function reconcileNoChangeAgentWorkspaceLeases(
    cwd: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<number> {
    const workspaces = await listAgentWorkspaces(cwd, { workspacesDir });
    let released = 0;
    for (const workspace of workspaces) {
        if (
            workspace.leaseKind !== "task"
            || !workspace.leaseOwnerSessionId
            || !workspace.leaseRunId
            || workspace.latestResult?.status !== "prepared"
            || workspace.latestResult.runId !== workspace.leaseRunId
            || (workspace.leaseRunInstanceId !== undefined
                && workspace.latestResult.runInstanceId !== workspace.leaseRunInstanceId)
            || workspace.latestResult.baseRevision !== workspace.latestResult.workerHead
            || workspace.latestResult.commits.length > 0
        ) continue;
        try {
            await releaseAgentWorkspaceAfterNoChanges(workspace.id, {
                ownerSessionId: workspace.leaseOwnerSessionId,
                leaseRunId: workspace.leaseRunId,
                workspacesDir,
                leaseRunInstanceId: workspace.leaseRunInstanceId,
            });
            released++;
        } catch {
            // Leave a changed or otherwise unsafe workspace leased for explicit recovery.
        }
    }
    return released;
}

