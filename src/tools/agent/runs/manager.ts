import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";

import {
    agentCanEdit,
    fingerprintAgentDefinition,
    snapshotAgentDefinition,
    type AgentDefinition,
} from "../definitions/types";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventPayload, AgentEventSink } from "../contracts/events";
import {
    isAgentTerminalStatus,
    type AgentBackgroundCallback,
    type AgentContinuationLease,
    type AgentProgressCallback,
    type AgentRunCheckpointIntent,
    type AgentRunDetails,
    type AgentRunOutcome,
    type AgentRunPersistence,
    type AgentRunStatus,
    type AgentRunSummary,
    type AgentTerminalStatus,
    type AgentWorkspaceCheckpointCallback,
    type AgentWorkspaceCheckpointRequest,
    type ChildAgentFactory,
    type ChildAgentHandle,
    type ChildProgress,
    type ParentQuestion,
    type PersistedAgentRun,
} from "../contracts/runs";
import type { AgentTraceData, AgentTraceSink } from "../contracts/trace";
import { renderAgentTask } from "../prompts/renderer";
import { cloneUsage, ZERO_USAGE } from "./usage";
import {
    BACKGROUND_AGENT_WAIT_GUIDANCE,
    INTERRUPTED_RESUME_GUIDANCE,
    MAX_GUIDANCE_CHARS,
    MAX_OUTPUT_CHARS,
    MAX_TASK_CHARS,
    type AgentRun,
    type AgentStartContext,
    AgentActionError,
    countActiveRuns,
    deriveAgentTitle,
    emptyProgress,
    mutationRunsConflict,
    RUN_DEFAULT_FLAGS,
    truncate,
} from "./run-state";
import {
    captureChildSessionLeaf,
    mutationReport,
    progressSnapshot,
    runDetails,
    runOutcome,
    runSummary,
    statusContent,
    waitingContent,
} from "./projection";
import { AgentRunRegistry } from "./registry";
import { AgentRunCheckpointStore } from "./checkpoint-store";
import { AgentRunLeaseCoordinator } from "./continuation-lease";
import { createChildFactoryContext, type ChildSetupHooks } from "./child-setup";
import { AgentRunRestoreCoordinator } from "./restore";

export { ZERO_USAGE } from "./usage";
export {
    AgentActionError,
    BACKGROUND_AGENT_WAIT_GUIDANCE,
    INTERRUPTED_RESUME_GUIDANCE,
    deriveAgentTitle,
} from "./run-state";

export type {
    AgentBackgroundCallback,
    AgentContinuationLease,
    AgentProgressCallback,
    AgentWorkspaceCheckpointCallback,
    AgentRunDetails,
    AgentRunOutcome,
    AgentRunPersistence,
    AgentRunStatus,
    AgentRunSummary,
    ChildAgentFactory,
    ChildAgentFactoryContext,
    ChildAgentHandle,
    ChildProgress,
    ParentQuestion,
    PersistedAgentRun,
} from "../contracts/runs";
export type { WorkerMutationReport } from "../contracts/mutations";

export interface AgentRunIdentity {
    runId: string;
    runInstanceId: string;
}

/** Named controls for starting a delegated agent run. */
export interface AgentStartOptions {
    signal?: AbortSignal;
    onProgress?: AgentProgressCallback;
    onBackgroundUpdate?: AgentBackgroundCallback;
    onWorkspaceCheckpoint?: AgentWorkspaceCheckpointCallback;
    title?: string;
    identity?: AgentRunIdentity;
    background?: boolean;
}

/** Named controls for continuing a delegated agent run with a new prompt. */
export interface AgentContinuationOptions {
    signal?: AbortSignal;
    onProgress?: AgentProgressCallback;
    onBackgroundUpdate?: AgentBackgroundCallback;
    onWorkspaceCheckpoint?: AgentWorkspaceCheckpointCallback;
    title?: string;
    identity?: AgentRunIdentity;
    /** Lease acquired before workspace restoration to serialize continuations. */
    continuationLease?: AgentContinuationLease;
}

/** Named controls for resuming a waiting or interrupted delegated agent run. */
export interface AgentResumeOptions {
    guidance?: string;
    signal?: AbortSignal;
    onProgress?: AgentProgressCallback;
    onBackgroundUpdate?: AgentBackgroundCallback;
    onWorkspaceCheckpoint?: AgentWorkspaceCheckpointCallback;
}

/**
 * Coordinates delegated-agent lifecycles for one parent session.
 *
 * The manager is the public lifecycle façade and composition root. It coordinates the run
 * registry, durable checkpoints, continuation leases, restoration policy, child operations,
 * callbacks, and events. Public actions may reopen, pause, cancel, or dispose child runs.
 *
 * Collaborators own one mechanism each and never import this file: `AgentRunRegistry` (in-memory
 * ownership and terminal retention), `AgentRunCheckpointStore` (durable record projection and
 * write ordering), `AgentRunLeaseCoordinator` (lease acquisition and loss), and
 * `AgentRunRestoreCoordinator` (chronological restoration eligibility). This class keeps the
 * ordered lifecycle policy: what happens before a lease is released, when a checkpoint must be
 * durable, and which condition wins when several interruptions race.
 */
export class AgentRunManager {
    private readonly registry = new AgentRunRegistry();
    private closing = false;
    private preservingShutdown = false;
    private readonly restoreAbortController = new AbortController();
    private shutdownPromise?: Promise<void>;
    private readonly checkpoints: AgentRunCheckpointStore;
    private readonly leases: AgentRunLeaseCoordinator;
    private readonly restoreCoordinator: AgentRunRestoreCoordinator;
    /** Bridges child progress, session, and file callbacks into manager-owned run state. */
    private readonly childSetupHooks: ChildSetupHooks = {
        childSessionDir: () => this.persistence?.childSessionDir,
        details: (run, progress) => this.details(run, progress),
        emitStatusChanged: (run, previousStatus, status) =>
            this.emitRunStatusChanged(run, previousStatus, status),
        emitBackgroundUpdate: (run, details) => this.emitBackgroundUpdate(run, details),
        persist: (run, intent) => {
            void this.persistRun(run, undefined, intent);
        },
        record: (run, type, data) => this.record(run, type, data),
    };

    /** Create a manager with the child factory and optional lifecycle integrations. */
    constructor(
        private readonly factory: ChildAgentFactory,
        private readonly maxActiveRuns = 4,
        private readonly trace?: AgentTraceSink,
        private readonly maxRetainedResults = 20,
        private readonly events?: AgentEventSink,
        private readonly maxTaskChars = MAX_TASK_CHARS,
    ) {
        this.checkpoints = new AgentRunCheckpointStore(maxTaskChars);
        this.leases = new AgentRunLeaseCoordinator({
            getPersistence: () => this.persistence,
            isClosing: () => this.closing,
            shutdownSignal: this.restoreAbortController.signal,
            abortRun: (run) => this.abortRun(run),
        });
        this.restoreCoordinator = new AgentRunRestoreCoordinator({
            registry: this.registry,
            maxActiveRuns,
            getPersistence: () => this.persistence,
            replacePersistedRecords: (records) => this.checkpoints.replace(records),
            isClosing: () => this.closing,
            restoreAbortSignal: this.restoreAbortController.signal,
            emitRestored: (run) =>
                this.emitRunEvent(run, {
                    type: "run",
                    action: "restored",
                    runId: run.id,
                    agent: run.agent,
                    background: run.background,
                    status: run.status,
                    workspaceId: run.workspaceId,
                }),
            restoreTerminal: (run, record) => this.restoreTerminalRun(run, record),
            restoreActive: (run, record, definition, restoreContext, onUpdate, diagnostics) =>
                this.restoreActiveRun(
                    run,
                    record,
                    definition,
                    restoreContext,
                    onUpdate,
                    diagnostics,
                ),
        });
    }

    private get persistence(): AgentRunPersistence | undefined {
        return this.checkpoints.integration;
    }

    /** Replace the persistence integration and clear the cached persisted checkpoints. */
    setPersistence(persistence: AgentRunPersistence | undefined): void {
        this.checkpoints.setPersistence(persistence);
    }

    /** Return the checkpoint authoritative for this manager's active parent branch, if any. */
    getPersistedRun(runId: string): PersistedAgentRun | undefined {
        return this.checkpoints.get(runId);
    }

    /** Reserve a persisted continuation before touching its physical workspace. */
    async reserveContinuationLease(runId: string): Promise<AgentContinuationLease | undefined> {
        const runInstanceId =
            this.registry.find(runId)?.runInstanceId ?? this.checkpoints.get(runId)?.runInstanceId;
        return this.leases.reserve(runInstanceId);
    }

    /** Associate the latest exact workspace result with its logical run and persist the change. */
    async setWorkspaceResultId(runId: string, resultId: string): Promise<boolean> {
        const run = this.registry.find(runId);
        if (run) {
            run.workspaceResultId = resultId;
            return this.persistence ? await this.persistRun(run) : true;
        }
        return this.checkpoints.updateWorkspaceResult(runId, resultId);
    }

    /** Wait for pending persistence operations to settle. */
    async flushPersistence(): Promise<void> {
        await this.checkpoints.flush();
    }

