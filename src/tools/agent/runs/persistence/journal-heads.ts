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
 * What this process believes about one physical run's checkpoint journal.
 *
 * `head` is the snapshot id this process last saw or committed. An entry that exists with `head`
 * `undefined` means the head row was empty when this process first looked, which is a different state
 * from having never looked at the run at all.
 */
export interface RunJournalEntry {
    head?: string;
}

/**
 * This process's view of the durable continuation journal, one entry per physical run.
 *
 * The entry map is the whole state: which checkpoint each run is at, and whether this process has looked at
 * it yet. `agent_run_continuation_heads` stays the durable authority; this is the belief about it that lets
 * a save prove it is writing the next checkpoint of the run it read instead of overwriting one another
 * parent already continued. Both the lease claim and the reserve transaction verify against it first.
 *
 * Two rules the single map must keep, because every other persistence invariant leans on them:
 *
 * 1. The first read of a run adopts whatever the row currently says, so a save can never fail merely because
 *    this process has not looked yet.
 * 2. Committing a snapshot adopts it even when the writes after the marker append failed, because the parent
 *    transcript already references that snapshot.
 */
export class AgentRunJournalState {
    private readonly entries = new Map<string, RunJournalEntry>();

    constructor(initialHeads: ReadonlyMap<string, string> = new Map()) {
        for (const [runInstanceId, snapshotId] of initialHeads) {
            this.entries.set(runInstanceId, { head: snapshotId });
        }
    }

    /**
     * Adopt the run's current head on the first look, or reject a head that moved since then.
     *
     * `actual` is what the heads row holds right now, including `undefined` for a run with no row yet.
     */
    verify(runInstanceId: string, actual: string | undefined): void {
        const entry = this.entries.get(runInstanceId);
        if (!entry) {
            this.entries.set(runInstanceId, { head: actual });
            return;
        }
        if (entry.head === actual) {
            return;
        }

        throw new Error(STALE_CONTINUATION_MESSAGE);
    }

    /** Adopt the snapshot this process just committed as the run's head. */
    commit(runInstanceId: string, snapshotId: string): void {
        this.entries.set(runInstanceId, { head: snapshotId });
    }
}
