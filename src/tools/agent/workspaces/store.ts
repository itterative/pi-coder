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

export interface AgentWorkspaceDirectoryOptions {
    workspacesDir?: string;
    /** Override the default capacity for this allocation operation. */
    maxWorkspaces?: number;
    /** Manual browser creation intentionally skips the dirty-parent guard. */
    skipParentDirtyCheck?: boolean;
}

export interface AgentWorkspaceListOptions extends AgentWorkspaceDirectoryOptions {
    includeMissingWorktrees?: boolean;
}

/** Required owner and run identity used by operations on an active workspace lease. */
export interface AgentWorkspaceLeaseOptions {
    ownerSessionId: string;
    leaseRunId: string;
    workspacesDir?: string;
    leaseRunInstanceId?: string;
    resultId?: string;
}

/** Optional lease controls used when a workspace may already be unleased. */
export interface AgentWorkspaceLeaseControls {
    ownerSessionId?: string;
    leaseRunId?: string;
    workspacesDir?: string;
    leaseRunInstanceId?: string;
}

/** Lease identity and kind used when claiming an available workspace. */
export interface ClaimAgentWorkspaceOptions extends AgentWorkspaceLeaseOptions {
    leaseKind: WorkspaceLeaseKind;
}

/** Source and destination identities used when transferring a workspace lease. */
export interface TransferAgentWorkspaceLeaseOptions extends Pick<
    AgentWorkspaceLeaseOptions,
    "ownerSessionId" | "workspacesDir"
> {
    fromLeaseRunId: string;
    toLeaseRunId: string;
    leaseKind?: WorkspaceLeaseKind;
    fromLeaseRunInstanceId?: string;
    toLeaseRunInstanceId?: string;
}