    /** Flush and close the configured persistence integration. */
    async closePersistence(): Promise<void> {
        await this.checkpoints.close();
    }

    /** Whether durable persistence is configured for this manager. */
    get hasPersistence(): boolean {
        return this.checkpoints.hasPersistence;
    }

    /** Number of non-terminal runs currently held by the manager. */
    get activeCount(): number {
        return countActiveRuns(this.registry.all());
    }

    /**
     * Detach a settled workspace run before its physical slot is recycled.
     *
     * Fails (returns `false`) unless the run is parked at a boundary a later resume can start from:
     * waiting for guidance, interrupted, or terminal. A parked run keeps its durable checkpoint, so
     * its transcript remains resumable after the workspace itself is reused.
     */
    async parkWorkspaceRunForReuse(workspaceId: string, runId: string): Promise<boolean> {
        const run = this.registry.find(runId);
        if (!run || run.workspaceId !== workspaceId) return false;
        if (
            run.status !== "waiting_for_parent" &&
            run.status !== "interrupted" &&
            !isAgentTerminalStatus(run.status)
        )
            return false;
        if (this.persistence && !(await this.persistRun(run, "removed"))) return false;
        await this.leases.release(run);
        this.disposeRun(run);
        this.registry.remove(run.id);
        return true;
    }

    /** Whether any non-terminal mutation-capable run is active. */
    get hasActiveMutatingRun(): boolean {
        return [...this.registry.all()].some(
            (run) => run.mutating && !isAgentTerminalStatus(run.status),
        );
    }

    /** Whether any non-terminal mutation-capable run shares the parent checkout. */
    get hasActiveNonIsolatedMutatingRun(): boolean {
        return [...this.registry.all()].some(
            (run) =>
                run.mutating && run.workspaceId === undefined && !isAgentTerminalStatus(run.status),
        );
    }

    /** Return the current status for a run, or `undefined` for an unknown run ID. */
    getRunStatus(runId: string): AgentRunStatus | undefined {
        return this.registry.find(runId)?.status;
    }

    /** Return summaries of all runs currently held by the manager. */
    listRuns(): AgentRunSummary[] {
        return [...this.registry.all()].map((run) => runSummary(run));
    }

    /** Return waiting runs that currently have a parent question. */
    listWaiting(): Array<{ runId: string; agent: string; question: string }> {
        return this.listRuns()
            .filter((run) => run.status === "waiting_for_parent" && run.question !== undefined)
            .map((run) => ({
                runId: run.runId,
                agent: run.agent,
                question: run.question!,
            }));
    }

    /**
     * Restore eligible runs from the active parent branch without replaying child work.
     *
     * This updates the manager's persisted-run cache, run registry, terminal-result retention,
     * and next run number; it may also persist checkpoints, emit events/traces, and acquire
     * continuation leases. Existing unrelated active runs are retained, so this is not a pure
     * reconstruction step.
     *
     * Terminal background results are retained for collection, while starting and running
     * checkpoints reopen as interrupted runs requiring explicit user resumption. Workspace
     * ownership, mutation capability, transcript-leaf, and continuation-lease safeguards
     * are checked before an active child session is reopened.
     *
     * Events emitted through the event sink may include:
     *
     * 1. `{ type: "run", action: "restored" }` for each admitted record.
     * 2. `{ type: "run", action: "progress" }` while reopening an active child.
     * 3. `{ type: "run", action: "status_changed" }` if reopening changes its status.
     * 4. `{ type: "run", action: "removed" }` when terminal cleanup removes a result; the
     *    reason is `restored_terminal` or `pruned`.
     *
     * TODO: Consider moving `onBackgroundUpdate` into the event system.
     */
    async restore(
        records: PersistedAgentRun[],
        definitions: AgentDefinition[],
        context: AgentStartContext,
        onBackgroundUpdate?: AgentBackgroundCallback,
    ): Promise<{ restored: number; diagnostics: string[] }> {
        return this.restoreCoordinator.restore(records, definitions, context, onBackgroundUpdate);
    }

    /**
     * Rebuild the retained result of a run that already reached a terminal status.
     *
     * Nothing is re-executed and no child session is reopened: the checkpoint's stored output
     * becomes the run's terminal outcome again. Background results go back into the bounded
     * retention queue so `collect` can still return them; foreground results are dropped
     * immediately, because their outcome already reached the parent that started them. The
     * `restored_terminal` removal never writes a tombstone, since the durable record is already
     * terminal.
     */
    private async restoreTerminalRun(run: AgentRun, record: PersistedAgentRun): Promise<void> {
        const content = record.terminalContent ?? `Agent ${run.id} ${record.status}.`;
        run.terminalOutcome = this.outcome(
            run,
            content,
            record.terminalIsError ?? record.status !== "completed",
            record.progress,
            record.terminalError,
            record.status === "completed" && record.terminalIsError !== true,
        );
        if (run.background) {
            this.registry.retainTerminal(run.id);
            await this.pruneRetainedResults();
            return;
        }
        await this.removeRun(run, "restored_terminal", false);
    }

    /**
     * Reopen a live, waiting, or interrupted run so it can be continued in this parent session.
     *
     * The restore coordinator has already admitted the record; this step only re-establishes the
     * child session, and any rejection becomes a diagnostic instead of a failed restore.
     *
     * Invariants:
     *
     * 1. A run without its child transcript, or a V2 record without an exact transcript leaf, is
     *    dropped with a diagnostic rather than guessed at: reopening from the wrong leaf could
     *    replay tool work whose outcome is unknown.
     * 2. The continuation lease is acquired before the child is reopened and always released in
     *    `finally`, so an abandoned restore cannot strand the lease for other parents.
     * 3. Restoration aborts as soon as the manager starts closing, so a late restore cannot create
     *    a child that outlives the parent session.
     * 4. Only legacy (non-V2) records repair their transcript during restore; V2 records store the
     *    exact leaf and are never rewritten here.
     * 5. An interrupted restore is checkpointed again with `interrupted` mutation reporting, so the
     *    next parent sees the same uncertainty this one did.
     */
    private async restoreActiveRun(
        run: AgentRun,
        record: PersistedAgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
        onBackgroundUpdate: AgentBackgroundCallback | undefined,
        diagnostics: string[],
    ): Promise<void> {
        if (!record.childSessionFile) {
            diagnostics.push(
                `Could not restore ${record.runId}: its child transcript is unavailable.`,
            );
            this.registry.remove(run.id);
            return;
        }
        if (
            this.persistence?.usesSnapshotMarkers === true &&
            record.resumable !== undefined &&
            record.childSessionLeafId === undefined
        ) {
            diagnostics.push(
                `Could not restore ${record.runId}: its checkpoint has no exact child transcript leaf.`,
            );
            this.registry.remove(run.id);
            return;
        }

        this.trace?.start(run.id, run.agent, {
            source: run.agentSource,
            background: run.background,
            restored: true,
            restoredStatus: run.status,
        });
        run.backgroundCallback = record.background ? onBackgroundUpdate : undefined;
        const restoredInterrupted = run.status === "interrupted";
        try {
            const acquired = await this.leases.acquireWithRecovery(
                run,
                this.restoreAbortController.signal,
            );
            if (!acquired || this.closing || this.restoreAbortController.signal.aborted) {
                this.registry.remove(run.id);
                return;
            }
            await this.setupRun(
                run,
                definition,
                {
                    ...context,
                    cwd: run.cwd,
                    workspaceId: run.workspaceId,
                    childSessionFile: record.childSessionFile,
                    childSessionLeafId: record.childSessionLeafId,
                    // V2 records are never repaired during restore. The legacy
                    // compatibility path retains its old factory contract only.
                    repairInterrupted:
                        restoredInterrupted && this.persistence?.usesSnapshotMarkers !== true,
                    initialProgress: record.progress,
                    initialMutationReport: record.mutationReport,
                },
                undefined,
                undefined,
                true,
            );
            if (restoredInterrupted) {
                run.restoredMutationReport = {
                    ...(run.restoredMutationReport ?? {
                        changedFiles: [],
                        bashApproved: false,
                    }),
                    interrupted: true,
                };
                if (this.persistence?.usesSnapshotMarkers && !(await this.persistRun(run))) {
                    throw new Error("Could not persist the restored interrupted checkpoint.");
                }
            }
        } catch (error) {
            diagnostics.push(`Could not restore ${record.runId}: ${errorMessage(error)}`);
            this.registry.remove(run.id);
        } finally {
            await this.leases.release(run);
        }
    }

    /** Reserve a run identity; revisions may retain their existing public run ID. */
    reserveRunIdentity(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        requestedRunId?: string,
        requestedRunInstanceId?: string,
    ): AgentRunIdentity {
        if (this.closing) throw new AgentActionError("Agent runtime is shutting down.");
        const definition = this.resolveDefinition(definitionOrName);
        this.validateRunStart(definition, task, context);
        return this.allocateRunIdentity(definition, requestedRunId, requestedRunInstanceId);
    }

