import type { ChildProgress } from "../contracts/runs";
import { type AgentMetadataDatabase } from "./metadata";

/** The only statuses the working-state table can hold: a run that has not reached a checkpoint boundary. */
export type AgentRunWorkingStatus = "starting" | "running";

/**
 * The single durable progress row a physical run keeps between checkpoints.
 *
 * `progress` is the parsed payload, not a validated one: like a snapshot row's payload, it is untrusted
 * stored data, and `runs/persistence/stored-record.ts` owns coercing it. `undefined` from a read means the
 * row was missing or shaped so poorly that it cannot describe a run.
 */
export interface AgentRunWorkingState {
    runInstanceId: string;
    ownerSessionId: string;
    runId: string;
    status: AgentRunWorkingStatus;
    childSessionFile?: string;
    childSessionLeafId: string | null;
    progress: unknown;
    updatedAt: number;
}

/** What a caller writes; `progress` is the volatile projection, so it is typed rather than validated here. */
export interface AgentRunWorkingStateInput extends Omit<AgentRunWorkingState, "progress"> {
    progress: ChildProgress;
}

const WORKING_STATUSES: readonly string[] = ["starting", "running"];

/**
 * Whether a status can live in the working-state table at all.
 *
 * Takes any status-shaped string because callers ask about both a persisted record's status and a stored
 * row's, and only the unclean pair is ever allowed here: a checkpoint-boundary status belongs in
 * `agent_run_snapshots`, where a parent marker can pin it.
 */
export function isAgentRunWorkingStatus(status: string): status is AgentRunWorkingStatus {
    return WORKING_STATUSES.includes(status);
}

/**
 * Replace the run's working row wholesale.
 *
 * There is exactly one row per physical run, so a save that advances progress overwrites the previous one
 * instead of appending: this table must not grow with the child's message count. The status column cannot be
 * wrong through the typed input, so the table's own `CHECK` is the write-side guard; the read side still
 * validates, because a row written by another build is untrusted data.
 */
export async function upsertAgentRunWorkingStateInDatabase(
    database: AgentMetadataDatabase,
    state: AgentRunWorkingStateInput,
): Promise<void> {
    if (!state.runInstanceId) {
        throw new Error("Cannot persist working state without a physical run identity.");
    }

    await database.run(
        `
        INSERT INTO agent_run_working_state (
            run_instance_id, owner_session_id, run_id, status,
            child_session_file, child_session_leaf_id, progress_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_instance_id) DO UPDATE SET
            owner_session_id = excluded.owner_session_id,
            run_id = excluded.run_id,
            status = excluded.status,
            child_session_file = excluded.child_session_file,
            child_session_leaf_id = excluded.child_session_leaf_id,
            progress_json = excluded.progress_json,
            updated_at = excluded.updated_at
    `,
        state.runInstanceId,
        state.ownerSessionId,
        state.runId,
        state.status,
        state.childSessionFile ?? null,
        state.childSessionLeafId,
        JSON.stringify(state.progress),
        state.updatedAt,
    );
}

function rowToWorkingState(row: Record<string, unknown>): AgentRunWorkingState | undefined {
    if (
        typeof row.run_instance_id !== "string" ||
        typeof row.owner_session_id !== "string" ||
        typeof row.run_id !== "string" ||
        typeof row.status !== "string" ||
        !isAgentRunWorkingStatus(row.status) ||
        typeof row.progress_json !== "string" ||
        typeof row.updated_at !== "number"
    ) {
        return undefined;
    }

    let progress: unknown;
    try {
        progress = JSON.parse(row.progress_json);
    } catch {
        return undefined;
    }

    return {
        runInstanceId: row.run_instance_id,
        ownerSessionId: row.owner_session_id,
        runId: row.run_id,
        status: row.status,
        ...(typeof row.child_session_file === "string"
            ? { childSessionFile: row.child_session_file }
            : {}),
        childSessionLeafId:
            typeof row.child_session_leaf_id === "string" ? row.child_session_leaf_id : null,
        progress,
        updatedAt: row.updated_at,
    };
}

/** The run's current working row, or `undefined` when there is none or it cannot describe a run. */
export async function readAgentRunWorkingStateInDatabase(
    database: AgentMetadataDatabase,
    runInstanceId: string,
): Promise<AgentRunWorkingState | undefined> {
    const row = (await database.get(
        `
        SELECT run_instance_id, owner_session_id, run_id, status,
               child_session_file, child_session_leaf_id, progress_json, updated_at
        FROM agent_run_working_state
        WHERE run_instance_id = ?
    `,
        runInstanceId,
    )) as Record<string, unknown> | undefined;
    return row ? rowToWorkingState(row) : undefined;
}

/** Drop the run's working row, which is what a committed checkpoint does. */
export async function clearAgentRunWorkingStateInDatabase(
    database: AgentMetadataDatabase,
    runInstanceId: string,
): Promise<void> {
    await database.run(
        `
        DELETE FROM agent_run_working_state WHERE run_instance_id = ?
    `,
        runInstanceId,
    );
}
