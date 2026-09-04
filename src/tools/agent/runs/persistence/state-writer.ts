import {
    AgentContinuationLeaseBusyError,
    type AgentContinuationLease,
    type PersistedAgentRun,
} from "../../contracts/runs";
import { type AgentMetadataDatabase } from "../../storage/metadata";
import { upsertAgentRunCatalogRecordInDatabase } from "../../storage/run-catalog";
import {
    insertAgentRunSnapshotInDatabase,
    type AgentRunSnapshotRow,
} from "../../storage/run-snapshots";
import { catalogRecord } from "./catalog-projection";
import { type HeadRow, JournalHeadExpectations, snapshotIdOf } from "./journal-heads";
import {
    CONTINUATION_LEASE_MS,
    ContinuationLeaseLedger,
    ENABLE_PID_LEASE_RECOVERY,
    LEASE_EXPIRED_MESSAGE,
    type LeaseRow,
    isProcessAlive,
} from "./lease-ledger";

export interface AgentRunStateWriter {
    save(record: PersistedAgentRun): Promise<{ ok: true } | { ok: false; error: unknown }>;
    acquireContinuationLease?(
        runInstanceId: string,
        onLost?: () => void,
    ): Promise<AgentContinuationLease>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface AgentRunStateWriterOptions {
    initialHeads?: ReadonlyMap<string, string>;
    requireMarker?: boolean;
}

type AgentRunSaveResult = { ok: true } | { ok: false; error: unknown };

const AGENT_RUN_STORAGE_CLOSED = "Agent run state storage is closed.";

const MISSING_RUN_IDENTITY_MESSAGE = "Delegated run is missing its physical run identity.";

/**
 * Writes durable run state for one parent session.
 *
 * A save runs as two `IMMEDIATE` transactions: the first writes the immutable snapshot row and leaves
 * the continuation head `pending`, the second renews the lease, appends the parent session marker, and
 * settles the head. Splitting it that way means the marker append and the head update cannot interleave
 * with another process claiming the same continuation.
 *
 * Journal ownership model:
 *   - A save is always issued from the parent session that owns the continuation journal.
 *   - A child may append its own durable entries only through `run_parent_session_write`.
 *   - Restoring a checkpoint creates a child-session branch; the parent remains the sole writer of
 *     continuation state, so the branch is presented as a persisted child leaf owned by that parent.
 */
class SqliteAgentRunStateWriter implements AgentRunStateWriter {
    private readonly parentCwd: string;
    private readonly database: AgentMetadataDatabase;
    private readonly appendMarker: (marker: {
        version: 2;
        snapshotId: string;
        runInstanceId: string;
        runId: string;
    }) => string | undefined;
    private readonly requireMarker: boolean;
    private readonly leases: ContinuationLeaseLedger;
    private readonly heads: JournalHeadExpectations;
    private readonly pendingAcquisitions = new Set<Promise<AgentContinuationLease>>();
    private closed = false;
    private acceptingAcquisitions = true;
    private acceptingSaves = true;
    private closePromise: Promise<void> | undefined;
    private saveTail: Promise<void> = Promise.resolve();

    constructor(
        parentCwd: string,
        database: AgentMetadataDatabase,
        appendMarker: (marker: {
            version: 2;
            snapshotId: string;
            runInstanceId: string;
            runId: string;
        }) => string | undefined,
        { initialHeads = new Map(), requireMarker = true }: AgentRunStateWriterOptions = {},
    ) {
        this.parentCwd = parentCwd;
        this.database = database;
        this.appendMarker = appendMarker;
        this.requireMarker = requireMarker;
        this.leases = new ContinuationLeaseLedger(database);
        this.heads = new JournalHeadExpectations(initialHeads);
    }

    async save(record: PersistedAgentRun): Promise<AgentRunSaveResult> {
        if (!this.acceptingSaves) {
            return { ok: false, error: new Error(AGENT_RUN_STORAGE_CLOSED) };
        }

        return this.serializeSave(() => this.persistQueued(record));
    }