function rowToWorkspace(row: WorkspaceRow): AgentWorkspace | undefined {
    const setupState = row.setup_state;
    if (
        row.version !== WORKSPACE_VERSION ||
        typeof row.id !== "string" ||
        typeof row.cwd !== "string" ||
        typeof row.repository_root !== "string" ||
        typeof row.worktree_path !== "string" ||
        typeof row.slug !== "string" ||
        typeof row.base_revision !== "string" ||
        !["not_started", "running", "ready", "skipped", "failed"].includes(setupState as string) ||
        !["available", "review_required", "recycling"].includes(row.workspace_status as string) ||
        typeof row.created_at !== "number" ||
        typeof row.updated_at !== "number"
    )
        return undefined;
    return {
        version: WORKSPACE_VERSION,
        id: row.id,
        cwd: row.cwd,
        repositoryRoot: row.repository_root,
        worktreePath: row.worktree_path,
        slug: row.slug,
        baseRevision: row.base_revision,
        setupState: setupState as WorkspaceSetupState,
        setupSummary:
            typeof row.setup_summary === "string" ? row.setup_summary.slice(0, 8_000) : undefined,
        status: row.workspace_status as WorkspaceStatus,
        ...(typeof row.lease_owner_session_id === "string"
            ? { leaseOwnerSessionId: row.lease_owner_session_id }
            : {}),
        ...(typeof row.lease_run_id === "string" ? { leaseRunId: row.lease_run_id } : {}),
        ...(typeof row.lease_run_instance_id === "string"
            ? { leaseRunInstanceId: row.lease_run_instance_id }
            : {}),
        ...(["setup", "task"].includes(row.lease_kind as string)
            ? { leaseKind: row.lease_kind as WorkspaceLeaseKind }
            : {}),
        ...(typeof row.lease_acquired_at === "number"
            ? { leaseAcquiredAt: row.lease_acquired_at }
            : {}),
        leaseState:
            typeof row.lease_run_id === "string"
                ? row.lease_kind === "setup"
                    ? "setup"
                    : "unknown"
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
        typeof row.id !== "string" ||
        typeof row.workspace_id !== "string" ||
        typeof row.run_id !== "string" ||
        typeof row.base_revision !== "string" ||
        typeof row.worker_head !== "string" ||
        typeof row.commit_range !== "string" ||
        !Array.isArray(commits) ||
        !commits.every((commit): commit is string => typeof commit === "string") ||
        typeof row.prepared_at !== "number" ||
        !["prepared", "applying", "applied", "discarded"].includes(row.status as string)
    )
        return undefined;
    return {
        id: row.id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        ...(typeof row.run_instance_id === "string" ? { runInstanceId: row.run_instance_id } : {}),
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

export async function workspaceResultById(
    database: WorkspaceDatabase,
    resultId: string,
): Promise<AgentWorkspaceResult | undefined> {
    const row = (await database.get(
        `
        SELECT id, workspace_id, run_id, run_instance_id, base_revision, worker_head, commit_range,
               commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
        FROM workspace_results
        WHERE id = ?
    `,
        resultId,
    )) as WorkspaceRow | undefined;
    return row ? rowToWorkspaceResult(row) : undefined;
}

export async function workspaceResultForRun(
    database: WorkspaceDatabase,
    workspaceId: string,
    runId: string,
    runInstanceId?: string,
): Promise<AgentWorkspaceResult | undefined> {
    const row = (await database.get(
        `
        SELECT id, workspace_id, run_id, run_instance_id, base_revision, worker_head, commit_range,
               commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
        FROM workspace_results
        WHERE workspace_id = ? AND run_id = ?
          AND (? IS NULL AND run_instance_id IS NULL OR run_instance_id = ?)
        ORDER BY prepared_at DESC, id DESC
        LIMIT 1
    `,
        workspaceId,
        runId,
        runInstanceId ?? null,
        runInstanceId ?? null,
    )) as WorkspaceRow | undefined;
    return row ? rowToWorkspaceResult(row) : undefined;
}

async function latestWorkspaceResult(
    database: WorkspaceDatabase,
    workspaceId: string,
): Promise<AgentWorkspaceResult | undefined> {
    const row = (await database.get(
        `
        SELECT id, workspace_id, run_id, run_instance_id, base_revision, worker_head, commit_range,
               commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
        FROM workspace_results
        WHERE workspace_id = ?
        ORDER BY prepared_at DESC, id DESC
        LIMIT 1
    `,
        workspaceId,
    )) as WorkspaceRow | undefined;
    return row ? rowToWorkspaceResult(row) : undefined;
}

const ACTIVE_AGENT_RUN_STATUSES = new Set([
    "starting",
    "running",
    "waiting_for_permission",
    "waiting_for_parent",
]);

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/** Return whether a task lease still has an active durable run behind it. */
export async function workspaceLeaseActive(
    database: WorkspaceDatabase,
    workspace: AgentWorkspace,
): Promise<boolean> {
    if (!workspace.leaseRunId || workspace.leaseKind !== "task" || !workspace.leaseOwnerSessionId) {
        return false;
    }
    const row = (await database.get(
        `
        SELECT status, owner_pid FROM agent_runs
        WHERE owner_session_id = ? AND run_instance_id = ?
    `,
        workspace.leaseOwnerSessionId,
        workspace.leaseRunInstanceId ?? `${workspace.leaseOwnerSessionId}:${workspace.leaseRunId}`,
    )) as WorkspaceRow | undefined;
    const continuation = (await database.get(
        `
        SELECT lease_until FROM agent_run_continuation_leases
        WHERE run_instance_id = ? AND lease_until > ?
    `,
        workspace.leaseRunInstanceId ?? `${workspace.leaseOwnerSessionId}:${workspace.leaseRunId}`,
        Date.now(),
    )) as WorkspaceRow | undefined;
    if (typeof continuation?.lease_until === "number") return true;
    const active = typeof row?.status === "string" && ACTIVE_AGENT_RUN_STATUSES.has(row.status);
    if (!active) return false;
    if (typeof row?.owner_pid !== "number") return true;
    return isProcessAlive(row.owner_pid);
}

export async function workspaceLeaseState(
    database: WorkspaceDatabase,
    workspace: AgentWorkspace,
): Promise<WorkspaceLeaseState> {
    if (!workspace.leaseRunId) return "none";
    if (workspace.leaseKind === "setup") return "setup";
    if (!workspace.leaseOwnerSessionId) return "unknown";
    const row = (await database.get(
        `
        SELECT status FROM agent_runs
        WHERE owner_session_id = ? AND run_instance_id = ?
    `,
        workspace.leaseOwnerSessionId,
        workspace.leaseRunInstanceId ?? `${workspace.leaseOwnerSessionId}:${workspace.leaseRunId}`,
    )) as WorkspaceRow | undefined;
    if (!row || typeof row.status !== "string") return "orphaned";
    // A terminal run can still own a prepared result awaiting explicit
    // disposition. Presence in the catalog means the lease is known; only a
    // missing catalog row is orphaned.
    return "known";
}

export async function attachLatestWorkspaceResult(
    database: WorkspaceDatabase,
    workspace: AgentWorkspace | undefined,
): Promise<AgentWorkspace | undefined> {
    if (!workspace) return undefined;
    const latestResult = await latestWorkspaceResult(database, workspace.id);
    return {
        ...workspace,
        leaseState: await workspaceLeaseState(database, workspace),
        leaseActive: await workspaceLeaseActive(database, workspace),
        ...(latestResult ? { latestResult } : {}),
    };
}

export async function workspaceForLease(
    workspaceId: string,
    {
        ownerSessionId,
        leaseRunId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        leaseRunInstanceId,
    }: AgentWorkspaceLeaseOptions,
): Promise<{ database: WorkspaceDatabase; workspace: AgentWorkspace }> {
    const database = await openDatabase(workspacesDir);
    let workspace: AgentWorkspace | undefined;
    try {
        workspace = await attachLatestWorkspaceResult(
            database,
            await workspaceById(database, workspaceId),
        );
    } catch (error) {
        try {
            await database.close();
        } catch {
            // Preserve the lookup failure; the connection is best-effort cleanup.
        }
        throw error;
    }
    if (
        !workspace ||
        workspace.leaseOwnerSessionId !== ownerSessionId ||
        workspace.leaseRunId !== leaseRunId ||
        (workspace.leaseRunInstanceId !== undefined &&
            workspace.leaseRunInstanceId !== leaseRunInstanceId)
    ) {
        await database.close();
        throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
    }
    return { database, workspace };
}

export async function getAgentWorkspace(
    workspaceId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspace | undefined> {
    const database = await openDatabase(workspacesDir);
    try {
        return await attachLatestWorkspaceResult(
            database,
            await workspaceById(database, workspaceId),
        );
    } finally {
        await database.close();
    }
}

export async function getAgentWorkspaceResultById(
    resultId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspaceResult | undefined> {
    const database = await openDatabase(workspacesDir);
    try {
        return await workspaceResultById(database, resultId);
    } finally {
        await database.close();
    }
}

export async function getAgentWorkspaceResult(
    workspaceId: string,
    runId: string,
    runInstanceId?: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspaceResult | undefined> {
    const database = await openDatabase(workspacesDir);
    try {
        return await workspaceResultForRun(database, workspaceId, runId, runInstanceId);
    } finally {
        await database.close();
    }
}

export async function inspectAgentWorkspaceGitState(
    workspace: AgentWorkspace,
): Promise<AgentWorkspaceGitState> {
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
    {
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        includeMissingWorktrees = false,
    }: AgentWorkspaceListOptions = {},
): Promise<AgentWorkspace[]> {
    const repositoryRoot = path.resolve(
        await git(path.resolve(cwd), ["rev-parse", "--show-toplevel"]),
    );
    const database = await openDatabase(workspacesDir);
    try {
        const rows = (await database.all(
            `
            SELECT version, id, cwd, repository_root, worktree_path, slug,
                   base_revision, setup_state, setup_summary, workspace_status,
                   lease_owner_session_id, lease_run_id, lease_run_instance_id, lease_kind, lease_acquired_at,
                   created_at, updated_at
            FROM workspaces
            WHERE repository_root = ?
            ORDER BY created_at ASC, slug ASC
        `,
            repositoryRoot,
        )) as WorkspaceRow[];
        const workspaces = await Promise.all(
            rows
                .map(rowToWorkspace)
                .filter((workspace): workspace is AgentWorkspace => workspace !== undefined)
                .map((workspace) => attachLatestWorkspaceResult(database, workspace)),
        );
        return workspaces
            .filter((workspace): workspace is AgentWorkspace => workspace !== undefined)
            .filter(
                (workspace) => includeMissingWorktrees || fs.existsSync(workspace.worktreePath),
            );
    } finally {
        await database.close();
    }
}

export async function findAvailableAgentWorkspace(
    cwd: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspace | undefined> {
    return (await listAgentWorkspaces(cwd, { workspacesDir })).find(
        (workspace) =>
            workspace.status === "available" &&
            !workspace.leaseRunId &&
            (workspace.setupState === "ready" || workspace.setupState === "skipped"),
    );
}

export async function findUnpreparedAgentWorkspace(
    cwd: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspace | undefined> {
    return (await listAgentWorkspaces(cwd, { workspacesDir })).find(
        (workspace) =>
            !workspace.leaseRunId &&
            (workspace.setupState === "not_started" || workspace.setupState === "failed"),
    );
}

export async function listAgentWorkspaceResults(
    workspaceId: string,
    { workspacesDir = PI_CODER_WORKSPACES_DIR }: AgentWorkspaceDirectoryOptions = {},
): Promise<AgentWorkspaceResult[]> {
    const database = await openDatabase(workspacesDir);
    try {
        const rows = (await database.all(
            `
            SELECT id, workspace_id, run_id, run_instance_id, base_revision, worker_head, commit_range,
                   commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
            FROM workspace_results
            WHERE workspace_id = ?
            ORDER BY prepared_at ASC, id ASC
        `,
            workspaceId,
        )) as WorkspaceRow[];
        return rows
            .map(rowToWorkspaceResult)
            .filter((result): result is AgentWorkspaceResult => result !== undefined);
    } finally {
        await database.close();
    }
}

export async function workspaceById(
    database: WorkspaceDatabase,
    id: string,
): Promise<AgentWorkspace | undefined> {
    const row = (await database.get(
        `
        SELECT version, id, cwd, repository_root, worktree_path, slug,
               base_revision, setup_state, setup_summary, workspace_status,
               lease_owner_session_id, lease_run_id, lease_run_instance_id, lease_kind, lease_acquired_at,
               created_at, updated_at
        FROM workspaces
        WHERE id = ?
    `,
        id,
    )) as WorkspaceRow | undefined;
    return await attachLatestWorkspaceResult(database, row ? rowToWorkspace(row) : undefined);
}

export async function claimAgentWorkspace(
    workspaceId: string,
    {
        ownerSessionId,
        leaseRunId,
        leaseKind,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        leaseRunInstanceId,
    }: ClaimAgentWorkspaceOptions,
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        return await database.transaction(async (transaction) => {
            const result = await transaction.run(
                `
                UPDATE workspaces
                SET lease_owner_session_id = ?, lease_run_id = ?, lease_run_instance_id = ?, lease_kind = ?, lease_acquired_at = ?
                WHERE id = ? AND workspace_status = 'available' AND lease_run_id IS NULL
            `,
                ownerSessionId,
                leaseRunId,
                leaseRunInstanceId ?? null,
                leaseKind,
                Date.now(),
                workspaceId,
            );
            if (Number(result.changes) !== 1) {
                throw new Error(`Workspace ${workspaceId} is no longer available.`);
            }
            const workspace = await workspaceById(transaction, workspaceId);
            if (!workspace) {
                throw new Error(`Workspace ${workspaceId} disappeared while being claimed.`);
            }
            return workspace;
        }, "IMMEDIATE");
    } finally {
        await database.close();
    }
}

/** Claim a review-required or available slot for continuation of its original run. */
export async function claimAgentWorkspaceForContinuation(
    workspaceId: string,
    {
        ownerSessionId,
        leaseRunId,
        leaseRunInstanceId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
    }: AgentWorkspaceLeaseOptions,
): Promise<AgentWorkspace> {
    const database = await openDatabase(workspacesDir);
    try {
        return await database.transaction(async (transaction) => {
            const result = await transaction.run(
                `
                UPDATE workspaces
                SET lease_owner_session_id = ?, lease_run_id = ?, lease_run_instance_id = ?,
                    lease_kind = 'task', lease_acquired_at = ?, updated_at = ?
                WHERE id = ? AND workspace_status IN ('available', 'review_required')
                  AND lease_run_id IS NULL
            `,
                ownerSessionId,
                leaseRunId,
                leaseRunInstanceId ?? null,
                Date.now(),
                Date.now(),
                workspaceId,
            );
            if (Number(result.changes) !== 1) {
                throw new Error(`Workspace ${workspaceId} is not available for continuation.`);
            }
            const workspace = await workspaceById(transaction, workspaceId);
            if (!workspace) {
                throw new Error(
                    `Workspace ${workspaceId} disappeared while being claimed for continuation.`,
                );
            }
            return workspace;
        }, "IMMEDIATE");
    } finally {
        await database.close();
    }
}

export async function transferAgentWorkspaceLease(
    workspaceId: string,
    {
        ownerSessionId,
        fromLeaseRunId,
        toLeaseRunId,
        leaseKind = "task",
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        fromLeaseRunInstanceId,
        toLeaseRunInstanceId,
    }: TransferAgentWorkspaceLeaseOptions,
): Promise<void> {
    const database = await openDatabase(workspacesDir);
    try {
        await database.transaction(async (transaction) => {
            const result = await transaction.run(
                `
                UPDATE workspaces
                SET lease_run_id = ?, lease_run_instance_id = ?, lease_kind = ?, lease_acquired_at = ?
                WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
                  AND (? IS NULL OR lease_run_instance_id = ?)
            `,
                toLeaseRunId,
                toLeaseRunInstanceId ?? null,
                leaseKind,
                Date.now(),
                workspaceId,
                ownerSessionId,
                fromLeaseRunId,
                fromLeaseRunInstanceId ?? null,
                fromLeaseRunInstanceId ?? null,
            );
            if (Number(result.changes) !== 1) {
                throw new Error(`Workspace ${workspaceId} lease could not be transferred.`);
            }
        }, "IMMEDIATE");
    } finally {
        await database.close();
    }
}

export async function releaseAgentWorkspaceLease(
    workspaceId: string,
    {
        ownerSessionId,
        leaseRunId,
        workspacesDir = PI_CODER_WORKSPACES_DIR,
        leaseRunInstanceId,
    }: AgentWorkspaceLeaseOptions,
): Promise<void> {
    const database = await openDatabase(workspacesDir);
    try {
        const workspace = await workspaceById(database, workspaceId);
        if (
            workspace?.leaseOwnerSessionId !== ownerSessionId ||
            workspace.leaseRunId !== leaseRunId ||
            (workspace.leaseRunInstanceId !== undefined &&
                workspace.leaseRunInstanceId !== leaseRunInstanceId)
        ) {
            throw new Error(`Workspace ${workspaceId} is not leased by ${leaseRunId}.`);
        }
        const result =
            workspace.leaseKind === "task"
                ? await workspaceResultForRun(database, workspaceId, leaseRunId, leaseRunInstanceId)
                : undefined;
        if (workspace.leaseKind === "task" && result?.status !== "applied") {
            throw new Error(
                `Workspace ${workspaceId} can be released only after successful application.`,
            );
        }
        await database.run(
            `
            UPDATE workspaces
            SET lease_owner_session_id = NULL, lease_run_id = NULL, lease_run_instance_id = NULL,
                lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
              AND (? IS NULL OR lease_run_instance_id = ?)
        `,
            Date.now(),
            workspaceId,
            ownerSessionId,
            leaseRunId,
            leaseRunInstanceId ?? null,
            leaseRunInstanceId ?? null,
        );
    } finally {
        await database.close();
    }
}