    /**
     * Start a new delegated run in the foreground or as a retained background operation.
     *
     * Foreground starts wait for the child to reach its next lifecycle boundary and return its
     * outcome. They can be detached into the background while running. Background starts return
     * immediately with a checkpoint message; their terminal outcome remains retained for an
     * explicit collect operation.
     *
     * Starting a run updates the manager's run registry and may persist checkpoints, acquire a
     * continuation lease, create a child session, invoke progress callbacks, and emit lifecycle
     * traces and events.
     *
     * Events emitted through the event sink may include:
     *
     * 1. `{ type: "run", action: "created" }` when the run enters the registry.
     * 2. `{ type: "run", action: "progress" }` as setup or execution reports progress.
     * 3. `{ type: "run", action: "status_changed" }` as the run advances through its lifecycle.
     * 4. `{ type: "run", action: "removed" }` when foreground terminal cleanup removes the run
     *    or a retained background result is later collected, canceled, or pruned.
     */
    async start(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        {
            signal,
            onProgress,
            onBackgroundUpdate,
            onWorkspaceCheckpoint,
            title,
            identity,
            background = false,
        }: AgentStartOptions = {},
    ): Promise<AgentRunOutcome> {
        if (background) {
            if (signal?.aborted)
                throw new AgentActionError("Agent start was aborted before launch.");
            const { definition, run } = await this.createRun(
                definitionOrName,
                task,
                context,
                true,
                title,
                identity,
            );
            run.backgroundCallback = onBackgroundUpdate;
            run.workspaceCheckpoint = onWorkspaceCheckpoint;
            const taskPromise = this.launchBackground(run, definition, context).catch((error) =>
                this.settleBackgroundFailure(run, error),
            );
            this.trackBackgroundTask(run, taskPromise);
            return this.checkpointOutcome(
                run,
                `Agent ${run.id} started in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE} After a terminal notification, retrieve the full result with agent(action="collect", runId="${run.id}").`,
                false,
                emptyProgress(),
            );
        }

        const { definition, run } = await this.createRun(
            definitionOrName,
            task,
            context,
            false,
            title,
            identity,
        );
        run.workspaceCheckpoint = onWorkspaceCheckpoint;
        const setupOutcome = await this.setupRun(run, definition, context, signal, onProgress);
        if (setupOutcome) return setupOutcome;

        return this.beginDetachableOperation(run, run.initialPrompt ?? task, {
            signal,
            onProgress,
            onBackgroundUpdate,
        });
    }

    /** Start a new run using an already-acquired continuation lease and prompt. */
    async startContinuation(
        definitionOrName: AgentDefinition | string,
        task: string,
        prompt: string,
        context: AgentStartContext,
        {
            signal,
            onProgress,
            onBackgroundUpdate,
            onWorkspaceCheckpoint,
            title,
            identity,
            continuationLease,
        }: AgentContinuationOptions = {},
    ): Promise<AgentRunOutcome> {
        const { definition, run } = await this.createRun(
            definitionOrName,
            task,
            context,
            false,
            title,
            identity,
            continuationLease,
        );
        run.workspaceCheckpoint = onWorkspaceCheckpoint;
        const setupOutcome = await this.setupRun(run, definition, context, signal, onProgress);
        if (setupOutcome) return setupOutcome;

        return this.beginDetachableOperation(run, prompt, {
            signal,
            onProgress,
            onBackgroundUpdate,
        });
    }

    /**
     * Resume a waiting or interrupted run with optional parent guidance.
     *
     * Validation is side-effect free, and `prepareResumedRun` reverts status, question, and
     * timestamp when preparation fails, so a rejected resume leaves the run resumable as it was.
     * Transcript repair is the one durable exception: closing an interrupted run's unmatched tool
     * calls changes the child session and is not undone. The caller's workspace checkpoint callback
     * is installed only after preparation succeeds, so a rejected resume retains no caller state.
     */
    async resume(
        runId: string,
        {
            guidance,
            signal,
            onProgress,
            onBackgroundUpdate,
            onWorkspaceCheckpoint,
        }: AgentResumeOptions = {},
    ): Promise<AgentRunOutcome> {
        const run = this.requireResumableRun(runId);
        const normalizedGuidance = guidance?.trim();
        this.validateResumeGuidance(run, normalizedGuidance);
        if (this.closing) throw new AgentActionError("Agent runtime is shutting down.");
        if (signal?.aborted) throw new AgentActionError("Agent resume was aborted before launch.");

        const resumeGuidance = normalizedGuidance ?? INTERRUPTED_RESUME_GUIDANCE;
        await this.prepareResumedRun(run, resumeGuidance, !normalizedGuidance, signal);
        if (onWorkspaceCheckpoint) {
            run.workspaceCheckpoint = onWorkspaceCheckpoint;
        }
        const prompt = `Parent guidance:\n${resumeGuidance}`;

        if (!run.background) {
            return this.beginDetachableOperation(run, prompt, {
                signal,
                onProgress,
                onBackgroundUpdate: onBackgroundUpdate ?? run.onBackgroundUpdate,
            });
        }
        return this.resumeInBackground(run, prompt, onBackgroundUpdate);
    }