    async acquireContinuationLease(
        runInstanceId: string,
        onLost?: () => void,
        allowDuringClose = false,
    ): Promise<AgentContinuationLease> {
        if (this.closed || (!this.acceptingAcquisitions && !allowDuringClose)) {
            throw new Error(AGENT_RUN_STORAGE_CLOSED);
        }
        if (this.leases.isLost(runInstanceId)) {
            throw new Error(
                "Delegated run continuation lease was lost; reload the parent session before retrying.",
            );
        }

        const acquisition = this.claimLease(runInstanceId, onLost);
        this.pendingAcquisitions.add(acquisition);
        try {
            return await acquisition;
        } finally {
            this.pendingAcquisitions.delete(acquisition);
        }
    }

    async flush(): Promise<void> {
        let observedTail: Promise<void>;
        do {
            observedTail = this.saveTail;
            await observedTail;
        } while (observedTail !== this.saveTail);
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;

        this.acceptingSaves = false;
        this.acceptingAcquisitions = false;
        this.closePromise = this.drainAndClose();
        return this.closePromise;
    }

    /** Runs inside the save queue, so `closed` may have flipped since `save` was called. */
    private async persistQueued(record: PersistedAgentRun): Promise<AgentRunSaveResult> {
        if (this.closed) {
            return { ok: false, error: new Error(AGENT_RUN_STORAGE_CLOSED) };
        }
        if (!record.runInstanceId) {
            return { ok: false, error: new Error(MISSING_RUN_IDENTITY_MESSAGE) };
        }

        const runInstanceId = record.runInstanceId;
        let automaticLease: AgentContinuationLease | undefined;
        try {
            automaticLease = await this.acquireLeaseForSave(runInstanceId);
            const snapshot = await this.reserveSnapshot(record, runInstanceId);
            return await this.commitSnapshot(record, runInstanceId, snapshot);
        } catch (error) {
            return { ok: false, error };
        } finally {
            await automaticLease?.release();
        }
    }

    /** A save without an explicit lease claims one for its own duration and releases it afterwards. */
    private async acquireLeaseForSave(
        runInstanceId: string,
    ): Promise<AgentContinuationLease | undefined> {
        if (this.leases.owns(runInstanceId)) return undefined;

        return this.acquireContinuationLease(runInstanceId, undefined, true);
    }

    private async serializeSave<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.saveTail;
        let release!: () => void;
        this.saveTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    /**
     * First transaction: write the snapshot row and reserve the head as pending without touching the
     * parent session. A crash before the second transaction leaves a reserved head that restore
     * resolves from the marker instead of trusting the row.
     */
    private async reserveSnapshot(
        record: PersistedAgentRun,
        runInstanceId: string,
    ): Promise<AgentRunSnapshotRow> {
        return this.database.transaction(async (transaction) => {
            const reserved = (await transaction.get(
                `
                SELECT snapshot_id
                FROM agent_run_continuation_heads
                WHERE run_instance_id = ?
            `,
                runInstanceId,
            )) as HeadRow | undefined;
            this.heads.verify(runInstanceId, snapshotIdOf(reserved));
            await this.verifyLeaseForReserve(transaction, runInstanceId);

            const snapshot = await insertAgentRunSnapshotInDatabase(transaction, record);
            await this.writeHeadRow(transaction, record, runInstanceId, snapshot, 1);
            return snapshot;
        }, "IMMEDIATE");
    }

    /**
     * Second transaction: renew the lease, append the marker, then settle the head as committed.
     *
     * Once the marker is appended the snapshot is authoritative, so a failure in the remaining writes
     * is still a committed save; the head expectation is adopted either way, which is what lets a later
     * save compare against the snapshot this process already wrote.
     */
    private async commitSnapshot(
        record: PersistedAgentRun,
        runInstanceId: string,
        snapshot: AgentRunSnapshotRow,
    ): Promise<AgentRunSaveResult> {
        let markerAppended = false;
        try {
            await this.database.transaction(async (transaction) => {
                await this.renewLeaseForCommit(transaction, runInstanceId);
                await this.verifyReservation(transaction, runInstanceId, snapshot);
                this.appendSnapshotMarker(record, runInstanceId, snapshot);
                markerAppended = true;

                await this.writeHeadRow(transaction, record, runInstanceId, snapshot, 0);
                await this.writeCatalogProjection(transaction, record, snapshot);
            }, "IMMEDIATE");
        } catch (error) {
            if (!markerAppended) return { ok: false, error };
        }

        this.heads.commit(runInstanceId, snapshot.snapshotId);
        return { ok: true };
    }

