import { isAgentTerminalStatus } from "../contracts/runs";
import type { AgentRunPersistence, PersistedAgentRun } from "../contracts/runs";
import { snapshotAgentDefinition } from "../definitions/types";
import { mutationReport, progressSnapshot, readUsage } from "./projection";
import { type AgentRun, truncate } from "./run-state";
import { cloneUsage } from "./usage";

const MAX_PENDING_PERSISTENCE_WAIT_ITERATIONS = 100;

/**
 * Owns durable run checkpoint projection and per-run write ordering.
 *
 * The lifecycle manager decides when a checkpoint is required; this collaborator only turns the
 * current in-memory state into a record and ensures removal cannot race an earlier save.
 */
export class AgentRunCheckpointStore {
    private persistence?: AgentRunPersistence;
    private readonly persistedRuns = new Map<string, PersistedAgentRun>();
    private readonly pendingPersistence = new Map<string, Promise<boolean>>();

    constructor(private readonly maxTaskChars: number) {}

    get hasPersistence(): boolean {
        return this.persistence !== undefined;
    }

    get integration(): AgentRunPersistence | undefined {
        return this.persistence;
    }

    setPersistence(persistence: AgentRunPersistence | undefined): void {
        this.persistence = persistence;
        this.persistedRuns.clear();
    }

    get(runId: string): PersistedAgentRun | undefined {
        return this.persistedRuns.get(runId);
    }

    /**
     * Replace the cached checkpoints with the records of the active parent branch.
     *
     * Called during restoration, because the previous cache belongs to a different branch and must
     * not be treated as authority.
     */
    replace(records: readonly PersistedAgentRun[]): void {
        this.persistedRuns.clear();
        for (const record of records) {
            this.persistedRuns.set(record.runId, record);
        }
    }

    /**
     * Attach the latest exact workspace result to a checkpoint without reopening the run.
     *
     * Used after disposition of an isolated result. A run that is still live in this process is
     * updated through `save` instead, so this returns `false` when no cached record exists.
     */
    async updateWorkspaceResult(runId: string, resultId: string): Promise<boolean> {
        const persisted = this.persistedRuns.get(runId);
        if (!persisted) {
            return false;
        }
        const updated: PersistedAgentRun = {
            ...persisted,
            workspaceResultId: resultId,
            updatedAt: Date.now(),
        };
        if (this.persistence && !(await this.persistence.save(updated))) {
            return false;
        }
        this.persistedRuns.set(runId, updated);
        return true;
    }

    /** Wait for queued writes to reach storage. */
    async flush(): Promise<void> {
        await this.persistence?.flush?.();
    }

    /** Flush and close the durable integration; the cache is left intact for late teardown. */
    async close(): Promise<void> {
        await this.persistence?.close?.();
    }

    /**
     * Start a checkpoint write and register it as this run's pending operation.
     *
     * Only the newest write per run is tracked, since an older one finishing first is harmless; the
     * tracked promise is what `waitForPending` uses to keep a removal tombstone from racing saves
     * that were already in flight.
     */
    save(run: AgentRun, status?: PersistedAgentRun["status"]): Promise<boolean> {
        const operation = this.saveNow(run, status);
        this.pendingPersistence.set(run.id, operation);
        void operation.then(
            () => this.clearPending(run.id, operation),
            () => this.clearPending(run.id, operation),
        );
        return operation;
    }

    /**
     * Wait until the run has no newer pending checkpoint than the one being awaited.
     *
     * Bounded by an iteration guard rather than left to converge: a persistently rescheduled write
     * would otherwise hang teardown forever, and exceeding the guard is a genuine persistence bug
     * worth surfacing.
     */
    async waitForPending(runId: string): Promise<void> {
        for (
            let iteration = 0;
            iteration < MAX_PENDING_PERSISTENCE_WAIT_ITERATIONS;
            iteration += 1
        ) {
            const pending = this.pendingPersistence.get(runId);
            if (!pending) {
                return;
            }
            await pending.catch(() => {});
        }
        throw new Error(`SQLite persistence did not settle before removing agent run ${runId}.`);
    }

    private clearPending(runId: string, operation: Promise<boolean>): void {
        if (this.pendingPersistence.get(runId) === operation) {
            this.pendingPersistence.delete(runId);
        }
    }

    /**
     * Project the live run into a durable record and write it, caching only on success.
     *
     * Rules that must keep their current behaviour:
     *
     * 1. Without persistence configured nothing is cached, so callers see `false` and decide how to
     *    handle a checkpoint they cannot trust.
     * 2. Under snapshot markers a run that lost its continuation lease is never written: another
     *    parent owns that transcript now, and overwriting it would destroy their state.
     * 3. `waiting_for_permission` is transient UI state and durable as plain `running`.
     * 4. A `removed` tombstone over a terminal run also records `terminalStatus`, so browsing can
     *    still tell completed from failed.
     * 5. The volatile `todo` progress is stripped and usage, progress, and mutation reports are read
     *    through their projections so the stored record is a snapshot, not a live reference.
     * 6. The transcript leaf is refreshed from the handle before projection, because the leaf is what
     *    a later restore uses to decide where the child stopped.
     */
    private async saveNow(run: AgentRun, status?: PersistedAgentRun["status"]): Promise<boolean> {
        if (!this.persistence) {
            return false;
        }
        if (this.persistence.usesSnapshotMarkers && run.continuationLeaseLost) {
            return false;
        }
        const durableStatus: PersistedAgentRun["status"] =
            status ?? (run.status === "waiting_for_permission" ? "running" : run.status);
        const terminalStatus =
            durableStatus === "removed" && isAgentTerminalStatus(run.status)
                ? run.status
                : undefined;
        const progress = progressSnapshot(run);
        const durableProgress = { ...progress };
        delete durableProgress.todo;
        const usageSnapshot = readUsage(run);
        const terminal = run.terminalOutcome;
        run.childSessionLeafId = run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId;
        const persisted: PersistedAgentRun = {
            version: 1,
            ownerSessionId: this.persistence.ownerSessionId,
            ownerPid: process.pid,
            runId: run.id,
            runInstanceId: run.runInstanceId,
            title: run.title,
            agent: run.agent,
            agentSource: run.agentSource,
            agentFilePath: run.agentFilePath,
            definitionFingerprint: run.definitionFingerprint,
            ...(run.definition
                ? { definitionSnapshot: snapshotAgentDefinition(run.definition) }
                : {}),
            task: truncate(run.task, this.maxTaskChars),
            status: durableStatus,
            ...(terminalStatus ? { terminalStatus } : {}),
            background: run.background,
            mutating: run.mutating,
            workspaceId: run.workspaceId,
            workspaceResultId: run.workspaceResultId,
            question: run.question,
            progress: durableProgress,
            usageCheckpoint: cloneUsage(run.usageCheckpoint),
            usageSnapshot,
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
            parentCwd: run.parentCwd,
            cwd: run.cwd,
            childSessionFile: run.childSessionFile,
            childSessionLeafId: run.childSessionLeafId,
            resumable: run.resumable,
            readOnlyReason: run.readOnlyReason,
            terminalContent: terminal?.content,
            terminalError: terminal?.details.error,
            terminalIsError: terminal?.isError,
            setupFailed: run.setupFailed,
            mutationReport: mutationReport(run),
        };
        const saved = await this.persistence.save(persisted);
        if (saved) {
            this.persistedRuns.set(run.id, persisted);
        }
        return saved;
    }
}
