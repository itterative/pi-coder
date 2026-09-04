import { randomUUID } from "node:crypto";

import type { AgentRunStatus, PersistedAgentRun } from "../contracts/runs";
import { type AgentMetadataDatabase } from "./metadata";

export const AGENT_RUN_SNAPSHOT_PAYLOAD_VERSION = 2;

export interface AgentRunSnapshotRow {
    snapshotId: string;
    runInstanceId: string;
    ownerSessionId: string;
    runId: string;
    payloadVersion: number;
    status: AgentRunStatus | "removed";
    childSessionFile?: string;
    childSessionLeafId: string | null;
    updatedAt: number;
    payload: unknown;
    createdSequence: number;
}

export async function insertAgentRunSnapshotInDatabase(
    database: AgentMetadataDatabase,
    record: PersistedAgentRun,
): Promise<AgentRunSnapshotRow> {
    const runInstanceId = record.runInstanceId;
    if (!runInstanceId) {
        throw new Error("Cannot persist a delegated run without runInstanceId.");
    }
    const snapshotId = randomUUID();
    await database.run(
        `
        INSERT INTO agent_run_instances (
            run_instance_id, owner_session_id, run_id, title, agent, agent_source,
            agent_file_path, definition_fingerprint, task, background, mutating,
            workspace_id, parent_cwd, execution_cwd, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_instance_id) DO NOTHING
    `,
        runInstanceId,
        record.ownerSessionId,
        record.runId,
        record.title ?? "Delegated task",
        record.agent,
        record.agentSource,
        record.agentFilePath ?? null,
        record.definitionFingerprint,
        record.task,
        record.background ? 1 : 0,
        record.mutating ? 1 : 0,
        record.workspaceId ?? null,
        record.parentCwd ?? "",
        record.cwd ?? null,
        record.startedAt,
    );
    const sequenceRow = (await database.get(`
        SELECT COALESCE(MAX(created_sequence), 0) + 1 AS next_sequence
        FROM agent_run_snapshots
    `)) as { next_sequence?: unknown } | undefined;
    if (typeof sequenceRow?.next_sequence !== "number") {
        throw new Error("Could not allocate an agent snapshot sequence.");
    }
    await database.run(
        `
        INSERT INTO agent_run_snapshots (
            snapshot_id, run_instance_id, owner_session_id, run_id,
            payload_version, status, child_session_file, child_session_leaf_id,
            updated_at, payload_json, created_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        snapshotId,
        runInstanceId,
        record.ownerSessionId,
        record.runId,
        AGENT_RUN_SNAPSHOT_PAYLOAD_VERSION,
        record.status,
        record.childSessionFile ?? null,
        record.childSessionLeafId ?? null,
        record.updatedAt,
        JSON.stringify(record),
        sequenceRow.next_sequence,
    );
    return {
        snapshotId,
        runInstanceId,
        ownerSessionId: record.ownerSessionId,
        runId: record.runId,
        payloadVersion: AGENT_RUN_SNAPSHOT_PAYLOAD_VERSION,
        status: record.status,
        ...(record.childSessionFile ? { childSessionFile: record.childSessionFile } : {}),
        childSessionLeafId: record.childSessionLeafId ?? null,
        updatedAt: record.updatedAt,
        payload: record,
        createdSequence: sequenceRow.next_sequence,
    };
}

function rowToSnapshot(row: Record<string, unknown>): AgentRunSnapshotRow | undefined {
    if (
        typeof row.snapshot_id !== "string" ||
        typeof row.run_instance_id !== "string" ||
        typeof row.owner_session_id !== "string" ||
        typeof row.run_id !== "string" ||
        typeof row.payload_version !== "number" ||
        typeof row.status !== "string" ||
        typeof row.updated_at !== "number" ||
        typeof row.payload_json !== "string" ||
        typeof row.created_sequence !== "number"
    )
        return undefined;
    let payload: unknown;
    try {
        payload = JSON.parse(row.payload_json);
    } catch {
        return undefined;
    }
    return {
        snapshotId: row.snapshot_id,
        runInstanceId: row.run_instance_id,
        ownerSessionId: row.owner_session_id,
        runId: row.run_id,
        payloadVersion: row.payload_version,
        status: row.status as AgentRunSnapshotRow["status"],
        ...(typeof row.child_session_file === "string"
            ? { childSessionFile: row.child_session_file }
            : {}),
        childSessionLeafId:
            typeof row.child_session_leaf_id === "string" ? row.child_session_leaf_id : null,
        updatedAt: row.updated_at,
        payload,
        createdSequence: row.created_sequence,
    };
}

/**
 * Upper bound on the placeholders one `IN (...)` statement may carry.
 *
 * The list is driven by how many markers a parent transcript holds, which is unbounded across a long
 * session, so the fetch is chunked instead of assuming a driver limit.
 */
const SNAPSHOT_ID_CHUNK_SIZE = 500;

export async function listAgentRunSnapshotsInDatabase(
    database: AgentMetadataDatabase,
    snapshotIds: string[],
): Promise<AgentRunSnapshotRow[]> {
    const unique = [...new Set(snapshotIds)];
    const snapshots: AgentRunSnapshotRow[] = [];

    for (let offset = 0; offset < unique.length; offset += SNAPSHOT_ID_CHUNK_SIZE) {
        const chunk = unique.slice(offset, offset + SNAPSHOT_ID_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = (await database.all(
            `
            SELECT snapshot_id, run_instance_id, owner_session_id, run_id, payload_version,
                   status, child_session_file, child_session_leaf_id, updated_at,
                   payload_json, created_sequence
            FROM agent_run_snapshots
            WHERE snapshot_id IN (${placeholders})
        `,
            ...chunk,
        )) as Array<Record<string, unknown>>;
        for (const row of rows) {
            const snapshot = rowToSnapshot(row);
            if (snapshot) {
                snapshots.push(snapshot);
            }
        }
    }

    return snapshots;
}