    /**
     * The reserve transaction may proceed only while this process still holds the lease, or when the
     * row is expired enough to take over. Failing here also drops the in-process claim, so a retry
     * cannot reuse a token the database no longer honours.
     */
    private async verifyLeaseForReserve(
        transaction: AgentMetadataDatabase,
        runInstanceId: string,
    ): Promise<void> {
        const row = (await transaction.get(
            `
              SELECT process_token, lease_until
              FROM agent_run_continuation_leases
              WHERE run_instance_id = ?
            `,
            runInstanceId,
        )) as LeaseRow | undefined;

        const active = this.leases.entryOf(runInstanceId);
        if (typeof row?.lease_until === "number" && row.lease_until > Date.now()) {
            if (!active || row.process_token !== active.token) {
                throw new Error("Delegated run continuation is already owned by another process.");
            }
            return;
        }

        if (active) {
            this.leases.markLost(runInstanceId, active.token);
            throw new Error(LEASE_EXPIRED_MESSAGE);
        }

        if (typeof row?.process_token !== "string") {
            return;
        }

        await transaction.run(
            `
              DELETE FROM agent_run_continuation_leases
              WHERE run_instance_id = ? AND process_token = ?
            `,
            runInstanceId,
            row.process_token,
        );
    }

    /**
     * Renew the lease inside the commit transaction, before the marker is appended. The renewal must
     * share that transaction's write lock, so it cannot be folded into the ledger's timer renewal.
     */
    private async renewLeaseForCommit(
        transaction: AgentMetadataDatabase,
        runInstanceId: string,
    ): Promise<void> {
        const active = this.leases.entryOf(runInstanceId);
        if (!active) {
            throw new Error("Delegated run continuation lease was lost.");
        }

        const renewed = await transaction.run(
            `
              UPDATE agent_run_continuation_leases
              SET lease_until = ?
              WHERE run_instance_id = ? AND process_token = ?
            `,
            Date.now() + CONTINUATION_LEASE_MS,
            runInstanceId,
            active.token,
        );

        if (renewed.changes !== 0) {
            return;
        }

        this.leases.markLost(runInstanceId, active.token);
        throw new Error(LEASE_EXPIRED_MESSAGE);
    }

    /** Reserve leaves exactly one head state the commit transaction may accept. */
    private async verifyReservation(
        transaction: AgentMetadataDatabase,
        runInstanceId: string,
        snapshot: AgentRunSnapshotRow,
    ): Promise<void> {
        const current = (await transaction.get(
            `
            SELECT snapshot_id, pending
            FROM agent_run_continuation_heads
            WHERE run_instance_id = ?
        `,
            runInstanceId,
        )) as HeadRow | undefined;

        if (current?.snapshot_id === snapshot.snapshotId && current.pending === 1) {
            return;
        }

        throw new Error(
            "Delegated run continuation reservation was lost before its marker was committed.",
        );
    }

    private appendSnapshotMarker(
        record: PersistedAgentRun,
        runInstanceId: string,
        snapshot: AgentRunSnapshotRow,
    ): void {
        const markerEntryId = this.appendMarker({
            version: 2,
            snapshotId: snapshot.snapshotId,
            runInstanceId,
            runId: record.runId,
        });

        if (this.requireMarker && typeof markerEntryId !== "string") {
            throw new Error("Parent session marker could not be appended.");
        }
    }

    /** Writes the head row, with `pending` distinguishing a reservation from a committed head. */
    private async writeHeadRow(
        transaction: AgentMetadataDatabase,
        record: PersistedAgentRun,
        runInstanceId: string,
        snapshot: AgentRunSnapshotRow,
        pending: 0 | 1,
    ): Promise<void> {
        await transaction.run(
            `
              INSERT INTO agent_run_continuation_heads (
                  run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence, pending
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (run_instance_id) DO UPDATE SET
                  owner_session_id = excluded.owner_session_id,
                  run_id = excluded.run_id,
                  snapshot_id = excluded.snapshot_id,
                  updated_at = excluded.updated_at,
                  created_sequence = excluded.created_sequence,
                  pending = excluded.pending
            `,
            runInstanceId,
            record.ownerSessionId,
            record.runId,
            snapshot.snapshotId,
            record.updatedAt,
            snapshot.createdSequence,
            pending,
        );
    }

