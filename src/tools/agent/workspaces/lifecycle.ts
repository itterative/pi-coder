import fs from "node:fs";
import path from "node:path";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import { randomSlug } from "../../../common/slug";
import { WORKSPACE_VERSION, type AgentWorkspace } from "../contracts/workspaces";
import {
    agentWorkspacesRoot as workspacesRoot,
    openAgentMetadataDatabase as openDatabase,
} from "../storage/metadata";
import { git } from "./git";
import {
    MAX_AGENT_WORKSPACES,
    attachLatestWorkspaceResult,
    workspaceById,
    workspaceLeaseActive,
    workspaceLeaseState,
    type AgentWorkspaceDirectoryOptions,
    type AgentWorkspaceLeaseControls,
} from "./store";

type WorkspaceRow = Record<string, unknown>;

function requireNoResultReservation(database: import("node:sqlite").DatabaseSync, workspaceId: string): void {
    const reservation = database.prepare(`
        SELECT id FROM workspace_results
        WHERE workspace_id = ? AND reservation_token IS NOT NULL
        LIMIT 1
    `).get(workspaceId) as WorkspaceRow | undefined;
    if (reservation) {
        throw new Error(`Workspace ${workspaceId} has a result disposition in progress; try again shortly.`);
    }
}

/** Named owner and storage controls for orphaned task lease recovery. */
export interface RecoverAgentWorkspaceLeaseOptions extends AgentWorkspaceDirectoryOptions {
    ownerSessionId: string;
}

