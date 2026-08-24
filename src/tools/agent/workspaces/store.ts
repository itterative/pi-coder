import fs from "node:fs";
import path from "node:path";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import {
    WORKSPACE_VERSION,
    type AgentWorkspace,
    type AgentWorkspaceGitState,
    type AgentWorkspaceResult,
    type WorkspaceLeaseKind,
    type WorkspaceLeaseState,
    type WorkspaceResultStatus,
    type WorkspaceSetupState,
    type WorkspaceStatus,
} from "../contracts/workspaces";
import {
    openAgentMetadataDatabase as openDatabase,
    type AgentMetadataDatabase as WorkspaceDatabase,
} from "../storage/metadata";
import { git } from "./git";

export const MAX_AGENT_WORKSPACES = 3;

type WorkspaceRow = Record<string, unknown>;

function rowToWorkspace(row: WorkspaceRow): AgentWorkspace | undefined {
    const setupState = row.setup_state;
    if (
        row.version !== WORKSPACE_VERSION
        || typeof row.id !== "string"
        || typeof row.cwd !== "string"
        || typeof row.repository_root !== "string"
        || typeof row.worktree_path !== "string"
        || typeof row.slug !== "string"
        || typeof row.base_revision !== "string"
        || !["not_started", "running", "ready", "skipped", "failed"].includes(setupState as string)
        || !["available", "review_required"].includes(row.workspace_status as string)
        || typeof row.created_at !== "number"
        || typeof row.updated_at !== "number"
    ) return undefined;
    return {
        version: WORKSPACE_VERSION,
        id: row.id,
        cwd: row.cwd,
        repositoryRoot: row.repository_root,
        worktreePath: row.worktree_path,
        slug: row.slug,
        baseRevision: row.base_revision,
        setupState: setupState as WorkspaceSetupState,
        setupSummary: typeof row.setup_summary === "string" ? row.setup_summary.slice(0, 8_000) : undefined,
        status: row.workspace_status as WorkspaceStatus,
        ...(typeof row.lease_owner_session_id === "string" ? { leaseOwnerSessionId: row.lease_owner_session_id } : {}),
        ...(typeof row.lease_run_id === "string" ? { leaseRunId: row.lease_run_id } : {}),
        ...(["setup", "task"].includes(row.lease_kind as string)
            ? { leaseKind: row.lease_kind as WorkspaceLeaseKind }
            : {}),
        ...(typeof row.lease_acquired_at === "number" ? { leaseAcquiredAt: row.lease_acquired_at } : {}),
        leaseState: typeof row.lease_run_id === "string"
            ? (row.lease_kind === "setup" ? "setup" : "unknown")
            : "none",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToWorkspaceResult(row: WorkspaceRow): AgentWorkspaceResult | undefined {
    let commits: unknown;
    try {
        commits = typeof row.commits_json === "string" ? JSON.parse(row.commits_json) : undefined;
    } catch {
        commits = undefined;
    }
    if (
        typeof row.id !== "string"
        || typeof row.workspace_id !== "string"
        || typeof row.run_id !== "string"
        || typeof row.base_revision !== "string"
        || typeof row.worker_head !== "string"
        || typeof row.commit_range !== "string"
        || !Array.isArray(commits)
        || !commits.every((commit): commit is string => typeof commit === "string")
        || typeof row.prepared_at !== "number"
        || !["prepared", "applied", "discarded"].includes(row.status as string)
    ) return undefined;
    return {
        id: row.id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        baseRevision: row.base_revision,
        workerHead: row.worker_head,
        commitRange: row.commit_range,
        commits,
        ...(typeof row.durable_ref === "string" ? { durableRef: row.durable_ref } : {}),
        preparedAt: row.prepared_at,
        status: row.status as WorkspaceResultStatus,
        ...(typeof row.parent_revision === "string" ? { parentRevision: row.parent_revision } : {}),
        ...(typeof row.applied_at === "number" ? { appliedAt: row.applied_at } : {}),
    };
}

function workspaceResultById(database: WorkspaceDatabase, resultId: string): AgentWorkspaceResult | undefined {
    const row = database.prepare(`
        SELECT id, workspace_id, run_id, base_revision, worker_head, commit_range,
               commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
        FROM workspace_results
        WHERE id = ?
    `).get(resultId) as WorkspaceRow | undefined;
    return row ? rowToWorkspaceResult(row) : undefined;
}

function latestWorkspaceResult(database: WorkspaceDatabase, workspaceId: string): AgentWorkspaceResult | undefined {
    const row = database.prepare(`
        SELECT id, workspace_id, run_id, base_revision, worker_head, commit_range,
               commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
        FROM workspace_results
        WHERE workspace_id = ?
        ORDER BY prepared_at DESC, id DESC
        LIMIT 1
    `).get(workspaceId) as WorkspaceRow | undefined;
    return row ? rowToWorkspaceResult(row) : undefined;
}

export function workspaceLeaseState(database: WorkspaceDatabase, workspace: AgentWorkspace): WorkspaceLeaseState {
    if (!workspace.leaseRunId) return "none";
    if (workspace.leaseKind === "setup") return "setup";
    if (!workspace.leaseOwnerSessionId) return "unknown";
    const row = database.prepare(`
        SELECT status FROM agent_runs
        WHERE owner_session_id = ? AND run_id = ?
    `).get(workspace.leaseOwnerSessionId, workspace.leaseRunId) as WorkspaceRow | undefined;
    if (!row || typeof row.status !== "string") return "orphaned";
    // A terminal run can still own a prepared result awaiting explicit
    // disposition. Presence in the catalog means the lease is known; only a
    // missing catalog row is orphaned.
    return "known";
}

export function attachLatestWorkspaceResult(
    database: WorkspaceDatabase,
    workspace: AgentWorkspace | undefined,
): AgentWorkspace | undefined {
    if (!workspace) return undefined;
    const latestResult = latestWorkspaceResult(database, workspace.id);
    return {
        ...workspace,
        leaseState: workspaceLeaseState(database, workspace),
        ...(latestResult ? { latestResult } : {}),
    };
}

export async function workspaceForLease(
    workspaceId: string,
    ownerSessionId: string,
    leaseRunId: string,
    workspacesDir: string,
): Promise<{ database: WorkspaceDatabase; workspace: AgentWorkspace }> {
    const database = await openDatabase(workspacesDir);
    const workspace = attachLatestWorkspaceResult(database, workspaceById(database, workspaceId));
    if (!workspace || workspace.leaseOwnerSessionId !== ownerSessionId || workspace.leaseRunId !== leaseRunId) {
        database.close();
        throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
    }
    return { database, workspace };
}

export async function getAgentWorkspace(
    workspaceId: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace | undefined> {
    const database = await openDatabase(workspacesDir);
    try {
        return attachLatestWorkspaceResult(database, workspaceById(database, workspaceId));
    } finally {
        database.close();
    }
}

export async function inspectAgentWorkspaceGitState(workspace: AgentWorkspace): Promise<AgentWorkspaceGitState> {
    try {
        const [statusOutput, headRevision] = await Promise.all([
            git(workspace.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
            git(workspace.worktreePath, ["rev-parse", "HEAD"]),
        ]);
        const lines = statusOutput ? statusOutput.split("\n").filter(Boolean) : [];
        let stagedFiles = 0;
        let unstagedFiles = 0;
        let untrackedFiles = 0;
        for (const line of lines) {
            const indexStatus = line[0];
            const worktreeStatus = line[1];
            if (indexStatus === "?" && worktreeStatus === "?") {
                untrackedFiles++;
                continue;
            }
            if (indexStatus !== " ") stagedFiles++;
            if (worktreeStatus !== " ") unstagedFiles++;
        }
        return {
            kind: "available",
            dirty: lines.length > 0,
            changedFiles: lines.length,
            stagedFiles,
            unstagedFiles,
            untrackedFiles,
            headRevision,
        };
    } catch (error) {
        return {
            kind: "unavailable",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function listAgentWorkspaces(
    cwd: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace[]> {
    const database = await openDatabase(workspacesDir);
    try {
        const rows = database.prepare(`
            SELECT version, id, cwd, repository_root, worktree_path, slug,
                   base_revision, setup_state, setup_summary, workspace_status,
                   lease_owner_session_id, lease_run_id, lease_kind, lease_acquired_at,
                   created_at, updated_at
            FROM workspaces
            WHERE cwd = ?
            ORDER BY created_at ASC, slug ASC
        `).all(path.resolve(cwd)) as WorkspaceRow[];
        return rows
            .map(rowToWorkspace)
            .filter((workspace): workspace is AgentWorkspace => workspace !== undefined)
            .map((workspace) => attachLatestWorkspaceResult(database, workspace)!)
            .filter((workspace) => fs.existsSync(workspace.worktreePath));
    } finally {
        database.close();
    }
}

export async function findAvailableAgentWorkspace(
    cwd: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace | undefined> {
    return (await listAgentWorkspaces(cwd, workspacesDir))
        .find((workspace) => (
            workspace.status === "available"
            && !workspace.leaseRunId
            && (workspace.setupState === "ready" || workspace.setupState === "skipped")
        ));
}

export async function findUnpreparedAgentWorkspace(
    cwd: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace | undefined> {
    return (await listAgentWorkspaces(cwd, workspacesDir))
        .find((workspace) => (
            !workspace.leaseRunId
            && (workspace.setupState === "not_started" || workspace.setupState === "failed")
        ));
}

export async function listAgentWorkspaceResults(
    workspaceId: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspaceResult[]> {
    const database = await openDatabase(workspacesDir);
    try {
        const rows = database.prepare(`
            SELECT id, workspace_id, run_id, base_revision, worker_head, commit_range,
                   commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
            FROM workspace_results
            WHERE workspace_id = ?
            ORDER BY prepared_at ASC, id ASC
        `).all(workspaceId) as WorkspaceRow[];
        return rows
            .map(rowToWorkspaceResult)
            .filter((result): result is AgentWorkspaceResult => result !== undefined);
    } finally {
        database.close();
    }
}

export function workspaceById(database: WorkspaceDatabase, id: string): AgentWorkspace | undefined {
    const row = database.prepare(`
        SELECT version, id, cwd, repository_root, worktree_path, slug,
               base_revision, setup_state, setup_summary, workspace_status,
               lease_owner_session_id, lease_run_id, lease_kind, lease_acquired_at,
               created_at, updated_at
        FROM workspaces
        WHERE id = ?
    `).get(id) as WorkspaceRow | undefined;
    return attachLatestWorkspaceResult(database, row ? rowToWorkspace(row) : undefined);
}

function rollback(database: WorkspaceDatabase): void {
    try {
        database.exec("ROLLBACK");
    } catch {
        // Preserve the original operation error.
    }
}

export async function claimAgentWorkspace(
    workspaceId: string,
    ownerSessionId: string,
    leaseRunId: string,
    leaseKind: WorkspaceLeaseKind,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        database.exec("BEGIN IMMEDIATE");
        const result = database.prepare(`
            UPDATE workspaces
            SET lease_owner_session_id = ?, lease_run_id = ?, lease_kind = ?, lease_acquired_at = ?
            WHERE id = ? AND workspace_status = 'available' AND lease_run_id IS NULL
        `).run(ownerSessionId, leaseRunId, leaseKind, Date.now(), workspaceId);
        if (Number(result.changes) !== 1) {
            rollback(database);
            throw new Error(`Workspace ${workspaceId} is no longer available.`);
        }
        const workspace = workspaceById(database, workspaceId);
        if (!workspace) {
            rollback(database);
            throw new Error(`Workspace ${workspaceId} disappeared while being claimed.`);
        }
        database.exec("COMMIT");
        return workspace;
    } catch (error) {
        rollback(database);
        throw error;
    } finally {
        database.close();
    }
}

export async function transferAgentWorkspaceLease(
    workspaceId: string,
    ownerSessionId: string,
    fromLeaseRunId: string,
    toLeaseRunId: string,
    leaseKind: WorkspaceLeaseKind = "task",
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<void> {
    const database = await openDatabase(workspacesDir);
    try {
        database.exec("BEGIN IMMEDIATE");
        const result = database.prepare(`
            UPDATE workspaces
            SET lease_run_id = ?, lease_kind = ?, lease_acquired_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(toLeaseRunId, leaseKind, Date.now(), workspaceId, ownerSessionId, fromLeaseRunId);
        if (Number(result.changes) !== 1) {
            rollback(database);
            throw new Error(`Workspace ${workspaceId} lease could not be transferred.`);
        }
        database.exec("COMMIT");
    } catch (error) {
        rollback(database);
        throw error;
    } finally {
        database.close();
    }
}

export async function releaseAgentWorkspaceLease(
    workspaceId: string,
    ownerSessionId: string,
    leaseRunId: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<void> {
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = workspaceById(database, workspaceId);
        if (workspace?.leaseOwnerSessionId !== ownerSessionId || workspace.leaseRunId !== leaseRunId) {
            throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
        }
        if (workspace.leaseKind === "task" && workspace.latestResult?.status !== "applied") {
            throw new Error(`Workspace ${workspaceId} can be released only after successful application.`);
        }
        database.prepare(`
            UPDATE workspaces
            SET lease_owner_session_id = NULL, lease_run_id = NULL,
                lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(Date.now(), workspaceId, ownerSessionId, leaseRunId);
    } finally {
        database.close();
    }
}

