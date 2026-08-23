import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PI_CODER_WORKSPACES_DIR } from "../../common/constants";
import { loadSqlite, migrateSqliteDatabase } from "../../common/sqlite";
import { randomSlug } from "../../common/slug";

const execFileAsync = promisify(execFile);
const WORKSPACE_VERSION = 1 as const;
const DATABASE_NAME = "meta.sqlite";

export type WorkspaceSetupState = "not_started" | "running" | "ready" | "skipped" | "failed";
export type WorkspaceStatus = "available" | "review_required";
export type WorkspaceLeaseKind = "setup" | "task";

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
        maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout.trim();
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

function workspaceById(database: WorkspaceDatabase, id: string): AgentWorkspace | undefined {
    const row = database.prepare(`
        SELECT version, id, cwd, repository_root, worktree_path, slug,
               base_revision, setup_state, setup_summary, workspace_status,
               lease_owner_session_id, lease_run_id, lease_kind, lease_acquired_at,
               created_at, updated_at
        FROM workspaces
        WHERE id = ?
    `).get(id) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : undefined;
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
        database.prepare(`
            UPDATE workspaces
            SET workspace_status = 'review_required',
                lease_owner_session_id = NULL, lease_run_id = NULL,
                lease_kind = NULL, lease_acquired_at = NULL
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(workspaceId, ownerSessionId, leaseRunId);
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
        database.prepare(`
            UPDATE workspaces
            SET lease_owner_session_id = NULL, lease_run_id = NULL,
                lease_kind = NULL, lease_acquired_at = NULL
            WHERE id = ? AND lease_owner_session_id = ? AND lease_run_id = ?
        `).run(workspaceId, ownerSessionId, leaseRunId);
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
                lease_kind = NULL, lease_acquired_at = NULL
            WHERE lease_owner_session_id = ? AND lease_run_id = ?
        `).run(ownerSessionId, leaseRunId);
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
