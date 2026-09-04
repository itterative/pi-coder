import { randomUUID } from "node:crypto";
import { type AgentMetadataDatabase } from "../../storage/metadata";

export const CONTINUATION_LEASE_MS = 30_000;

// Pi and its child-agent runtime share one process, so a dead owner PID is a
// useful fast path for reclaiming a lease left by an abrupt process exit.
export const ENABLE_PID_LEASE_RECOVERY = true;

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but is not signalable. Unknown errors
        // fail closed and fall back to normal lease expiry.
        return error instanceof Error && (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/** An in-process continuation lease with its renewal timer and loss callback. */
type LiveLease = {
    token: string;
    timer: ReturnType<typeof setInterval>;
    onLost?: () => void;
};

/** A continuation-leases row as read by the writer. */
export type LeaseRow = {
    process_token?: string;
    owner_pid?: number;
    lease_until?: number;
};

export const LEASE_EXPIRED_MESSAGE = "Delegated run continuation lease expired or was lost.";

/**
 * In-process bookkeeping for continuation leases and their `agent_run_continuation_leases` rows.
 *
 * A lease is claimed by a transaction that writes the row, then kept alive by a renewal timer. Losing
 * a lease is sticky: once the row no longer proves ownership, the run id is recorded as lost and every
 * later claim for it fails until the parent session reloads.
 */
export class ContinuationLeaseLedger {
    private readonly processToken = randomUUID();
    private readonly active = new Map<string, LiveLease>();
    private readonly lost = new Set<string>();

    constructor(private readonly database: AgentMetadataDatabase) {}

    /** Lease tokens name this process so a row can be traced back to the writer that claimed it. */
    nextToken(): string {
        return `${this.processToken}:${randomUUID()}`;
    }

    entryOf(runInstanceId: string): LiveLease | undefined {
        return this.active.get(runInstanceId);
    }

    owns(runInstanceId: string): boolean {
        return this.active.has(runInstanceId);
    }

    isLost(runInstanceId: string): boolean {
        return this.lost.has(runInstanceId);
    }

    live(): Array<[string, LiveLease]> {
        return [...this.active.entries()];
    }

    /** Start renewing a claimed row. The timer keeps the ledger and the row in agreement. */
    watch(runInstanceId: string, token: string, onLost?: () => void): void {
        const timer = setInterval(() => {
            void this.renew(runInstanceId, token);
        }, CONTINUATION_LEASE_MS / 3);
        timer.unref?.();
        this.active.set(runInstanceId, { token, timer, onLost });
    }

    /** Stop trusting a lease once, keeping the first loss sticky for the rest of the process. */
    markLost(runInstanceId: string, token: string): void {
        const active = this.active.get(runInstanceId);
        if (!active || active.token !== token) {
            return;
        }

        clearInterval(active.timer);
        this.active.delete(runInstanceId);
        this.lost.add(runInstanceId);
        active.onLost?.();
    }

    /** A renewal that no longer matches the row means another process holds the lease now. */
    async renew(runInstanceId: string, token: string): Promise<void> {
        let lost: boolean;
        try {
            const result = await this.database.transaction(
                (transaction) =>
                    transaction.run(
                        `
                            UPDATE agent_run_continuation_leases
                            SET lease_until = ?
                            WHERE run_instance_id = ? AND process_token = ?
                        `,
                        Date.now() + CONTINUATION_LEASE_MS,
                        runInstanceId,
                        token,
                    ),
                "IMMEDIATE",
            );
            lost = result.changes === 0;
        } catch {
            lost = true;
        }

        if (!lost) {
            return;
        }

        this.markLost(runInstanceId, token);
    }

    async release(runInstanceId: string, token: string): Promise<void> {
        const active = this.active.get(runInstanceId);
        if (!active || active.token !== token) {
            return;
        }

        clearInterval(active.timer);
        // Drop the in-process claim before awaiting the DELETE. A save issued while this release is
        // still in flight must not read the entry as live ownership, then find it gone by the time it
        // renews; the queued DELETE runs first, so that save takes a fresh lease of its own instead.
        this.active.delete(runInstanceId);
        try {
            await this.database.transaction(async (transaction) => {
                await transaction.run(
                    `
                      DELETE FROM agent_run_continuation_leases
                      WHERE run_instance_id = ? AND process_token = ?
                    `,
                    runInstanceId,
                    token,
                );
            }, "IMMEDIATE");
        } catch {
            // Lease expiry remains the recovery path after a release failure.
        }
    }
}
