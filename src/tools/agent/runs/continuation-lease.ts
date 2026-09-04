import { sleep } from "../../../common/async";
import type { AgentContinuationLease, AgentRunPersistence } from "../contracts/runs";
import {
    type AgentRun,
    CONTINUATION_LEASE_RECOVERY_GRACE_MS,
    CONTINUATION_LEASE_RECOVERY_TIMEOUT_MS,
    continuationLeaseRetryAt,
} from "./run-state";

export interface ContinuationLeaseDependencies {
    /** Current durable persistence integration; leases only exist when it uses snapshot markers. */
    readonly getPersistence: () => AgentRunPersistence | undefined;
    /** Whether the parent manager is shutting down, which must end any lease wait. */
    readonly isClosing: () => boolean;
    /** Aborted when the manager stops accepting restored or background work. */
    readonly shutdownSignal: AbortSignal;
    /** Stop the run whose lease was taken away, so it can settle as interrupted. */
    readonly abortRun: (run: AgentRun) => Promise<void> | undefined;
}

/**
 * Owns durable continuation-lease acquisition and loss handling for one manager.
 *
 * A lease declares that exactly one manager intends to keep a logical run going, so it is
 * acquired before any child session is reopened or prompted and released once the run reaches
 * a boundary where another manager may safely take over. Lease loss is asynchronous: the
 * holder is notified, the run is aborted, and lifecycle code settles it as interrupted.
 *
 * This collaborator deliberately does not decide *when* a lease is required, released, or
 * retained; ordered lifecycle code in the manager and restore coordinator keeps that control.
 */
export class AgentRunLeaseCoordinator {
    constructor(private readonly dependencies: ContinuationLeaseDependencies) {}

    /**
     * Reserve a lease for a run instance that is not registered locally yet.
     *
     * Returns `undefined` when no durable lease protocol is active or the run instance is unknown.
     * Callers resolve the instance ID from their own registry or checkpoint cache so this class
     * stays free of run lookup policy.
     */
    async reserve(runInstanceId: string | undefined): Promise<AgentContinuationLease | undefined> {
        const grantLease = this.leaseGrantor();
        if (!runInstanceId || !grantLease) {
            return undefined;
        }
        return grantLease(runInstanceId);
    }

    /** Attach a lease to the run, or return without leasing when persistence does not require one. */
    async acquire(run: AgentRun): Promise<void> {
        if (run.continuationLease) {
            return;
        }
        const grantLease = this.leaseGrantor();
        if (!grantLease) {
            return;
        }
        run.continuationLease = await grantLease(run.runInstanceId, () => {
            run.continuationLeaseLost = true;
            void this.dependencies.abortRun(run)?.catch(() => {});
        });
    }

    /**
     * Acquire the lease or wait until its previous holder's expiry passes.
     *
     * A busy lease reports when it becomes reclaimable; the loop waits exactly that long plus a
     * small grace margin, bounded overall by `CONTINUATION_LEASE_RECOVERY_TIMEOUT_MS`. It returns
     * `false` (without throwing) when the caller's signal or manager shutdown ends the wait, so
     * callers can treat losing the race as "do not run" rather than as a failure.
     */
    async acquireWithRecovery(run: AgentRun, signal: AbortSignal): Promise<boolean> {
        const deadline = Date.now() + CONTINUATION_LEASE_RECOVERY_TIMEOUT_MS;

        while (true) {
            if (this.dependencies.isClosing() || signal.aborted) {
                return false;
            }

            try {
                await this.acquire(run);
                return true;
            } catch (error) {
                const retryAt = continuationLeaseRetryAt(error);
                if (retryAt === undefined || Date.now() >= deadline) {
                    throw error;
                }

                const remaining = deadline - Date.now();
                const delay = Math.max(
                    1,
                    retryAt - Date.now() + CONTINUATION_LEASE_RECOVERY_GRACE_MS,
                );
                try {
                    await sleep(Math.min(delay, remaining), signal);
                } catch (sleepError) {
                    if (signal.aborted || this.dependencies.isClosing()) {
                        return false;
                    }
                    throw sleepError;
                }
            }
        }
    }

    /** Combine the caller's signal with manager shutdown so no lease wait can outlive the session. */
    recoverySignal(signal?: AbortSignal): AbortSignal {
        if (!signal) {
            return this.dependencies.shutdownSignal;
        }
        return AbortSignal.any([this.dependencies.shutdownSignal, signal]);
    }

    /**
     * Release the run's lease if it still holds one.
     *
     * A failed release is ignored deliberately: the lease expires on its own, and retrying here
     * could not distinguish our lease from one another holder already took.
     */
    async release(run: AgentRun): Promise<void> {
        const lease = run.continuationLease;
        if (!lease) {
            return;
        }
        run.continuationLease = undefined;
        try {
            await lease.release();
        } catch {
            // Lease expiry remains the recovery path after a release failure.
        }
    }

    /**
     * The durable lease grantor, or `undefined` when the lease protocol is inactive.
     *
     * Only V2 snapshot-marker persistence tracks continuation leases; legacy checkpoints keep
     * their previous single-manager ownership assumption and grant no lease at all.
     */
    private leaseGrantor(): AgentRunPersistence["acquireContinuationLease"] {
        const persistence = this.dependencies.getPersistence();
        if (persistence?.usesSnapshotMarkers !== true) {
            return undefined;
        }
        const grant = persistence.acquireContinuationLease;
        if (!grant) {
            return undefined;
        }
        // The grantor escapes the persistence object and is later called as a plain function, so bind
        // the receiver here: an implementation backed by a class would otherwise lose its state.
        return (runInstanceId, onLost) => grant.call(persistence, runInstanceId, onLost);
    }
}