    /** Require a run that exists and is parked at a resume boundary. */
    private requireResumableRun(runId: string): AgentRun {
        const run = this.registry.find(runId);
        if (!run) {
            throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        }
        if (run.status !== "waiting_for_parent" && run.status !== "interrupted") {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; only waiting or interrupted runs can be resumed.`,
            );
        }
        return run;
    }

    /** Require guidance that the selected run can actually accept. */
    private validateResumeGuidance(run: AgentRun, guidance: string | undefined): void {
        if (run.status === "waiting_for_parent" && !guidance) {
            throw new AgentActionError("Waiting agent runs require parent guidance.");
        }
        if (guidance && guidance.length > MAX_GUIDANCE_CHARS) {
            throw new AgentActionError(`Parent guidance exceeds ${MAX_GUIDANCE_CHARS} characters.`);
        }
    }

    /**
     * Take continuation ownership and advance a parked run to `running`.
     *
     * Every step is undone on failure: the previous status, question, and timestamp are restored
     * and the lease is released, so a failed resume cannot leave a run that looks like it is
     * executing somewhere nobody is watching. The lease is acquired before the interrupted
     * transcript is repaired, because repairing writes unmatched tool calls to the child session.
     */
    private async prepareResumedRun(
        run: AgentRun,
        guidance: string,
        userDriven: boolean,
        signal?: AbortSignal,
    ): Promise<void> {
        const previousStatus = run.status;
        const previousQuestion = run.question;
        const previousUpdatedAt = run.updatedAt;
        try {
            const acquired = await this.leases.acquireWithRecovery(
                run,
                this.leases.recoverySignal(signal),
            );
            if (!acquired) {
                throw new AgentActionError(
                    "Agent resume was aborted before acquiring the continuation lease.",
                );
            }
            await this.repairInterruptedTranscript(run);
            this.record(run, "resume.requested", {
                guidanceChars: guidance.length,
                userDriven,
            });
            this.transitionStatus(run, "running");
            run.question = undefined;
            run.updatedAt = Date.now();
            await this.requireDurableCheckpoint(
                run,
                "Could not persist the resumed delegated-agent checkpoint.",
            );
        } catch (error) {
            if (run.status !== previousStatus) this.transitionStatus(run, previousStatus);
            run.question = previousQuestion;
            run.updatedAt = previousUpdatedAt;
            await this.leases.release(run);
            throw error;
        }
    }

    /** Close unmatched tool calls left behind by an interrupted child, then checkpoint the leaf. */
    private async repairInterruptedTranscript(run: AgentRun): Promise<void> {
        if (run.status !== "interrupted") {
            return;
        }

        const repaired = run.handle?.repairInterrupted?.() ?? 0;
        run.childSessionLeafId = run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId;
        this.record(run, "session.repaired", { unmatchedToolCalls: repaired });
        await this.requireDurableCheckpoint(
            run,
            "Could not persist the resumed delegated-agent checkpoint.",
        );
    }

    /**
     * Resume an already-parked background run and return its accepted-checkpoint summary.
     *
     * The caller's abort signal is deliberately not forwarded: a background run must outlive the
     * parent tool call that resumed it, and its terminal result is delivered asynchronously.
     */
    private resumeInBackground(
        run: AgentRun,
        prompt: string,
        onBackgroundUpdate: AgentBackgroundCallback | undefined,
    ): AgentRunOutcome {
        if (onBackgroundUpdate) {
            run.backgroundCallback = onBackgroundUpdate;
        }
        const taskPromise = Promise.resolve()
            .then(() => this.beginOperation(run, prompt))
            .catch((error) => this.settleBackgroundFailure(run, error))
            .finally(() => {
                void this.leases.release(run);
            });
        this.trackBackgroundTask(run, taskPromise);
        return this.checkpointOutcome(
            run,
            `Agent ${run.id} resumed in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE}`,
            false,
            run.handle?.getProgress() ?? emptyProgress(),
        );
    }

    /** Turn an unexpected background rejection into the run's settled outcome. */
    private async settleBackgroundFailure(run: AgentRun, error: unknown): Promise<AgentRunOutcome> {
        if (isAgentTerminalStatus(run.status)) return run.terminalOutcome!;
        return this.finishFailure(
            run,
            `Background agent failed unexpectedly: ${errorMessage(error)}`,
        );
    }

    /**
     * Detach the sole eligible foreground operation and retain it as a background run.
     *
     * Returns `undefined` unless exactly one foreground run is mid-operation, so a stray key press
     * cannot detach the wrong thing. The already-running operation is re-registered as a background
     * task and the caller's pending foreground promise is resolved with a checkpoint summary, which
     * is what unblocks the parent tool call while the child keeps working.
     */
    moveForegroundToBackground(): AgentRunOutcome | undefined {
        // TODO(agent): Revisit run selection if parallel foreground agent calls become supported.
        const candidates = [...this.registry.all()].filter(
            (run) =>
                run.detachable === true &&
                !run.background &&
                run.status === "running" &&
                run.operation !== undefined,
        );
        if (candidates.length !== 1) return undefined;

        const run = candidates[0]!;
        run.background = true;
        run.backgroundCallback = run.onBackgroundUpdate;
        const progress = run.handle?.getProgress() ?? emptyProgress();
        const backgroundMessage = [
            `Agent ${run.id} was manually moved to the background by the user.`,
            "Its progress and final result will be delivered asynchronously.",
            `After a terminal notification, retrieve the full result with agent(action="collect", runId="${run.id}").`,
        ].join(" ");
        const outcome = this.checkpointOutcome(run, backgroundMessage, false, progress);
        this.trackBackgroundTask(run, run.operation!);
        this.emitBackgroundUpdate(run, outcome.details);
        run.resolveDetachedOutcome?.(outcome);
        run.resolveDetachedOutcome = undefined;
        return outcome;
    }

    /** Ask a run to stop, wait for its operation to settle, and finalize or retain the result. */
    async cancel(
        runId: string,
        { onWorkspaceCheckpoint }: Pick<AgentResumeOptions, "onWorkspaceCheckpoint"> = {},
    ): Promise<AgentRunOutcome> {
        const run = this.requireRun(runId);
        if (onWorkspaceCheckpoint) run.workspaceCheckpoint = onWorkspaceCheckpoint;
        if (isAgentTerminalStatus(run.status)) {
            throw new AgentActionError(
                `Agent run ${runId} is already ${run.status}; collect its result instead.`,
            );
        }
        this.record(run, "cancel.requested", { status: run.status });
        run.cancelRequested = true;
        let operationOutcome: AgentRunOutcome | undefined;
        if (run.status === "starting" || run.status === "running") {
            const operation = run.operationSettled;
            await this.abortRun(run)?.catch(() => {});
            if (operation) operationOutcome = await operation.catch(() => undefined);
            if (run.background) await run.backgroundTask?.catch(() => {});
        }
        let terminalOutcome = run.terminalOutcome;
        terminalOutcome ??= operationOutcome;
        if (!isAgentTerminalStatus(run.status)) {
            terminalOutcome = await this.finishTerminal(
                run,
                "canceled",
                `Agent run ${runId} canceled.`,
                false,
            );
        }
        if (!run.background) return terminalOutcome!;

        const outcome = this.checkpointOutcome(
            run,
            terminalOutcome?.content ?? `Agent run ${runId} canceled.`,
            terminalOutcome?.isError ?? false,
            progressSnapshot(run),
            terminalOutcome?.details.error,
        );
        await this.removeRun(run, "canceled");
        return outcome;
    }

    /**
     * Describe a run's current lifecycle state for the parent.
     *
     * Builds the same outcome shape a terminal result would return, so the parent can branch on
     * `details.status`. The returned usage is the delta since the previous parent-visible report,
     * and this call refreshes that baseline without changing the run's state.
     */
    status(runId: string): AgentRunOutcome {
        const run = this.requireRun(runId);
        const progress = progressSnapshot(run);
        return this.checkpointOutcome(
            run,
            statusContent(run, progress),
            run.status === "failed" || run.status === "aborted",
            progress,
            run.terminalOutcome?.details.error,
        );
    }

    /**
     * Return a retained terminal result and drop the run from memory.
     *
     * Only terminal background runs are collectable: a still-active run has no complete result, and
     * a foreground run already returned its outcome to the caller that started it.
     */
    async collect(runId: string): Promise<AgentRunOutcome> {
        const run = this.requireRun(runId);
        if (!run.background) {
            throw new AgentActionError(`Agent run ${runId} is not a background run.`);
        }
        if (!isAgentTerminalStatus(run.status) || !run.terminalOutcome) {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; wait for its automatic terminal notification before collecting.`,
            );
        }
        const progress = progressSnapshot(run);
        const outcome = this.checkpointOutcome(
            run,
            run.terminalOutcome.content,
            run.terminalOutcome.isError,
            progress,
            run.terminalOutcome.details.error,
            run.terminalOutcome.hasResponse,
        );
        this.record(run, "result.collected");
        await this.removeRun(run, "collected");
        return outcome;
    }

    /**
     * Register a new run and take the ownership step it needs before any child work.
     *
     * Order matters: the identity is claimed first so a duplicate public run ID fails before
     * anything is written, the `created` event is published so the TUI can show the run, then the
     * checkpoint is reserved when durable markers are active. A run that cannot be checkpointed or
     * leased is removed again immediately, because leaving it registered would let another action
     * act on work nobody owns.
     */
    private async createRun(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        background: boolean,
        requestedTitle?: string,
        requestedIdentity?: AgentRunIdentity,
        preAcquiredContinuationLease?: AgentContinuationLease,
    ): Promise<{ definition: AgentDefinition; run: AgentRun }> {
        if (this.closing) throw new AgentActionError("Agent runtime is shutting down.");
        const definition = this.resolveDefinition(definitionOrName);
        this.validateRunStart(definition, task, context);
        const identity = requestedIdentity ?? this.allocateRunIdentity(definition);
        if (this.registry.has(identity.runId)) {
            throw new AgentActionError(`Agent run ID ${identity.runId} is already in use.`);
        }
        const now = Date.now();
        const id = identity.runId;
        const run: AgentRun = {
            id,
            runInstanceId: identity.runInstanceId,
            title: deriveAgentTitle(task, requestedTitle),
            agent: definition.name,
            agentSource: definition.source,
            agentFilePath: definition.filePath,
            definition: snapshotAgentDefinition(definition),
            task,
            initialPrompt: renderAgentTask(task, {
                context: context.agentContext,
                policy: definition.contextPolicy,
            }),
            status: "starting",
            background,
            usageCheckpoint: cloneUsage(ZERO_USAGE),
            usageSnapshot: cloneUsage(ZERO_USAGE),
            startedAt: now,
            updatedAt: now,
            cwd: context.cwd,
            parentCwd: context.parentCwd ?? context.cwd,
            workspaceId: context.workspaceId,
            childSessionFile: context.childSessionFile,
            childSessionLeafId: context.childSessionLeafId,
            ...RUN_DEFAULT_FLAGS,
            mutating: agentCanEdit(definition),
            definitionFingerprint: fingerprintAgentDefinition(definition),
            resumable: true,
        };
        this.registry.add(run);
        this.emitRunEvent(run, {
            type: "run",
            action: "created",
            runId: run.id,
            agent: run.agent,
            background: run.background,
            status: run.status,
            workspaceId: run.workspaceId,
        });
        if (this.persistence?.usesSnapshotMarkers && !(await this.persistRun(run))) {
            this.registry.remove(run.id);
            throw new AgentActionError(
                "Could not reserve the delegated-agent continuation checkpoint.",
            );
        }
        try {
            if (preAcquiredContinuationLease) {
                run.continuationLease = preAcquiredContinuationLease;
            } else {
                await this.leases.acquire(run);
            }
        } catch (error) {
            this.registry.remove(run.id);
            throw error;
        }
        this.trace?.start(id, definition.name, {
            source: definition.source,
            taskChars: task.length,
            model: definition.model ?? "parent",
            background,
        });
        return { definition, run };
    }

    /** Resolve a definition, or synthesize a builtin-shaped one when called with a bare name. */
    private resolveDefinition(definitionOrName: AgentDefinition | string): AgentDefinition {
        return typeof definitionOrName === "string"
            ? {
                  name: definitionOrName,
                  description: "Test or built-in agent",
                  capabilities: [],
                  systemPrompt: "",
                  source: "builtin",
              }
            : definitionOrName;
    }

    /**
     * Reject a start that must not run: empty or oversized task, active-run budget exhausted, or a
     * mutation conflict.
     *
     * Two workers may mutate concurrently only when both are isolated in distinct workspaces;
     * anything sharing the parent checkout stays single-flight. See `mutationRunsConflict`.
     */
    private validateRunStart(
        definition: AgentDefinition,
        task: string,
        context: AgentStartContext,
    ): void {
        if (!task.trim()) throw new AgentActionError("Agent task must not be empty.");
        if (task.length > this.maxTaskChars) {
            throw new AgentActionError(`Agent task exceeds ${this.maxTaskChars} characters.`);
        }
        if (this.activeCount >= this.maxActiveRuns) {
            throw new AgentActionError(
                `Agent run limit reached (${this.maxActiveRuns}). Resume, collect, or cancel an existing run first.`,
            );
        }
        if (
            agentCanEdit(definition) &&
            [...this.registry.all()].some(
                (candidate) =>
                    candidate.mutating &&
                    !isAgentTerminalStatus(candidate.status) &&
                    mutationRunsConflict(context.workspaceId, candidate.workspaceId),
            )
        ) {
            throw new AgentActionError(
                context.workspaceId
                    ? "A mutation-capable worker is already active in this workspace."
                    : "A same-checkout mutation-capable worker is already active.",
            );
        }
    }

    /** Allocate the next public run ID plus a fresh physical instance identity. */
    private allocateRunIdentity(
        definition: AgentDefinition,
        requestedRunId?: string,
        requestedRunInstanceId?: string,
    ): AgentRunIdentity {
        return {
            runId: this.registry.allocateRunId(definition.name, requestedRunId),
            runInstanceId: requestedRunInstanceId ?? randomUUID(),
        };
    }

    /**
     * Create or reopen the child session for a run and settle whatever blocks it from running.
     *
     * Three phases, in order:
     *
     * 1. Build the factory context (see `createChildFactoryContext`) and start the child. The
     *    pending promise stays on the run as `setup` so shutdown can wait for a child that is
     *    still being created.
     * 2. Record the transcript identity the handle produced, then make it durable before any
     *    prompt is sent. A V2 checkpoint that cannot be written fails the run: without it, no
     *    later parent could tell where the child transcript ended.
     * 3. Re-check cancellation and shutdown after the await, because the parent may have asked to
     *    stop or the session may be closing while the child was being created. Only then does the
     *    caller get `undefined`, meaning "safe to prompt".
     *
     * `preserveOnSetupFailure` is used by restoration, where a failed reopen must leave the durable
     * checkpoint untouched and report through the restore diagnostics instead of finalizing the
     * run as a fresh failure.
     */
    private async setupRun(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
        preserveOnSetupFailure = false,
    ): Promise<AgentRunOutcome | undefined> {
        const setupOutcome = await this.createChildSession(run, definition, context, {
            onProgress,
            preserveOnSetupFailure,
        });
        if (setupOutcome) {
            return setupOutcome;
        }

        if (run.cancelRequested) {
            this.record(run, "setup.canceled_after_completion");
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (this.closing || run.shutdownRequested || signal?.aborted) {
            return this.settleSetupAbort(run, signal);
        }
        return undefined;
    }

    /** Run the child-factory call and turn any precondition into a settled outcome. */
    private async createChildSession(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
        {
            onProgress,
            preserveOnSetupFailure,
        }: { onProgress?: AgentProgressCallback; preserveOnSetupFailure: boolean },
    ): Promise<AgentRunOutcome | undefined> {
        try {
            this.record(run, "setup.started");
            const setup = this.factory(
                createChildFactoryContext(run, {
                    definition,
                    context,
                    onProgress,
                    hooks: this.childSetupHooks,
                }),
            );
            run.setup = setup;
            run.handle = await setup;
            run.childSessionFile = run.handle.sessionFile ?? run.childSessionFile;
            run.childSessionLeafId = run.handle.getSessionLeafId?.() ?? run.childSessionLeafId;
            run.setup = undefined;
            if (this.persistence?.usesSnapshotMarkers && !(await this.persistRun(run))) {
                return this.finishFailure(
                    run,
                    "Could not durably checkpoint the delegated-agent child session before execution.",
                );
            }
            this.record(run, "setup.completed");
            return undefined;
        } catch (error) {
            return this.settleSetupFailure(run, error, preserveOnSetupFailure);
        }
    }

    /**
     * Report a child that could not be created or reopened.
     *
     * Under `preserveOnSetupFailure` the run is only unregistered, never finalized: its durable
     * checkpoint still describes the work, and restoring a transcript that fails to reopen must not
     * rewrite a resumable run as a failure. The thrown error keeps the original message text so
     * restore diagnostics stay readable.
     */
    private settleSetupFailure(
        run: AgentRun,
        error: unknown,
        preserveOnSetupFailure: boolean,
    ): Promise<AgentRunOutcome> {
        run.setup = undefined;
        run.setupFailed = true;
        const message = errorMessage(error);
        this.record(run, "setup.failed", { error: truncate(message, 500) });
        if (preserveOnSetupFailure) {
            this.registry.remove(run.id);
            throw new Error(`Failed to reopen child session: ${message}`);
        }
        return this.finishFailure(run, `Failed to create child session: ${message}`);
    }

    /** Settle a run whose setup finished after the parent already stopped waiting for it. */
    private async settleSetupAbort(
        run: AgentRun,
        signal: AbortSignal | undefined,
    ): Promise<AgentRunOutcome> {
        this.record(run, "setup.aborted_after_completion");
        if (signal?.aborted) {
            await this.abortRun(run)?.catch(() => {});
        }
        if (this.preservingShutdown && run.childSessionFile) {
            return this.finishInterrupted(
                run,
                "Agent run was interrupted during session shutdown.",
            );
        }
        return this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
    }

    /** Set up and prompt a background run; the caller already returned a checkpoint summary. */
    private async launchBackground(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
    ): Promise<AgentRunOutcome> {
        const setupOutcome = await this.setupRun(run, definition, context);
        if (setupOutcome) return setupOutcome;
        return this.beginOperation(run, run.initialPrompt ?? run.task);
    }

    /** Require a run the manager still holds, failing with the action-oriented stale-ID message. */
    private requireRun(runId: string): AgentRun {
        const run = this.registry.find(runId);
        if (!run) throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        return run;
    }

    /** Stop active work and release manager resources during parent shutdown. */
    shutdown(): Promise<void> {
        this.shutdownPromise ??= this.performShutdown();
        return this.shutdownPromise;
    }

    /**
     * Stop active work and settle every run so the parent session can end.
     *
     * Runs in three ordered phases. Interrupt: mark all runs and abort whatever child work already
     * has a handle. Await: let setup and operations settle, because a child session created during
     * the first phase can only be aborted by the second interrupt pass. Settle: persist or drop
     * each run that is still registered.
     *
     * Durable persistence keeps transcripts and checkpoints so the next parent session can restore
     * the runs as interrupted; without it runs are simply aborted, since nothing could restore
     * them anyway. Neither path writes a removal tombstone.
     */
    private async performShutdown(): Promise<void> {
        this.closing = true;
        this.restoreAbortController.abort();
        this.preservingShutdown = this.persistence !== undefined;
        const runs = [...this.registry.all()];

        this.interruptRuns(runs);
        await settleAll(runs.map((run) => run.setup));
        this.abortActiveRuns(runs);
        await settleAll(runs.map((run) => run.operation));

        for (const run of runs) {
            await this.settleRunForShutdown(run);
        }
    }

    /** Record the shutdown request, mark each run, and abort the child work already reachable. */
    private interruptRuns(runs: readonly AgentRun[]): void {
        for (const run of runs) {
            this.record(run, "shutdown.requested", { status: run.status });
            run.shutdownRequested = true;
        }
        this.abortActiveRuns(runs);
    }

    /**
     * Abort every run that is still doing child work.
     *
     * Runs that were only starting may not have a child handle yet; `abortRun` records that case
     * and setup re-checks `shutdownRequested` once the handle exists.
     */
    private abortActiveRuns(runs: readonly AgentRun[]): void {
        for (const run of runs) {
            if (run.status !== "running" && run.status !== "starting") {
                continue;
            }
            void this.abortRun(run)?.catch(() => {});
        }
    }

    /** Keep one still-registered run restorable, or drop it as aborted. */
    private async settleRunForShutdown(run: AgentRun): Promise<void> {
        if (!this.registry.has(run.id)) {
            return;
        }

        if (this.preservingShutdown) {
            await this.preserveRunForRestoration(run);
            await this.removeRun(run, "shutdown", false);
            return;
        }
        if (!isAgentTerminalStatus(run.status)) {
            this.transitionStatus(run, "aborted");
            run.updatedAt = Date.now();
            this.disposeRun(run);
            this.trace?.finish(run.id, "aborted", {
                isError: true,
                reason: "session_shutdown",
            });
        }
        await this.removeRun(run, "shutdown", false);
    }

    /** Park a run's transcript and checkpoint so a later parent session can restore it. */
    private async preserveRunForRestoration(run: AgentRun): Promise<void> {
        if (run.status === "waiting_for_parent" || run.status === "interrupted") {
            await this.persistRun(run);
            this.disposeRun(run);
            return;
        }
        if (isAgentTerminalStatus(run.status)) {
            return;
        }
        await this.finishInterrupted(run, "Agent run was interrupted during session shutdown.");
    }

    /**
     * Start one operation and let the user move it to the background while it runs.
     *
     * The caller awaits a race between the operation and a detach signal resolved by
     * `moveForegroundToBackground`. Whichever wins, the operation promise keeps running: on detach
     * the same promise becomes the background task, so no child work is restarted or duplicated.
     * The continuation lease is released when the operation settles either way, and the detach hook
     * is cleared so a later key press cannot resolve a promise nobody is awaiting.
     */
    private async beginDetachableOperation(
        run: AgentRun,
        prompt: string,
        {
            signal,
            onProgress,
            onBackgroundUpdate,
        }: {
            signal?: AbortSignal;
            onProgress?: AgentProgressCallback;
            onBackgroundUpdate?: AgentBackgroundCallback;
        },
    ): Promise<AgentRunOutcome> {
        run.detachable = true;
        if (onBackgroundUpdate) {
            run.onBackgroundUpdate = onBackgroundUpdate;
        }

        const detachedOutcome = new Promise<AgentRunOutcome>((resolve) => {
            run.resolveDetachedOutcome = resolve;
        });
        run.detachedOutcome = detachedOutcome;
        const operation = this.beginOperation(run, prompt, signal, onProgress);
        run.operationSettled = operation;
        const releaseAfterOperation = () => {
            run.detachable = false;
            void this.leases.release(run);
        };
        void operation.then(releaseAfterOperation, releaseAfterOperation);

        try {
            return await Promise.race([operation, detachedOutcome]);
        } finally {
            if (run.detachedOutcome === detachedOutcome) {
                run.detachedOutcome = undefined;
                run.resolveDetachedOutcome = undefined;
            }
        }
    }

    /**
     * Advance a run from a parked or starting state into `running`, guarding every precondition.
     *
     * Checked in precedence order, because a run can be canceled, aborted, and lose its lease at
     * once: cancellation wins, then lost continuation ownership, then shutdown or abort. Only after
     * those checks does the run become `running`, and for V2 runs the `running` checkpoint must be
     * durable before the child is prompted, so a crash mid-operation still leaves something a later
     * parent can restore as interrupted.
     *
     * `run.operationSettled` is published as soon as an operation exists, so `cancel` always has
     * something to await; `run.operation` is the driving promise and is cleared once it settles.
     */
    private async beginOperation(
        run: AgentRun,
        prompt: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        if (run.cancelRequested) {
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (run.continuationLeaseLost) {
            return this.finishInterrupted(
                run,
                "Delegated-agent continuation ownership was lost before launch.",
            );
        }
        if (this.closing || run.shutdownRequested || signal?.aborted) {
            if (signal?.aborted) await this.abortRun(run)?.catch(() => {});
            return this.preservingShutdown && run.childSessionFile
                ? this.finishInterrupted(run, "Agent run was interrupted during session shutdown.")
                : this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }
        this.transitionStatus(run, "running");
        run.updatedAt = Date.now();
        if (this.persistence?.usesSnapshotMarkers && !(await this.persistRun(run))) {
            return this.finishFailure(
                run,
                "Could not durably checkpoint the delegated-agent operation before execution.",
            );
        }
        this.emitBackgroundUpdate(
            run,
            this.details(run, run.handle?.getProgress() ?? emptyProgress()),
        );
        this.record(run, "operation.started", {
            kind: prompt.startsWith("Parent guidance:\n") ? "resume" : "start",
            promptChars: prompt.length,
        });
        const operation = this.drive(run, prompt, signal, onProgress);
        run.operation = operation;
        run.operationSettled = operation;
        try {
            return await operation;
        } finally {
            if (run.operation === operation) run.operation = undefined;
        }
    }

    /**
     * Advance one child prompt to its next lifecycle boundary.
     *
     * This mutates the run through prompt settlement, interruption handling, parent-guidance
     * checkpointing, or terminal completion. It preserves cancellation, abort, and continuation
     * lease-loss precedence; guidance releases the continuation lease only after its checkpoint
     * succeeds.
     *
     * Events emitted while driving may include:
     *
     * 1. `{ type: "run", action: "progress" }` as the child reports progress.
     * 2. `{ type: "run", action: "status_changed" }` when the run changes lifecycle state.
     * 3. `{ type: "run", action: "removed" }` when foreground terminal completion removes the run.
     *
     * TODO: Consider moving `onProgress` into the event system.
     */
    private async drive(
        run: AgentRun,
        prompt: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const handle = run.handle!;
        let aborted = signal?.aborted ?? false;
        const abort = () => {
            if (run.background) {
                return;
            }
            aborted = true;
            this.record(run, "operation.abort_requested");
            this.abortRun(run);
        };
        signal?.addEventListener("abort", abort, { once: true });

        try {
            if (run.cancelRequested) {
                this.record(run, "operation.canceled_before_prompt");
            } else if (aborted) {
                abort();
            } else {
                await handle.prompt(prompt);
                captureChildSessionLeaf(run);
                if (run.continuationLeaseLost) {
                    await run.abortPromise?.catch(() => {});
                    return this.finishInterrupted(
                        run,
                        "Delegated-agent continuation ownership was lost during execution.",
                    );
                }
                if (this.persistence?.usesSnapshotMarkers && !(await this.persistRun(run))) {
                    await this.abortRun(run)?.catch(() => {});
                    return this.finishInterrupted(
                        run,
                        "Could not durably checkpoint the settled delegated-agent operation.",
                    );
                }
                this.record(run, "operation.prompt_settled");
            }
            await run.abortPromise?.catch(() => {});
        } catch (error) {
            const message = errorMessage(error);
            this.record(run, "operation.prompt_failed", { error: truncate(message, 500) });
            await run.abortPromise?.catch(() => {});
            const outcome = this.resolvePromptFailure(run, message, aborted);
            if (outcome) {
                return outcome;
            }
        } finally {
            signal?.removeEventListener("abort", abort);
        }

        const interruption = this.resolveDriveInterruption(run, aborted);
        if (interruption) {
            return interruption;
        }
        return this.resolveChildOutcome(run, handle, onProgress);
    }

    /**
     * Decide what a rejected child prompt means for the run.
     *
     * Returning `undefined` means "not a failure of ours to report": the run was canceled, the
     * parent aborted it, or the manager is shutting down, and the caller's interruption handling
     * settles it. Lost continuation ownership outranks even those, because another manager now owns
     * the transcript and this one must stop writing to it.
     */
    private resolvePromptFailure(
        run: AgentRun,
        message: string,
        aborted: boolean,
    ): Promise<AgentRunOutcome> | undefined {
        if (run.continuationLeaseLost) {
            return this.finishInterrupted(
                run,
                "Delegated-agent continuation ownership was lost during execution.",
            );
        }
        if (!aborted && !run.shutdownRequested && !run.cancelRequested) {
            return this.finishFailure(run, message);
        }
        return undefined;
    }

    /**
     * Settle a run whose prompt completed while an interruption was requested.
     *
     * Precedence is fixed: cancellation, then lost continuation ownership, then abort or shutdown.
     * Shutdown with a durable transcript becomes an interruption the next parent session can
     * restore; anything else is reported as aborted.
     */
    private resolveDriveInterruption(
        run: AgentRun,
        aborted: boolean,
    ): Promise<AgentRunOutcome> | undefined {
        if (run.cancelRequested) {
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (run.continuationLeaseLost) {
            return this.finishInterrupted(
                run,
                "Delegated-agent continuation ownership was lost during execution.",
            );
        }
        if (aborted || run.shutdownRequested || this.closing) {
            return this.preservingShutdown && run.childSessionFile
                ? this.finishInterrupted(run, "Agent run was interrupted during session shutdown.")
                : this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }
        return undefined;
    }

    /**
     * Select the outcome for a prompt that settled without an interruption.
     *
     * A pending parent question outranks everything, since the child is parked and waiting rather
     * than finished. Next is a child-reported error, then the final assistant output. Empty output is
     * reported as a failure rather than a silent success, because the parent has nothing to act on
     * and a trace is the only way to see what the child did.
     */
    private resolveChildOutcome(
        run: AgentRun,
        handle: ChildAgentHandle,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const question = handle.takeParentQuestion();
        const progress = handle.getProgress();
        const childError = handle.getError();
        if (question) {
            return this.handleParentQuestion(run, handle, question, progress, onProgress);
        }
        if (childError) {
            this.record(run, "child.error_selected", { error: truncate(childError, 500) });
            return this.finishFailure(run, childError, progress);
        }

        const rawOutput = handle.getFinalOutput().trim();
        const output = truncate(rawOutput, MAX_OUTPUT_CHARS);
        if (!output) {
            this.record(run, "final_output.empty", {
                progressChars: progress.output.length,
                activityCount: progress.recentActivity.length,
            });
            const traceHint = this.trace
                ? ` Inspect trace ${run.id} with /agent-trace ${run.id}.`
                : "";
            return this.finishFailure(
                run,
                `Child agent completed without a final response.${traceHint}`,
                progress,
            );
        }
        this.record(run, "final_output.selected", {
            outputChars: rawOutput.length,
            outputPreview: truncate(rawOutput.replace(/\s+/g, " "), 240),
        });
        return this.finishTerminal(run, "completed", output, false, progress);
    }

    /**
     * Park a foreground or background run that is asking the parent for guidance.
     *
     * The order here is the recovery contract: status and question are set first so the parked state
     * is what gets checkpointed, the workspace checkpoint and durable checkpoint are both taken
     * *before* the lease is released, and either failure downgrades the run to interrupted instead of
     * releasing ownership of a transcript nobody can resume from. Only once the state is durable does
     * a foreground run report its progress to the caller.
     */
    private async handleParentQuestion(
        run: AgentRun,
        handle: ChildAgentHandle,
        question: ParentQuestion,
        progress: ChildProgress,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        this.record(run, "guidance.requested", {
            questionChars: question.question.length,
            questionPreview: truncate(question.question.replace(/\s+/g, " "), 240),
            optionCount: question.options?.length ?? 0,
        });
        this.transitionStatus(run, "waiting_for_parent");
        run.question = question;
        run.updatedAt = Date.now();
        const outcome = this.outcome(run, waitingContent(run, question, progress), false, progress);
        if (!run.background) {
            run.usageCheckpoint = cloneUsage(handle.getUsage());
        }
        run.restoredProgress = progress;
        run.restoredMutationReport = mutationReport(run);
        try {
            await this.checkpointWorkspace(run, "intermediate", "waiting_for_parent");
        } catch (error) {
            return await this.finalizeInterrupted(
                run,
                `The waiting workspace checkpoint failed; the run remains interrupted for explicit recovery: ${errorMessage(error)}`,
                progress,
            );
        }
        if (this.persistence?.usesSnapshotMarkers && !(await this.persistRun(run))) {
            return await this.finalizeInterrupted(
                run,
                "Could not durably checkpoint the delegated-agent guidance request; the run remains interrupted for explicit recovery.",
                progress,
            );
        }
        await this.leases.release(run);
        if (!run.background) {
            onProgress?.(outcome.details);
        }
        return outcome;
    }

    /**
     * Ask the workspace owner to checkpoint an isolated run's work at a lifecycle boundary.
     *
     * Only isolated runs with a workspace and an installed callback have anything to checkpoint; the
     * caller decides whether a boundary is intermediate or terminal.
     */
    private async checkpointWorkspace(
        run: AgentRun,
        kind: AgentWorkspaceCheckpointRequest["kind"],
        runStatus: AgentWorkspaceCheckpointRequest["runStatus"],
    ): Promise<void> {
        if (!run.workspaceId || !run.workspaceCheckpoint) return;
        await run.workspaceCheckpoint({
            workspaceId: run.workspaceId,
            runId: run.id,
            runInstanceId: run.runInstanceId,
            kind,
            runStatus,
            childSessionFile: run.childSessionFile,
            childSessionLeafId: run.childSessionLeafId ?? null,
        });
    }

    /**
     * Park a run as interrupted with its progress and mutation uncertainty recorded.
     *
     * Shared by every path that must leave a run resumable: the checkpoint is written *before* the
     * lease is released, so another parent can only take over once this one's state is on disk.
     */
    private async finalizeInterrupted(
        run: AgentRun,
        content: string,
        progress: ChildProgress,
    ): Promise<AgentRunOutcome> {
        this.transitionStatus(run, "interrupted");
        run.permissionPending = false;
        run.updatedAt = Date.now();
        run.restoredProgress = progress;
        run.restoredMutationReport = {
            ...mutationReport(run),
            interrupted: true,
        };
        const outcome = this.outcome(run, content, true, progress, content);
        await this.persistRun(run);
        await this.leases.release(run);
        return outcome;
    }

    /** Report a failure as this run's terminal outcome. */
    private async finishFailure(
        run: AgentRun,
        error: string,
        progress: ChildProgress = run.handle?.getProgress() ?? emptyProgress(),
    ): Promise<AgentRunOutcome> {
        return this.finishTerminal(run, "failed", error, true, progress);
    }

    /**
     * Interrupt a run, recording its transcript leaf and preferring live progress over restored.
     *
     * A failing workspace checkpoint is appended to the message rather than thrown: the run is
     * already being reported as uncertain, and losing the interruption summary would be worse. The
     * child session file stays recorded so a later parent can offer an explicit resume.
     */
    private async finishInterrupted(run: AgentRun, content: string): Promise<AgentRunOutcome> {
        captureChildSessionLeaf(run);
        const progress = run.handle?.getProgress() ?? run.restoredProgress ?? emptyProgress();
        let checkpointError: string | undefined;
        try {
            await this.checkpointWorkspace(run, "intermediate", "interrupted");
        } catch (error) {
            checkpointError = errorMessage(error);
        }
        const message = checkpointError
            ? `${content} Workspace checkpoint failed; the run remains interrupted for explicit recovery: ${checkpointError}`
            : content;
        return await this.finalizeInterrupted(run, message, progress);
    }

    /**
     * Settle a run at a terminal status and release everything it still holds.
     *
     * `finishTerminal` is the idempotent entry point: the first caller creates the completion
     * promise and every later caller, including a competing interruption, awaits that same
     * settlement instead of finalizing twice.
     */
    private finishTerminal(
        run: AgentRun,
        status: AgentTerminalStatus,
        content: string,
        isError: boolean,
        progress: ChildProgress = run.handle?.getProgress() ?? emptyProgress(),
    ): Promise<AgentRunOutcome> {
        if (run.terminalOutcome) return Promise.resolve(run.terminalOutcome);
        if (run.terminalCompletion) return run.terminalCompletion;
        const completion = this.finishTerminalInternal(run, status, content, isError, progress);
        run.terminalCompletion = completion;
        return completion;
    }

    /**
     * Commit a terminal result, then retain or discard it according to the run's mode.
     *
     * Ordering that must not change:
     *
     * 1. The exact child transcript leaf is captured before the workspace checkpoint, so an
     *    isolated result points at settled work.
     * 2. A failing workspace checkpoint downgrades the run to interrupted instead of reporting a
     *    terminal result nobody can recover.
     * 3. A background result is only retained once durable, because `collect` reads it back from
     *    the checkpoint after a parent restart. Foreground results are removed immediately; their
     *    outcome already reached the caller.
     */
    private async finishTerminalInternal(
        run: AgentRun,
        status: AgentTerminalStatus,
        content: string,
        isError: boolean,
        progress: ChildProgress = run.handle?.getProgress() ?? emptyProgress(),
    ): Promise<AgentRunOutcome> {
        if (isAgentTerminalStatus(run.status) && run.terminalOutcome) return run.terminalOutcome;
        captureChildSessionLeaf(run);
        try {
            await this.checkpointWorkspace(run, "terminal", status);
        } catch (error) {
            return await this.finalizeInterrupted(
                run,
                `The ${status} workspace checkpoint failed; the run remains interrupted for explicit recovery: ${errorMessage(error)}`,
                progress,
            );
        }

        const outcome = this.commitTerminalStatus(run, status, content, isError, progress);
        if (!run.background) {
            await this.removeRun(run, "terminal");
            this.disposeRun(run);
            this.recordTerminalTrace(run, status, isError, content, outcome);
            return outcome;
        }
        return await this.retainBackgroundResult(run, status, isError, content, outcome, progress);
    }

    /** Commit the terminal status, mutation snapshot, and parent-visible outcome for a run. */
    private commitTerminalStatus(
        run: AgentRun,
        status: AgentTerminalStatus,
        content: string,
        isError: boolean,
        progress: ChildProgress,
    ): AgentRunOutcome {
        this.transitionStatus(run, status);
        run.permissionPending = false;
        run.updatedAt = Date.now();
        run.restoredProgress = progress;
        run.restoredMutationReport = mutationReport(run);
        const outcome = this.outcome(
            run,
            content,
            isError,
            progress,
            status === "failed" ? content : undefined,
            status === "completed" && !isError,
        );
        run.terminalOutcome = outcome;
        return outcome;
    }

    /**
     * Keep a background result for an explicit `collect`, or downgrade to interrupted.
     *
     * Retention order matters: the terminal ID is recorded before pruning so the newest result
     * survives, the lease is released only after the checkpoint is durable, and the child is
     * disposed last so no callback can observe a run that already looks terminal.
     */
    private async retainBackgroundResult(
        run: AgentRun,
        status: AgentTerminalStatus,
        isError: boolean,
        content: string,
        outcome: AgentRunOutcome,
        progress: ChildProgress,
    ): Promise<AgentRunOutcome> {
        const persisted = await this.persistRun(run);
        if (this.persistence?.usesSnapshotMarkers && !persisted) {
            return this.revertTerminalToInterrupted(run, progress);
        }
        this.registry.retainTerminal(run.id);
        void this.leases.release(run);
        this.disposeRun(run);
        this.recordTerminalTrace(run, status, isError, content, outcome);
        // Completed transcripts remain browseable from /agents even after
        // the bounded in-memory result is collected or evicted.
        await this.pruneRetainedResults();
        return outcome;
    }

    /**
     * Downgrade an unpersistable background result to an explicitly resumable interruption.
     *
     * The in-memory terminal outcome is dropped so `collect` cannot hand back a result that is not
     * on disk, and the mutation report is marked interrupted so the next parent session sees the
     * same uncertainty a shutdown interruption would. The lease is released without a further
     * checkpoint: this path runs precisely because persistence failed or the lease was taken away,
     * and `AgentRunCheckpointStore.saveNow` refuses lease-lost writes rather than racing the new
     * holder. That makes it the deliberate exception to checkpoint-before-lease-release ordering.
     */
    private revertTerminalToInterrupted(run: AgentRun, progress: ChildProgress): AgentRunOutcome {
        const content =
            "The terminal delegated-agent checkpoint could not be persisted; the run remains interrupted for explicit recovery.";
        const error = "The terminal delegated-agent checkpoint could not be persisted.";
        run.terminalOutcome = undefined;
        this.transitionStatus(run, "interrupted");
        run.updatedAt = Date.now();
        run.restoredMutationReport = {
            ...(run.restoredMutationReport ?? mutationReport(run)),
            interrupted: true,
        };
        void this.leases.release(run);
        return this.outcome(run, content, true, progress, error);
    }

    /** Record the settled trace with the usage and size the parent actually saw. */
    private recordTerminalTrace(
        run: AgentRun,
        status: AgentTerminalStatus,
        isError: boolean,
        content: string,
        outcome: AgentRunOutcome,
    ): void {
        this.trace?.finish(run.id, status, {
            isError,
            inputTokens: outcome.details.usage.input,
            outputTokens: outcome.details.usage.output,
            contentChars: content.length,
            background: run.background,
        });
    }

    /**
     * Build the parent-visible outcome for a run, with usage reported as a delta.
     *
     * `details.usage` is cumulative for the logical run; the top-level `usage` is what this call is
     * reporting since the last baseline, because parent tool results are charged per action.
     */
    private outcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
        hasResponse = false,
    ): AgentRunOutcome {
        return runOutcome(run, content, isError, progress, this.maxTaskChars, error, hasResponse);
    }

    /**
     * Report an outcome without changing lifecycle state, and reset the usage baseline.
     *
     * Used by actions that acknowledge work in progress (background start, status, cancel summary):
     * they checkpoint the reported usage and persist best-effort, but must not advance the run.
     */
    private checkpointOutcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
        hasResponse = false,
    ): AgentRunOutcome {
        const outcome = this.outcome(run, content, isError, progress, error, hasResponse);
        run.usageCheckpoint = cloneUsage(outcome.details.usage);
        void this.persistRun(run);
        return outcome;
    }

    /** Project run state and child progress into the parent-visible detail snapshot. */
    private details(
        run: AgentRun,
        progress: ChildProgress,
        error?: string,
        usage?: Usage,
    ): AgentRunDetails {
        return runDetails(run, progress, this.maxTaskChars, error, usage);
    }

    /**
     * Publish progress for a background run through the event sink and its callback.
     *
     * Suppressed once the manager is closing or the run is canceling, because both mean nobody is
     * left to render the update; callback failures are swallowed so a broken UI listener can never
     * prevent a child lifecycle from settling.
     */
    private emitBackgroundUpdate(run: AgentRun, details: AgentRunDetails): void {
        if (this.closing || run.cancelRequested) return;
        this.emitRunEvent(run, {
            type: "run",
            action: "progress",
            runId: run.id,
            status: details.status,
            workspaceId: run.workspaceId,
        });
        try {
            run.backgroundCallback?.(details);
        } catch {
            // UI callbacks must not disrupt child lifecycle settlement.
        }
    }

    /**
     * Track a detached task that keeps running after its action returned.
     *
     * The stored promise lets `cancel` await it, and the final notification is emitted from here so
     * a background run always reports its terminal state once, even when it settles without ever
     * reporting progress.
     */
    private trackBackgroundTask(run: AgentRun, task: Promise<AgentRunOutcome>): void {
        run.backgroundTask = task;
        void task.then(
            (outcome) => {
                if (
                    outcome.details.status === "waiting_for_parent" ||
                    isAgentTerminalStatus(outcome.details.status)
                ) {
                    this.emitBackgroundUpdate(run, outcome.details);
                }
                if (isAgentTerminalStatus(outcome.details.status))
                    run.backgroundCallback = undefined;
                if (run.backgroundTask === task) run.backgroundTask = undefined;
            },
            () => {
                run.backgroundCallback = undefined;
                if (run.backgroundTask === task) run.backgroundTask = undefined;
            },
        );
    }

    /** Drop the oldest retained terminal results once the retention budget is exceeded. */
    private async pruneRetainedResults(): Promise<void> {
        while (true) {
            const runId = this.registry.takeExcessTerminal(this.maxRetainedResults);
            if (!runId) {
                return;
            }
            const run = this.registry.find(runId);
            if (run) {
                await this.removeRun(run, "pruned");
            }
        }
    }

    /**
     * Take a run out of service, in the order safety depends on.
     *
     * 1. Clear the background callback so no further UI update can describe a run that is gone.
     * 2. Unregister and publish `removed`, so listeners stop showing it before its state disappears.
     * 3. Forget terminal retention so the budget cannot keep accounting for it.
     * 4. Wait for this run's in-flight checkpoint to settle, so a removal tombstone cannot race an
     *    earlier save into being the last write.
     * 5. Optionally write the tombstone; restoration and shutdown skip it so the durable record stays
     *    restorable. A tombstone that does not reach storage is traced rather than retried: the run is
     *    already out of service, and another parent may hold the lease by now.
     * 6. Release the continuation lease, and only then dispose the child, so another parent can take
     *    ownership of work that is no longer being written to.
     */
    private async removeRun(
        run: AgentRun,
        reason:
            | "collected"
            | "pruned"
            | "shutdown"
            | "terminal"
            | "canceled"
            | "restored_terminal" = "terminal",
        persistRemoval = true,
    ): Promise<void> {
        run.backgroundCallback = undefined;
        this.registry.remove(run.id);
        this.emitRunEvent(run, {
            type: "run",
            action: "removed",
            runId: run.id,
            status: run.status,
            reason,
            workspaceId: run.workspaceId,
        });
        this.registry.forgetTerminal(run.id);
        await this.checkpoints.waitForPending(run.id);
        if (persistRemoval) {
            if (!(await this.persistRun(run, "removed")) && this.hasPersistence) {
                this.record(run, "persistence.removal_not_persisted", {
                    reason,
                    leaseLost: run.continuationLeaseLost === true,
                });
            }
        }
        await this.leases.release(run);
        this.disposeRun(run);
    }

    /**
     * Checkpoint the run's current state; resolves with whether the write reached storage.
     *
     * `intent` is only ever `intermediate` for the child-hook seam, where a frame must not append a marker;
     * every lifecycle boundary keeps the default.
     */
    private persistRun(
        run: AgentRun,
        status?: PersistedAgentRun["status"],
        intent?: AgentRunCheckpointIntent,
    ): Promise<boolean> {
        return this.checkpoints.save(run, status, intent);
    }

    /**
     * Require the run's current state to be durable before the lifecycle may advance.
     *
     * Only V2 snapshot-marker checkpoints can be lost: legacy persistence keeps its previous
     * best-effort behaviour, where an unsaved checkpoint is a display gap rather than lost work.
     */
    private async requireDurableCheckpoint(run: AgentRun, failureMessage: string): Promise<void> {
        if (!this.persistence?.usesSnapshotMarkers) {
            return;
        }
        if (await this.persistRun(run)) {
            return;
        }
        throw new AgentActionError(failureMessage);
    }

    /**
     * Abort the run's child once, returning the shared abort promise.
     *
     * Returns `undefined` while the child is still being created; the caller relies on setup
     * re-checking `shutdownRequested` or `cancelRequested` before it sends the first prompt.
     */
    private abortRun(run: AgentRun): Promise<void> | undefined {
        if (!run.handle) {
            this.record(run, "child.abort_deferred_until_setup");
            return undefined;
        }
        if (!run.abortPromise) {
            this.record(run, "child.abort_called");
            run.abortPromise = run.handle.abort();
        }
        return run.abortPromise;
    }

    /** Release the child handle, idempotently, so late callbacks cannot revive the run. */
    private disposeRun(run: AgentRun): void {
        if (run.disposed) return;
        run.disposed = true;
        this.record(run, "child.disposed");
        const handle = run.handle;
        run.handle = undefined;
        run.setup = undefined;
        run.abortPromise = undefined;
        handle?.dispose();
    }

    /** Advance a run's status and publish the change once, ignoring no-op transitions. */
    private transitionStatus(run: AgentRun, status: AgentRunStatus): void {
        const previousStatus = run.status;
        if (previousStatus === status) return;
        run.status = status;
        this.emitRunStatusChanged(run, previousStatus, status);
    }

    /** Publish a status transition, including the status it replaced. */
    private emitRunStatusChanged(
        run: AgentRun,
        previousStatus: AgentRunStatus,
        status: AgentRunStatus,
    ): void {
        emitAgentEvent(
            {
                type: "run",
                action: "status_changed",
                parentCwd: run.parentCwd,
                runId: run.id,
                status,
                previousStatus,
                workspaceId: run.workspaceId,
            },
            { sink: this.events, cwd: run.cwd },
        );
    }

    /** Publish a run-scoped event, scoped to the parent session that owns the run. */
    private emitRunEvent(run: AgentRun, event: Extract<AgentEventPayload, { type: "run" }>): void {
        emitAgentEvent({ ...event, parentCwd: run.parentCwd }, { sink: this.events, cwd: run.cwd });
    }

    /** Record a run-scoped trace event, if tracing is configured. */
    private record(run: AgentRun, type: string, data?: AgentTraceData): void {
        this.trace?.record(run.id, type, data);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Await every promise that exists, ignoring rejections.
 *
 * Shutdown must never fail because one child rejected; its run is settled by the caller instead.
 */
async function settleAll<T>(promises: Iterable<Promise<T> | undefined>): Promise<void> {
    const settled = [...promises].filter((promise): promise is Promise<T> => promise !== undefined);
    await Promise.allSettled(settled);
}
