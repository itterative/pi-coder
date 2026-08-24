import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PI_CODER_WORKSPACES_DIR } from "../../common/constants";
import { loadSqlite, migrateSqliteDatabase } from "../../common/sqlite";
import { randomSlug } from "../../common/slug";

const execFileAsync = promisify(execFile);
const WORKSPACE_VERSION = 1 as const;
const DATABASE_NAME = "meta.sqlite";
export const MAX_AGENT_WORKSPACES = 3;

export type WorkspaceSetupState = "not_started" | "running" | "ready" | "skipped" | "failed";
export type WorkspaceStatus = "available" | "review_required";
export type WorkspaceLeaseKind = "setup" | "task";
export type WorkspaceResultStatus = "prepared" | "applied";

export interface AgentWorkspaceResult {
    id: string;
    workspaceId: string;
    runId: string;
    baseRevision: string;
    workerHead: string;
    commitRange: string;
    commits: string[];
    durableRef?: string;
    preparedAt: number;
    status: WorkspaceResultStatus;
    parentRevision?: string;
    appliedAt?: number;
}

/** @deprecated Use AgentWorkspaceResult. */
export type AgentWorkspaceApplication = AgentWorkspaceResult;

export interface AgentWorkspaceGitState {
    kind: "available" | "unavailable";
    dirty?: boolean;
    changedFiles?: number;
    stagedFiles?: number;
    unstagedFiles?: number;
    untrackedFiles?: number;
    headRevision?: string;
    error?: string;
}

export interface AgentWorkspace {
    version: typeof WORKSPACE_VERSION;
    id: string;
    cwd: string;
    repositoryRoot: string;
    worktreePath: string;
    slug: string;
    baseRevision: string;
    setupState: WorkspaceSetupState;
    setupSummary?: string;
    status: WorkspaceStatus;
    leaseOwnerSessionId?: string;
    leaseRunId?: string;
    leaseKind?: WorkspaceLeaseKind;
    leaseAcquiredAt?: number;
    latestResult?: AgentWorkspaceResult;
    createdAt: number;
    updatedAt: number;
}

type WorkspaceRow = Record<string, unknown>;
type WorkspaceDatabase = import("node:sqlite").DatabaseSync;

function workspacesRoot(workspacesDir = PI_CODER_WORKSPACES_DIR): string {
    return path.resolve(workspacesDir);
}

const WORKSPACE_MIGRATIONS = [{
    version: 1,
    apply(database: WorkspaceDatabase): void {
        database.exec(`
            CREATE TABLE IF NOT EXISTS workspaces (
                version INTEGER NOT NULL,
                id TEXT PRIMARY KEY,
                cwd TEXT NOT NULL,
                repository_root TEXT NOT NULL,
                worktree_path TEXT NOT NULL UNIQUE,
                slug TEXT NOT NULL UNIQUE,
                base_revision TEXT NOT NULL,
                setup_state TEXT NOT NULL,
                setup_summary TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS workspaces_cwd_state_created
                ON workspaces (cwd, setup_state, created_at);
        `);
    },
}, {
    version: 2,
    apply(database: WorkspaceDatabase): void {
        database.exec(`
            ALTER TABLE workspaces ADD COLUMN lease_owner_session_id TEXT;
            ALTER TABLE workspaces ADD COLUMN lease_run_id TEXT;
            ALTER TABLE workspaces ADD COLUMN lease_kind TEXT;
            ALTER TABLE workspaces ADD COLUMN lease_acquired_at INTEGER;
            CREATE INDEX IF NOT EXISTS workspaces_lease_run
                ON workspaces (lease_run_id);
        `);
    },
}, {
    version: 3,
    apply(database: WorkspaceDatabase): void {
        database.exec(`
            ALTER TABLE workspaces ADD COLUMN workspace_status TEXT NOT NULL DEFAULT 'available';
            CREATE INDEX IF NOT EXISTS workspaces_status
                ON workspaces (workspace_status, setup_state, created_at);
        `);
    },
}, {
    version: 4,
    apply(database: WorkspaceDatabase): void {
        database.exec(`
            CREATE TABLE workspace_results (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                base_revision TEXT NOT NULL,
                worker_head TEXT NOT NULL,
                commit_range TEXT NOT NULL,
                commits_json TEXT NOT NULL,
                durable_ref TEXT,
                prepared_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                parent_revision TEXT,
                applied_at INTEGER,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX workspace_results_workspace_prepared
                ON workspace_results (workspace_id, prepared_at DESC);
        `);
    },
}] as const;

async function openDatabase(workspacesDir = PI_CODER_WORKSPACES_DIR): Promise<WorkspaceDatabase> {
    // Load lazily so users who do not use worktree isolation do not receive the
    // node:sqlite experimental warning during normal extension startup.
    const { DatabaseSync } = await loadSqlite();
    const directory = workspacesRoot(workspacesDir);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const databasePath = path.join(directory, DATABASE_NAME);
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000");
    migrateSqliteDatabase(database, WORKSPACE_MIGRATIONS);
    fs.chmodSync(databasePath, 0o600);
    return database;
}

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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

