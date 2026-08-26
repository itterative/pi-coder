import fs from "node:fs";
import path from "node:path";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import { loadSqlite, migrateSqliteDatabase } from "../../../common/sqlite";

const DATABASE_NAME = "meta.sqlite";

export type AgentMetadataDatabase = import("node:sqlite").DatabaseSync;

export const AGENT_METADATA_MIGRATIONS = [{
    version: 1,
    apply(database: AgentMetadataDatabase): void {
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
    apply(database: AgentMetadataDatabase): void {
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
    apply(database: AgentMetadataDatabase): void {
        database.exec(`
            ALTER TABLE workspaces ADD COLUMN workspace_status TEXT NOT NULL DEFAULT 'available';
            CREATE INDEX IF NOT EXISTS workspaces_status
                ON workspaces (workspace_status, setup_state, created_at);
        `);
    },
}, {
    version: 4,
    apply(database: AgentMetadataDatabase): void {
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
            CREATE INDEX IF NOT EXISTS workspace_results_workspace_prepared
                ON workspace_results (workspace_id, prepared_at DESC);
        `);
    },
}, {
    version: 5,
    apply(database: AgentMetadataDatabase): void {
        database.exec(`
            CREATE TABLE IF NOT EXISTS agent_runs (
                owner_session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                parent_cwd TEXT NOT NULL,
                execution_cwd TEXT,
                title TEXT NOT NULL,
                agent TEXT NOT NULL,
                agent_source TEXT NOT NULL,
                task TEXT NOT NULL,
                status TEXT NOT NULL,
                background INTEGER NOT NULL,
                mutating INTEGER NOT NULL,
                workspace_id TEXT,
                child_session_file TEXT,
                started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                usage_json TEXT NOT NULL,
                response_preview TEXT,
                mutation_report_json TEXT,
                PRIMARY KEY (owner_session_id, run_id)
            );
            CREATE INDEX IF NOT EXISTS agent_runs_cwd_updated
                ON agent_runs (parent_cwd, updated_at DESC);
            CREATE INDEX IF NOT EXISTS agent_runs_child_session
                ON agent_runs (child_session_file);
        `);
    },
}, {
    version: 6,
    apply(database: AgentMetadataDatabase): void {
        database.exec(`
            CREATE TABLE IF NOT EXISTS agent_run_states (
                owner_session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                branch_entry_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                PRIMARY KEY (owner_session_id, run_id, branch_entry_id)
            );
            CREATE INDEX IF NOT EXISTS agent_run_states_branch
                ON agent_run_states (owner_session_id, branch_entry_id, updated_at DESC);
        `);
    },
}, {
    version: 7,
    apply(database: AgentMetadataDatabase): void {
        database.exec(`
            CREATE TABLE IF NOT EXISTS agent_run_instances (
                run_instance_id TEXT PRIMARY KEY,
                owner_session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                title TEXT NOT NULL,
                agent TEXT NOT NULL,
                agent_source TEXT NOT NULL,
                agent_file_path TEXT,
                definition_fingerprint TEXT NOT NULL,
                task TEXT NOT NULL,
                background INTEGER NOT NULL,
                mutating INTEGER NOT NULL,
                workspace_id TEXT,
                parent_cwd TEXT NOT NULL,
                execution_cwd TEXT,
                started_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_run_instances_owner
                ON agent_run_instances (owner_session_id, started_at);
            CREATE TABLE IF NOT EXISTS agent_run_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                run_instance_id TEXT NOT NULL,
                owner_session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                payload_version INTEGER NOT NULL,
                status TEXT NOT NULL,
                child_session_file TEXT,
                child_session_leaf_id TEXT,
                updated_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                created_sequence INTEGER NOT NULL,
                FOREIGN KEY (run_instance_id) REFERENCES agent_run_instances(run_instance_id)
            );
            CREATE INDEX IF NOT EXISTS agent_run_snapshots_instance
                ON agent_run_snapshots (run_instance_id, created_sequence);
        `);
    },
}, {
    version: 8,
    apply(database: AgentMetadataDatabase): void {
        database.exec(`
            ALTER TABLE agent_runs ADD COLUMN run_instance_id TEXT;
            ALTER TABLE agent_runs ADD COLUMN child_session_leaf_id TEXT;
            ALTER TABLE agent_runs ADD COLUMN latest_snapshot_id TEXT;
            CREATE TABLE agent_runs_v2 (
                run_instance_id TEXT PRIMARY KEY,
                owner_session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                parent_cwd TEXT NOT NULL,
                execution_cwd TEXT,
                title TEXT NOT NULL,
                agent TEXT NOT NULL,
                agent_source TEXT NOT NULL,
                task TEXT NOT NULL,
                status TEXT NOT NULL,
                background INTEGER NOT NULL,
                mutating INTEGER NOT NULL,
                workspace_id TEXT,
                child_session_file TEXT,
                child_session_leaf_id TEXT,
                latest_snapshot_id TEXT,
                started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                usage_json TEXT NOT NULL,
                response_preview TEXT,
                mutation_report_json TEXT
            );
            INSERT INTO agent_runs_v2 (
                run_instance_id, owner_session_id, run_id, parent_cwd, execution_cwd,
                title, agent, agent_source, task, status, background, mutating,
                workspace_id, child_session_file, child_session_leaf_id,
                latest_snapshot_id, started_at, updated_at, usage_json,
                response_preview, mutation_report_json
            )
            SELECT COALESCE(run_instance_id, owner_session_id || ':' || run_id),
                   owner_session_id, run_id, parent_cwd, execution_cwd,
                   title, agent, agent_source, task, status, background, mutating,
                   workspace_id, child_session_file, child_session_leaf_id,
                   latest_snapshot_id, started_at, updated_at, usage_json,
                   response_preview, mutation_report_json
            FROM agent_runs;
            DROP TABLE agent_runs;
            ALTER TABLE agent_runs_v2 RENAME TO agent_runs;
            CREATE INDEX agent_runs_owner_run
                ON agent_runs (owner_session_id, run_id);
            CREATE INDEX agent_runs_cwd_updated
                ON agent_runs (parent_cwd, updated_at DESC);
            CREATE INDEX agent_runs_child_session
                ON agent_runs (child_session_file);
            CREATE INDEX agent_runs_instance
                ON agent_runs (run_instance_id);
        `);
    },
}] as const;

export function agentWorkspacesRoot(workspacesDir = PI_CODER_WORKSPACES_DIR): string {
    return path.resolve(workspacesDir);
}

export async function openAgentMetadataDatabase(
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentMetadataDatabase> {
    // Load lazily so users who do not use delegated-agent persistence do not
    // receive the node:sqlite experimental warning during normal startup.
    const { DatabaseSync } = await loadSqlite();
    const directory = agentWorkspacesRoot(workspacesDir);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const databasePath = path.join(path.dirname(directory), DATABASE_NAME);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000");
    migrateSqliteDatabase(database, AGENT_METADATA_MIGRATIONS);
    fs.chmodSync(databasePath, 0o600);
    return database;
}
