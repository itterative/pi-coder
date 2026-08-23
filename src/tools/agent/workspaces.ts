import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PI_CODER_WORKSPACES_DIR } from "../../common/constants";
import { migrateSqliteDatabase } from "../../common/sqlite";
import { randomSlug } from "../../common/slug";

const execFileAsync = promisify(execFile);
const WORKSPACE_VERSION = 1 as const;
const DATABASE_NAME = "meta.sqlite";

export type WorkspaceSetupState = "not_started" | "running" | "ready" | "skipped" | "failed";

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
}] as const;

async function openDatabase(workspacesDir = PI_CODER_WORKSPACES_DIR): Promise<WorkspaceDatabase> {
    // Load lazily so users who do not use worktree isolation do not receive the
    // node:sqlite experimental warning during normal extension startup.
    const { DatabaseSync } = await import("node:sqlite");
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
                   base_revision, setup_state, setup_summary, created_at, updated_at
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
        .find((workspace) => workspace.setupState === "ready" || workspace.setupState === "skipped");
}

export async function findUnpreparedAgentWorkspace(
    cwd: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentWorkspace | undefined> {
    return (await listAgentWorkspaces(cwd, workspacesDir))
        .find((workspace) => workspace.setupState === "not_started" || workspace.setupState === "failed");
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
            createdAt: now,
            updatedAt: now,
        };
        database.prepare(`
            INSERT INTO workspaces (
                version, id, cwd, repository_root, worktree_path, slug,
                base_revision, setup_state, setup_summary, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