async function git(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
}

async function hasAncestor(cwd: string, baseRevision: string, revision: string): Promise<boolean> {
    try {
        await git(cwd, ["merge-base", "--is-ancestor", baseRevision, revision]);
        return true;
    } catch {
        return false;
    }
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
        || !["prepared", "applied"].includes(row.status as string)
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

function attachLatestWorkspaceResult(
    database: WorkspaceDatabase,
    workspace: AgentWorkspace | undefined,
): AgentWorkspace | undefined {
    if (!workspace) return undefined;
    const latestResult = latestWorkspaceResult(database, workspace.id);
    return latestResult ? { ...workspace, latestResult } : workspace;
}

async function workspaceForLease(
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

function workspaceById(database: WorkspaceDatabase, id: string): AgentWorkspace | undefined {
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

export async function completeAgentWorkspaceLease(
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
            SET workspace_status = 'review_required',
                lease_owner_session_id = NULL, lease_run_id = NULL,
                lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(Date.now(), workspaceId, ownerSessionId, leaseRunId);
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

export async function releaseAgentWorkspaceLeaseForRun(
    ownerSessionId: string,
    leaseRunId: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<void> {
    const database = await openDatabase(workspacesDir);
    try {
        database.prepare(`
            UPDATE workspaces
            SET lease_owner_session_id = NULL, lease_run_id = NULL,
                lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE lease_owner_session_id = ? AND lease_run_id = ?
              AND lease_kind != 'task'
        `).run(Date.now(), ownerSessionId, leaseRunId);
    } finally {
        database.close();
    }
}

const FINAL_RESULT_COMMIT_MESSAGE = "pi-coder: finalize isolated worker result";
const RESULT_REF_PREFIX = "refs/pi-coder/workspace-results";

/** Finalize the isolated worker tree for an explicit apply request. */
export async function prepareAgentWorkspaceApplication(
    workspace: AgentWorkspace,
    ownerSessionId: string,
    leaseRunId: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspaceResult> {
    const { database, workspace: current } = await workspaceForLease(workspace.id, ownerSessionId, leaseRunId, workspacesDir);
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
        const resultId = randomUUID();
        durableRef = `${RESULT_REF_PREFIX}/${current.id}/${resultId}`;
        await git(current.worktreePath, ["update-ref", durableRef, workerHead]);
        const result: AgentWorkspaceResult = {
            id: resultId,
            workspaceId: current.id,
            runId: leaseRunId,
            baseRevision: current.baseRevision,
            workerHead,
            commitRange: `${current.baseRevision}..${workerHead}`,
            commits: commitsOutput ? commitsOutput.split("\n").filter(Boolean) : [],
            durableRef,
            preparedAt: Date.now(),
            status: "prepared",
        };
        database.prepare(`
            INSERT INTO workspace_results (
                id, workspace_id, run_id, base_revision, worker_head, commit_range,
                commits_json, durable_ref, prepared_at, status, parent_revision, applied_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(result.id, result.workspaceId, result.runId, result.baseRevision, result.workerHead,
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
    ownerSessionId: string,
    leaseRunId: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspaceResult> {
    const { database, workspace: current } = await workspaceForLease(workspace.id, ownerSessionId, leaseRunId, workspacesDir);
    try {
        if (current.leaseKind !== "task") throw new Error(`Workspace ${current.id} does not have a task lease.`);
        const result = current.latestResult;
        if (!result) throw new Error(`Workspace ${current.id} has not been prepared for application.`);
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
        if (parentRevision !== result.baseRevision) {
            throw new Error(`Parent checkout is at ${parentRevision}, expected workspace base ${result.baseRevision}.`);
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

/** Release a task lease only after its prepared result was applied successfully. */
export async function releaseAgentWorkspaceAfterApplication(
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
        if (workspace.leaseKind !== "task" || workspace.latestResult?.status !== "applied") {
            throw new Error(`Workspace ${workspaceId} can be released only after successful application.`);
        }
        database.prepare(`
            UPDATE workspaces SET workspace_status = 'review_required', lease_owner_session_id = NULL,
                lease_run_id = NULL, lease_kind = NULL, lease_acquired_at = NULL, updated_at = ?
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(Date.now(), workspaceId, ownerSessionId, leaseRunId);
    } finally {
        database.close();
    }
}

export async function createAgentWorkspace(
    cwd: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace> {
    const resolvedCwd = path.resolve(cwd);
    const repositoryRoot = path.resolve(await git(resolvedCwd, ["rev-parse", "--show-toplevel"]));
    const baseRevision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const directory = workspacesRoot(workspacesDir);
    const database = await openDatabase(workspacesDir);
    let worktreePath: string | undefined;
    try {
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
                lease_owner_session_id, lease_run_id, lease_kind, lease_acquired_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            workspace.createdAt,
            workspace.updatedAt,
        );
        return workspace;
    } catch (error) {
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
    workspacesDir = PI_CODER_WORKSPACES_DIR,
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
