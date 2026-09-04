import { type AgentMetadataDatabase } from "../../storage/metadata";

export type ContinuationHead = {
    ownerSessionId: string;
    snapshotId: string;
    runId: string;
    updatedAt: number;
    createdSequence: number;
};

export async function initializeAgentRunContinuationHeads(
    database: AgentMetadataDatabase,
    heads: ReadonlyMap<string, ContinuationHead>,
): Promise<void> {
    if (heads.size === 0) {
        return;
    }

    await database.transaction(async (transaction) => {
        for (const [runInstanceId, head] of heads) {
            await transaction.run(
                `
                  INSERT INTO agent_run_continuation_heads (
                      run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence, pending
                  ) VALUES (?, ?, ?, ?, ?, ?, 0)
                  ON CONFLICT (run_instance_id) DO UPDATE SET
                      owner_session_id = excluded.owner_session_id,
                      run_id = excluded.run_id,
                      snapshot_id = excluded.snapshot_id,
                      updated_at = excluded.updated_at,
                      created_sequence = excluded.created_sequence,
                      pending = 0
                  WHERE excluded.created_sequence > agent_run_continuation_heads.created_sequence
                    OR (
                        agent_run_continuation_heads.pending = 1
                        AND NOT EXISTS (
                            SELECT 1 FROM agent_run_continuation_leases
                            WHERE run_instance_id = agent_run_continuation_heads.run_instance_id
                              AND lease_until > ?
                        )
                    )
                `,
                runInstanceId,
                head.ownerSessionId,
                head.runId,
                head.snapshotId,
                head.updatedAt,
                head.createdSequence,
                Date.now(),
            );
        }
    }, "IMMEDIATE");
}

/** A continuation-heads row as read by the writer. */
export type HeadRow = {
    snapshot_id?: string;
    owner_session_id?: string;
    pending?: number;
};

const STALE_CONTINUATION_MESSAGE =
    "Delegated run continuation is stale; another process has already continued it.";

export function snapshotIdOf(row: HeadRow | undefined): string | undefined {
    return typeof row?.snapshot_id === "string" ? row.snapshot_id : undefined;
}

/**
 * What this process expects each continuation-heads row to hold, used as a compare-and-set guard.
 *
 * The first read of a run adopts whatever the row currently says, so a save can never fail merely
 * because this process has not looked yet; every later read must agree with the last adopted value.
 * Committing a snapshot adopts it, which is what makes the marker append safe to attempt again.
 */
export class JournalHeadExpectations {
    private readonly expected = new Map<string, string | undefined>();
    private readonly known = new Set<string>();

    constructor(initial: ReadonlyMap<string, string>) {
        for (const [runInstanceId, snapshotId] of initial) {
            this.expected.set(runInstanceId, snapshotId);
            this.known.add(runInstanceId);
        }
    }

    verify(runInstanceId: string, actual: string | undefined): void {
        if (!this.known.has(runInstanceId)) {
            this.expected.set(runInstanceId, actual);
            this.known.add(runInstanceId);
            return;
        }
        if (this.expected.get(runInstanceId) === actual) return;

        throw new Error(STALE_CONTINUATION_MESSAGE);
    }

    commit(runInstanceId: string, snapshotId: string): void {
        this.expected.set(runInstanceId, snapshotId);
        this.known.add(runInstanceId);
    }
}
