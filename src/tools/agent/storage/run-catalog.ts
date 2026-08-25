import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import type { WorkerMutationReport } from "../contracts/mutations";
import type { AgentRunCatalogRecord } from "../contracts/workspaces";
import { openAgentMetadataDatabase, type AgentMetadataDatabase } from "./metadata";

type CatalogRow = Record<string, unknown>;

function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function rowToAgentRunCatalogRecord(row: CatalogRow): AgentRunCatalogRecord | undefined {
    if (
        typeof row.owner_session_id !== "string"
        || typeof row.run_id !== "string"
        || typeof row.parent_cwd !== "string"
        || typeof row.title !== "string"
        || typeof row.agent !== "string"
        || typeof row.agent_source !== "string"
        || typeof row.task !== "string"
        || typeof row.status !== "string"
        || (row.background !== 0 && row.background !== 1)
        || (row.mutating !== 0 && row.mutating !== 1)
        || typeof row.started_at !== "number"
        || typeof row.updated_at !== "number"
    ) return undefined;
    const usageSnapshot = parseJson(row.usage_json);
    if (!usageSnapshot || typeof usageSnapshot !== "object") return undefined;
    const mutationReport = parseJson(row.mutation_report_json);
    return {
        ownerSessionId: row.owner_session_id,
        runId: row.run_id,
        parentCwd: row.parent_cwd,
        ...(typeof row.execution_cwd === "string" ? { executionCwd: row.execution_cwd } : {}),
        title: row.title,
        agent: row.agent,
        agentSource: row.agent_source,
        task: row.task,
        status: row.status,
        background: row.background === 1,
        mutating: row.mutating === 1,
        ...(typeof row.workspace_id === "string" ? { workspaceId: row.workspace_id } : {}),
        ...(typeof row.child_session_file === "string" ? { childSessionFile: row.child_session_file } : {}),
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        usageSnapshot: usageSnapshot as Usage,
        ...(typeof row.response_preview === "string" ? { responsePreview: row.response_preview } : {}),
        ...(mutationReport && typeof mutationReport === "object"
            ? { mutationReport: mutationReport as WorkerMutationReport }
            : {}),
    };
}

export function upsertAgentRunCatalogRecordInDatabase(
    database: AgentMetadataDatabase,
    record: AgentRunCatalogRecord,
): void {
    database.prepare(`
            INSERT INTO agent_runs (
                owner_session_id, run_id, parent_cwd, execution_cwd, title, agent,
                agent_source, task, status, background, mutating, workspace_id,
                child_session_file, started_at, updated_at, usage_json,
                response_preview, mutation_report_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (owner_session_id, run_id) DO UPDATE SET
                parent_cwd = excluded.parent_cwd,
                execution_cwd = excluded.execution_cwd,
                title = excluded.title,
                agent = excluded.agent,
                agent_source = excluded.agent_source,
                task = excluded.task,
                status = excluded.status,
                background = excluded.background,
                mutating = excluded.mutating,
                workspace_id = excluded.workspace_id,
                child_session_file = excluded.child_session_file,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                usage_json = excluded.usage_json,
                response_preview = excluded.response_preview,
                mutation_report_json = excluded.mutation_report_json
            WHERE excluded.updated_at >= agent_runs.updated_at
        `).run(
        record.ownerSessionId,
        record.runId,
        path.resolve(record.parentCwd),
        record.executionCwd ?? null,
        record.title,
        record.agent,
        record.agentSource,
        record.task,
        record.status,
        record.background ? 1 : 0,
        record.mutating ? 1 : 0,
        record.workspaceId ?? null,
        record.childSessionFile ?? null,
        record.startedAt,
        record.updatedAt,
        JSON.stringify(record.usageSnapshot),
        record.responsePreview ?? null,
        record.mutationReport ? JSON.stringify(record.mutationReport) : null,
    );
}

export async function upsertAgentRunCatalogRecord(
    record: AgentRunCatalogRecord,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<void> {
    const database = await openAgentMetadataDatabase(workspacesDir);
    try {
        upsertAgentRunCatalogRecordInDatabase(database, record);
    } finally {
        database.close();
    }
}

export async function listAgentRunCatalog(
    cwd: string,
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentRunCatalogRecord[]> {
    const database = await openAgentMetadataDatabase(workspacesDir);
    try {
        const rows = database.prepare(`
            SELECT owner_session_id, run_id, parent_cwd, execution_cwd, title, agent,
                   agent_source, task, status, background, mutating, workspace_id,
                   child_session_file, started_at, updated_at, usage_json,
                   response_preview, mutation_report_json
            FROM agent_runs
            WHERE parent_cwd = ?
            ORDER BY updated_at DESC, run_id ASC
        `).all(path.resolve(cwd)) as CatalogRow[];
        return rows
            .map(rowToAgentRunCatalogRecord)
            .filter((record): record is AgentRunCatalogRecord => record !== undefined);
    } finally {
        database.close();
    }
}