    private async writeCatalogProjection(
        transaction: AgentMetadataDatabase,
        record: PersistedAgentRun,
        snapshot: AgentRunSnapshotRow,
    ): Promise<void> {
        try {
            await upsertAgentRunCatalogRecordInDatabase(transaction, {
                ...catalogRecord(record, this.parentCwd),
                latestSnapshotId: snapshot.snapshotId,
            });
        } catch {
            // Catalog is a lossy projection. The marker/snapshot remains authoritative.
        }
    }

    /** Claim the lease row, then start renewing it. */
    private async claimLease(
        runInstanceId: string,
        onLost?: () => void,
    ): Promise<AgentContinuationLease> {
        const now = Date.now();
        const leaseToken = this.leases.nextToken();

        await this.database.transaction(async (transaction) => {
            const head = (await transaction.get(
                `
                  SELECT snapshot_id, owner_session_id
                  FROM agent_run_continuation_heads
                  WHERE run_instance_id = ?
                `,
                runInstanceId,
            )) as HeadRow | undefined;

            this.heads.verify(runInstanceId, snapshotIdOf(head));
            await this.claimLeaseRow(transaction, runInstanceId, head, leaseToken, now);
        }, "IMMEDIATE");

        this.leases.watch(runInstanceId, leaseToken, onLost);
        return { release: () => this.leases.release(runInstanceId, leaseToken) };
    }

    private async claimLeaseRow(
        transaction: AgentMetadataDatabase,
        runInstanceId: string,
        head: HeadRow | undefined,
        leaseToken: string,
        now: number,
    ): Promise<void> {
        const existing = (await transaction.get(
            `
              SELECT process_token, owner_pid, lease_until
              FROM agent_run_continuation_leases
              WHERE run_instance_id = ?
            `,
            runInstanceId,
        )) as LeaseRow | undefined;

        const heldUntil = this.heldLeaseUntil(existing, now);
        if (heldUntil !== undefined) {
            throw new AgentContinuationLeaseBusyError(heldUntil);
        }

        await transaction.run(
            `
              INSERT INTO agent_run_continuation_leases (
                  run_instance_id, owner_session_id, process_token, owner_pid, lease_until
              ) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (run_instance_id) DO UPDATE SET
                  owner_session_id = excluded.owner_session_id,
                  process_token = excluded.process_token,
                  owner_pid = excluded.owner_pid,
                  lease_until = excluded.lease_until
            `,
            runInstanceId,
            typeof head?.owner_session_id === "string" ? head.owner_session_id : "",
            leaseToken,
            process.pid,
            now + CONTINUATION_LEASE_MS,
        );
    }

    /**
     * The expiry of a lease that still blocks a claim, or undefined when the row can be taken over.
     * A dead owner process releases its lease early instead of waiting for it to expire.
     */
    private heldLeaseUntil(row: LeaseRow | undefined, now: number): number | undefined {
        if (typeof row?.lease_until !== "number" || row.lease_until <= now) {
            return undefined;
        }

        if (!ENABLE_PID_LEASE_RECOVERY) {
            return row.lease_until;
        }

        if (typeof row.owner_pid !== "number") {
            return row.lease_until;
        }

        return isProcessAlive(row.owner_pid) ? row.lease_until : undefined;
    }

    /**
     * Close ordering: stop accepting work, drain queued saves, drain in-flight lease acquisitions, then
     * release the leases those acquisitions created before closing the database handle. Releasing
     * first would let a late save see a closed database.
     */
    private async drainAndClose(): Promise<void> {
        await this.saveTail;
        while (this.pendingAcquisitions.size > 0) {
            await Promise.allSettled([...this.pendingAcquisitions]);
        }
        await Promise.all(
            this.leases
                .live()
                .map(([runInstanceId, active]) => this.leases.release(runInstanceId, active.token)),
        );

        this.closed = true;
        await this.database.close();
    }
}

export function createAgentRunStateWriter(
    parentCwd: string,
    database: AgentMetadataDatabase,
    appendMarker: (marker: {
        version: 2;
        snapshotId: string;
        runInstanceId: string;
        runId: string;
    }) => string | undefined,
    options: AgentRunStateWriterOptions = {},
): AgentRunStateWriter {
    return new SqliteAgentRunStateWriter(parentCwd, database, appendMarker, options);
}
