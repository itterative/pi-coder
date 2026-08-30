import path from "node:path";

import { PI_CODER_WORKSPACES_DIR } from "../../../common/constants";
import type { PersistedAgentRun } from "../contracts/runs";
import { openAgentMetadataDatabase, type AgentMetadataDatabase } from "./metadata";

export interface AgentRunStateRow {
    branchEntryId: string;
    updatedAt: number;
    state: unknown;
}

export async function upsertAgentRunStateInDatabase(
    database: AgentMetadataDatabase,
    record: PersistedAgentRun,
    branchEntryId: string,
): Promise<void> {
    await database.run(
        `
        INSERT INTO agent_run_states (
            owner_session_id, run_id, branch_entry_id, updated_at, state_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (owner_session_id, run_id, branch_entry_id) DO UPDATE SET
            updated_at = excluded.updated_at,
            state_json = excluded.state_json
        WHERE excluded.updated_at >= agent_run_states.updated_at
    `,
        record.ownerSessionId,
        record.runId,
        branchEntryId,
        record.updatedAt,
        JSON.stringify(record),
    );
}

export async function listAgentRunStatesInDatabase(
    database: AgentMetadataDatabase,
    ownerSessionId: string,
    branchEntryIds: string[],
): Promise<AgentRunStateRow[]> {
    if (branchEntryIds.length === 0) return [];

    const placeholders = branchEntryIds.map(() => "?").join(", ");
    const rows = (await database.all(
        `
        SELECT branch_entry_id, updated_at, state_json
        FROM agent_run_states
        WHERE owner_session_id = ?
          AND branch_entry_id IN (${placeholders})
        ORDER BY updated_at ASC, rowid ASC
    `,
        ownerSessionId,
        ...branchEntryIds,
    )) as Array<Record<string, unknown>>;

    return rows.flatMap((row) => {
        if (
            typeof row.branch_entry_id !== "string" ||
            typeof row.updated_at !== "number" ||
            typeof row.state_json !== "string"
        )
            return [];
        try {
            return [
                {
                    branchEntryId: row.branch_entry_id,
                    updatedAt: row.updated_at,
                    state: JSON.parse(row.state_json),
                },
            ];
        } catch {
            return [];
        }
    });
}

export async function listAgentRunStates(
    ownerSessionId: string,
    branchEntryIds: string[],
    workspacesDir = PI_CODER_WORKSPACES_DIR,
): Promise<AgentRunStateRow[]> {
    const database = await openAgentMetadataDatabase(workspacesDir);
    try {
        return await listAgentRunStatesInDatabase(database, ownerSessionId, branchEntryIds);
    } finally {
        await database.close();
    }
}

export function defaultAgentRunWorkspacesDir(agentSessionsDir: string): string {
    return path.join(path.dirname(path.resolve(agentSessionsDir)), "workspaces");
}