/** Adopt an orphaned task lease into the current parent session without changing its result or worktree. */
export async function recoverAgentWorkspaceLease(
    workspaceId: string,
    { ownerSessionId, workspacesDir = PI_CODER_WORKSPACES_DIR }: RecoverAgentWorkspaceLeaseOptions,
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = attachLatestWorkspaceResult(database, workspaceById(database, workspaceId));
        if (!workspace || !workspace.leaseRunId || workspace.leaseKind !== "task") {
            throw new Error(`Workspace ${workspaceId} does not have an orphaned task lease.`);
        }
        if (workspaceLeaseState(database, workspace) !== "orphaned") {
            throw new Error(`Workspace ${workspaceId} does not have an orphaned task lease.`);
        }
        const oldOwnerSessionId = workspace.leaseOwnerSessionId;
        if (!oldOwnerSessionId) throw new Error(`Workspace ${workspaceId} has no recorded lease owner.`);
        const updated = database.prepare(`
            UPDATE workspaces
            SET lease_owner_session_id = ?, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(ownerSessionId, Date.now(), workspaceId, oldOwnerSessionId, workspace.leaseRunId);
        if (updated.changes !== 1) throw new Error(`Workspace ${workspaceId} lease changed during recovery.`);
        const recovered = attachLatestWorkspaceResult(database, workspaceById(database, workspaceId));
        if (!recovered) throw new Error(`Workspace ${workspaceId} disappeared during lease recovery.`);
        return recovered;
    } finally {
        database.close();
    }
}

/**
 * Release a stale task lease that has no prepared result.
 *
 * This is an explicit recovery action only. It never resets or cleans the
 * worktree and therefore refuses to release anything that is not exactly at
 * its recorded base revision and Git-clean.
 */
export async function releaseAgentWorkspaceLeaseForRecovery(
    workspaceId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = workspaceById(database, workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        if (workspace.leaseKind !== "task" || !workspace.leaseRunId || workspace.latestResult) {
            throw new Error(`Workspace ${workspaceId} does not have a recoverable stale task lease.`);
        }
        const status = await git(workspace.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
        if (status) {
            throw new Error(`Workspace ${workspaceId} has uncommitted or untracked changes; discard it explicitly instead.`);
        }
        const head = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
        if (head !== workspace.baseRevision) {
            throw new Error(`Workspace ${workspaceId} has committed changes beyond its base revision; discard it explicitly instead.`);
        }
        const updatedAt = Date.now();
        database.prepare(`
            UPDATE workspaces SET workspace_status = 'available',
                lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL,
                lease_acquired_at = NULL, updated_at = ? WHERE id = ?
        `).run(updatedAt, workspaceId);
        return {
            ...workspace,
            status: "available",
            leaseOwnerSessionId: undefined,
            leaseRunId: undefined,
            leaseKind: undefined,
            leaseAcquiredAt: undefined,
            updatedAt,
        };
    } finally {
        database.close();
    }
}

/**
 * Recycle an inactive task workspace into a new task lease without deleting
 * the old worker's checkpoint or result history.
 */
export interface RecycleAgentWorkspaceOptions extends AgentWorkspaceDirectoryOptions {
    previousOwnerSessionId: string;
    previousLeaseRunId: string;
    previousLeaseRunInstanceId: string;
    ownerSessionId: string;
    leaseRunId: string;
    leaseRunInstanceId: string;
}

export async function recycleAgentWorkspaceForReuse(
    workspaceId: string,
    {
        previousOwnerSessionId,
        previousLeaseRunId,
        previousLeaseRunInstanceId,
        ownerSessionId,
        leaseRunId,
        leaseRunInstanceId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
    }: RecycleAgentWorkspaceOptions,
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        database.exec("BEGIN IMMEDIATE");
        const workspace = attachLatestWorkspaceResult(database, workspaceById(database, workspaceId));
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        requireNoResultReservation(database, workspaceId);
        if (
            workspace.leaseOwnerSessionId !== previousOwnerSessionId
            || workspace.leaseRunId !== previousLeaseRunId
            || workspace.leaseRunInstanceId !== previousLeaseRunInstanceId
            || workspace.leaseKind !== "task"
        ) {
            throw new Error(`Workspace ${workspaceId} changed before it could be recycled.`);
        }
        if (workspace.status === "recycling") {
            throw new Error(`Workspace ${workspaceId} is already being recycled.`);
        }
        if (workspaceLeaseActive(database, workspace)) {
            throw new Error(`Workspace ${workspaceId} is still used by active run ${previousLeaseRunId}; finish or cancel that run first.`);
        }

        const marked = database.prepare(`
            UPDATE workspaces SET workspace_status = 'recycling', updated_at = ?
            WHERE id = ? AND workspace_status IN ('available', 'review_required')
              AND lease_owner_session_id = ? AND lease_run_id = ?
              AND lease_run_instance_id = ? AND lease_kind = 'task'
        `).run(
            Date.now(),
            workspaceId,
            previousOwnerSessionId,
            previousLeaseRunId,
            previousLeaseRunInstanceId,
        );
        if (marked.changes !== 1) {
            throw new Error(`Workspace ${workspaceId} changed before it could be recycled.`);
        }

        const targetRevision = await git(workspace.repositoryRoot, ["rev-parse", "HEAD"]);
        await git(workspace.worktreePath, ["reset", "--hard", targetRevision]);
        await git(workspace.worktreePath, ["clean", "-fd"]);

        const claimed = database.prepare(`
            UPDATE workspaces
            SET base_revision = ?, workspace_status = 'available',
                lease_owner_session_id = ?, lease_run_id = ?, lease_run_instance_id = ?,
                lease_kind = 'task', lease_acquired_at = ?, updated_at = ?
            WHERE id = ? AND workspace_status = 'recycling'
              AND lease_owner_session_id = ? AND lease_run_id = ?
              AND lease_run_instance_id = ?
        `).run(
            targetRevision,
            ownerSessionId,
            leaseRunId,
            leaseRunInstanceId,
            Date.now(),
            Date.now(),
            workspaceId,
            previousOwnerSessionId,
            previousLeaseRunId,
            previousLeaseRunInstanceId,
        );
        if (claimed.changes !== 1) {
            throw new Error(`Workspace ${workspaceId} changed while it was being recycled.`);
        }
        const recycled = workspaceById(database, workspaceId);
        if (!recycled) throw new Error(`Workspace ${workspaceId} disappeared while it was being recycled.`);
        database.exec("COMMIT");
        return recycled;
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Preserve the original recycle error.
        }
        throw error;
    } finally {
        database.close();
    }
}

/** Reset a workspace to the current parent revision and make it reusable. */
export async function resetAgentWorkspaceForReuse(
    workspaceId: string,
    {
        workspacesDir = PI_CODER_WORKSPACES_DIR,
    }: AgentWorkspaceLeaseControls = {},
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        database.exec("BEGIN IMMEDIATE");
        const workspace = workspaceById(database, workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        requireNoResultReservation(database, workspaceId);
        if (workspace.status === "recycling") {
            throw new Error(`Workspace ${workspaceId} is being recycled and cannot be reset.`);
        }
        if (workspace.leaseRunId) {
            if (workspace.leaseKind !== "task") {
                throw new Error(`Workspace ${workspaceId} is leased for setup and cannot be reset.`);
            }
            if (workspaceLeaseActive(database, workspace)) {
                throw new Error(`Workspace ${workspaceId} is still used by active run ${workspace.leaseRunId}; finish or cancel that run first.`);
            }
        } else if (workspace.leaseKind) {
            throw new Error(`Workspace ${workspaceId} is leased for setup and cannot be reset.`);
        }
        // Resetting only changes the isolated worktree. The parent may have
        // uncommitted changes; its current HEAD remains the workspace base.
        const targetRevision = await git(workspace.repositoryRoot, ["rev-parse", "HEAD"]);
        await git(workspace.worktreePath, ["reset", "--hard", targetRevision]);
        await git(workspace.worktreePath, ["clean", "-fd"]);
        const refs = database.prepare("SELECT durable_ref FROM workspace_results WHERE workspace_id = ? AND durable_ref IS NOT NULL")
            .all(workspaceId) as WorkspaceRow[];
        for (const row of refs) {
            if (typeof row.durable_ref === "string") {
                await git(workspace.repositoryRoot, ["update-ref", "-d", row.durable_ref]);
            }
        }
        database.prepare(`
            UPDATE workspace_results
            SET status = CASE WHEN status = 'prepared' THEN 'discarded' ELSE status END,
                durable_ref = NULL, reservation_token = NULL, reservation_owner_session_id = NULL,
                reservation_run_id = NULL, reservation_run_instance_id = NULL,
                reservation_owner_pid = NULL, reservation_acquired_at = NULL
            WHERE workspace_id = ?
        `).run(workspaceId);
        database.prepare(`
            UPDATE workspaces SET base_revision = ?, workspace_status = 'available',
                lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL, lease_kind = NULL,
                lease_acquired_at = NULL, updated_at = ? WHERE id = ?
        `).run(targetRevision, Date.now(), workspaceId);
        const reset = workspaceById(database, workspaceId);
        if (!reset) throw new Error(`Workspace ${workspaceId} disappeared while being reset.`);
        database.exec("COMMIT");
        return reset;
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Preserve the original reset error.
        }
        throw error;
    } finally {
        database.close();
    }
}

/** Permanently discard a workspace and all of its saved result refs. */
export async function discardAgentWorkspace(
    workspaceId: string,
    {
        workspacesDir = PI_CODER_WORKSPACES_DIR,
    }: AgentWorkspaceLeaseControls = {},
): Promise<void> {
    const database = await openDatabase(workspacesDir);
    try {
        database.exec("BEGIN IMMEDIATE");
        const workspace = workspaceById(database, workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        requireNoResultReservation(database, workspaceId);
        if (workspace.status === "recycling") {
            throw new Error(`Workspace ${workspaceId} is being recycled and cannot be discarded.`);
        }
        if (workspace.leaseRunId) {
            if (workspace.leaseKind !== "task") {
                throw new Error(`Workspace ${workspaceId} is leased for setup and cannot be discarded.`);
            }
            if (workspaceLeaseActive(database, workspace)) {
                throw new Error(`Workspace ${workspaceId} is still used by active run ${workspace.leaseRunId}; finish or cancel that run first.`);
            }
        } else if (workspace.leaseKind) {
            throw new Error(`Workspace ${workspaceId} is leased for setup and cannot be discarded.`);
        }
        const refs = database.prepare("SELECT durable_ref FROM workspace_results WHERE workspace_id = ? AND durable_ref IS NOT NULL")
            .all(workspaceId) as WorkspaceRow[];
        for (const row of refs) {
            if (typeof row.durable_ref === "string") {
                await git(workspace.repositoryRoot, ["update-ref", "-d", row.durable_ref]);
            }
        }
        if (fs.existsSync(workspace.worktreePath)) {
            await git(workspace.repositoryRoot, ["worktree", "remove", "--force", workspace.worktreePath]);
        }
        database.prepare("DELETE FROM workspace_results WHERE workspace_id = ?").run(workspaceId);
        database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
        database.exec("COMMIT");
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Preserve the original discard error.
        }
        throw error;
    } finally {
        database.close();
    }
}

export async function createAgentWorkspace(
    cwd: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspace> {
    const resolvedCwd = path.resolve(cwd);
    const repositoryRoot = path.resolve(await git(resolvedCwd, ["rev-parse", "--show-toplevel"]));
    const parentStatus = await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (parentStatus) {
        throw new Error("Cannot create an isolated workspace while the parent checkout has uncommitted changes.");
    }
    const baseRevision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const directory = workspacesRoot(workspacesDir);
    const database = await openDatabase(workspacesDir);
    let worktreePath: string | undefined;
    try {
        // Serialize the capacity check with the worktree creation and row insert
        // so concurrent pi processes cannot allocate the same final slot.
        database.exec("BEGIN IMMEDIATE");
        const countRow = database.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE cwd = ?")
            .get(resolvedCwd) as { count?: number } | undefined;
        const count = Number(countRow?.count ?? 0);
        if (count >= MAX_AGENT_WORKSPACES) {
            throw new Error(
                `Workspace capacity reached for ${resolvedCwd}: ${MAX_AGENT_WORKSPACES} workspaces already exist. Explicitly apply, retain, reset, or discard an existing workspace before creating another.`,
            );
        }
        let slug = randomSlug();
        while (
            database.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(slug)
            || fs.existsSync(path.join(directory, slug))
        ) {
            slug = randomSlug();
        }

        worktreePath = path.join(directory, slug);
        await git(repositoryRoot, ["worktree", "add", "--detach", worktreePath, baseRevision]);
        const now = Date.now();
        const workspace: AgentWorkspace = {
            version: WORKSPACE_VERSION,
            id: slug,
            cwd: resolvedCwd,
            repositoryRoot,
            worktreePath,
            slug,
            baseRevision,
            setupState: "not_started",
            status: "available",
            createdAt: now,
            updatedAt: now,
        };
        database.prepare(`
            INSERT INTO workspaces (
                version, id, cwd, repository_root, worktree_path, slug,
                base_revision, setup_state, setup_summary, workspace_status,
                lease_owner_session_id, lease_run_id, lease_run_instance_id, lease_kind, lease_acquired_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            workspace.version,
            workspace.id,
            workspace.cwd,
            workspace.repositoryRoot,
            workspace.worktreePath,
            workspace.slug,
            workspace.baseRevision,
            workspace.setupState,
            null,
            workspace.status,
            null,
            null,
            null,
            null,
            null,
            workspace.createdAt,
            workspace.updatedAt,
        );
        database.exec("COMMIT");
        return workspace;
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Preserve the original workspace allocation error.
        }
        if (worktreePath) {
            await git(repositoryRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        }
        throw error;
    } finally {
        database.close();
    }
}

export async function updateAgentWorkspace(
    workspace: AgentWorkspace,
    update: Pick<AgentWorkspace, "setupState"> & Partial<Pick<AgentWorkspace, "setupSummary">>,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspace> {
    const next: AgentWorkspace = {
        ...workspace,
        ...update,
        updatedAt: Date.now(),
    };
    const database = await openDatabase(workspacesDir);
    try {
        database.prepare(`
            UPDATE workspaces
            SET setup_state = ?, setup_summary = ?, updated_at = ?
            WHERE id = ?
        `).run(
            next.setupState,
            next.setupSummary ?? null,
            next.updatedAt,
            next.id,
        );
    } finally {
        database.close();
    }
    return next;
}
