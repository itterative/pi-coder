import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";

import { sleep } from "../../../common/async";
import {
    agentCanEdit,
    fingerprintAgentDefinition,
    isAgentDefinitionFingerprintCompatible,
    snapshotAgentDefinition,
    type AgentDefinition,
} from "../definitions/types";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventPayload, AgentEventSink } from "../contracts/events";
import { AgentContinuationLeaseBusyError } from "../contracts/runs";
import type {
    AgentBackgroundCallback,
    AgentContinuationLease,
    AgentProgressCallback,
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
import type { WorkerMutationReport } from "../contracts/mutations";
import type { AgentTraceData, AgentTraceSink } from "../contracts/trace";
import { renderAgentTask } from "../prompts/renderer";
import { CONTINUATION_LEASE_RECOVERY_GRACE_MS } from "./persistence";
import { cloneUsage, subtractUsage, ZERO_USAGE } from "./usage";

export { ZERO_USAGE } from "./usage";

export type {
    AgentBackgroundCallback,
    AgentContinuationLease,
    AgentProgressCallback,
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

type AgentStartContext = Omit<
    ChildAgentFactoryContext,
    "definition" | "background" | "onProgress" | "onTrace"
>;

interface AgentRun {
    id: string;
    runInstanceId: string;
    title: string;
    agent: string;
    agentSource: string;
    agentFilePath?: string;
    definition?: AgentDefinition;
    task: string;
    initialPrompt?: string;
    status: AgentRunStatus;
    background: boolean;
    handle?: ChildAgentHandle;
    setup?: Promise<ChildAgentHandle>;
    question?: ParentQuestion;
    usageCheckpoint: Usage;
    usageSnapshot: Usage;
    startedAt: number;
    updatedAt: number;
    cwd: string;
    parentCwd: string;
    disposed: boolean;
    shutdownRequested: boolean;
    cancelRequested: boolean;
    mutating: boolean;
    workspaceId?: string;
    definitionFingerprint: string;
    permissionPending: boolean;
    childSessionFile?: string;
    childSessionLeafId?: string | null;
    resumable?: boolean;
    readOnlyReason?: string;
    restoredProgress?: ChildProgress;
    restoredMutationReport?: WorkerMutationReport;
    operation?: Promise<AgentRunOutcome>;
    backgroundTask?: Promise<AgentRunOutcome>;
    backgroundCallback?: AgentBackgroundCallback;
    continuationLease?: AgentContinuationLease;
    continuationLeaseLost?: boolean;
    terminalOutcome?: AgentRunOutcome;
    abortPromise?: Promise<void>;
}

export class AgentActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentActionError";
    }
}

export const BACKGROUND_AGENT_WAIT_GUIDANCE = "Progress and the final result will be delivered asynchronously. Do not duplicate the same investigation in the parent unless you intentionally want overlapping work. If you have no other work to do, report your current progress to the user and end your turn. Do not sleep or poll; an automatic notification will arrive when the run finishes or needs parent guidance.";

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

const MAX_TASK_CHARS = 16_000;
const MAX_TITLE_CHARS = 80;
const MAX_GUIDANCE_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 32_000;
const CONTINUATION_LEASE_RECOVERY_TIMEOUT_MS = 35_000;

export const INTERRUPTED_RESUME_GUIDANCE =
    "Continue from the persisted session. Inspect the current state before proceeding; do not assume interrupted tool calls completed.";

export function deriveAgentTitle(task: string, requestedTitle?: string): string {
    const requested = requestedTitle?.replace(/\s+/g, " ").trim();
    if (requested) return truncate(requested, MAX_TITLE_CHARS);
    const firstLine = task.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Delegated task";
    return truncate(firstLine.replace(/^(?:[-*#>]\s*)+/, ""), MAX_TITLE_CHARS);
}

function isTerminalStatus(status: AgentRunStatus): boolean {
    return status === "completed"
        || status === "failed"
        || status === "aborted"
        || status === "canceled";
}

function continuationLeaseRetryAt(error: unknown): number | undefined {
    if (!(error instanceof AgentContinuationLeaseBusyError)) return undefined;
    return error.leaseUntil;
}

function mutationRunsConflict(candidateWorkspaceId: string | undefined, activeWorkspaceId: string | undefined): boolean {
    // Same-checkout workers share the parent's files and remain single-flight.
    // Isolated workers have separate worktrees and may mutate concurrently.
    return candidateWorkspaceId === undefined
        || activeWorkspaceId === undefined
        || candidateWorkspaceId === activeWorkspaceId;
}

export class AgentRunManager {
    private readonly runs = new Map<string, AgentRun>();
    private readonly terminalOrder: string[] = [];
    private nextRunNumber = 1;
    private closing = false;
    private preservingShutdown = false;
    private readonly restoreAbortController = new AbortController();
    private shutdownPromise?: Promise<void>;
    private persistence?: AgentRunPersistence;

    constructor(
        private readonly factory: ChildAgentFactory,
        private readonly maxActiveRuns = 4,
        private readonly trace?: AgentTraceSink,
        private readonly maxRetainedResults = 20,
        private readonly events?: AgentEventSink,
        private readonly maxTaskChars = MAX_TASK_CHARS,
    ) {}

    setPersistence(persistence: AgentRunPersistence | undefined): void {
        this.persistence = persistence;
    }

    async flushPersistence(): Promise<void> {
        await this.persistence?.flush?.();
    }

    closePersistence(): void {
        this.persistence?.close?.();
    }

    get activeCount(): number {
        return [...this.runs.values()].filter((run) => !isTerminalStatus(run.status)).length;
    }

    get hasActiveMutatingRun(): boolean {
        return [...this.runs.values()].some((run) => run.mutating && !isTerminalStatus(run.status));
    }

    get hasActiveNonIsolatedMutatingRun(): boolean {
        return [...this.runs.values()].some((run) => (
            run.mutating
            && run.workspaceId === undefined
            && !isTerminalStatus(run.status)
        ));
    }

    listRuns(): AgentRunSummary[] {
        return [...this.runs.values()].map((run) => {
            const progress = this.progressSnapshot(run);
            const activity = progress.recentActivity[progress.recentActivity.length - 1];
            const response = progress.output.trim() || progress.lastAssistantMessage?.trim() || "";
            return {
                runId: run.id,
                runInstanceId: run.runInstanceId,
                title: run.title,
                agent: run.agent,
                status: run.permissionPending ? "waiting_for_permission" : run.status,
                background: run.background,
                task: truncate(run.task.replace(/\s+/g, " ").trim(), 120),
                startedAt: run.startedAt,
                updatedAt: run.updatedAt,
                sessionFile: run.childSessionFile,
                childSessionLeafId: run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId,
                sessionLeafId: run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId,
                readOnlyReason: run.readOnlyReason,
                activity: activity ? truncate(activity, 120) : undefined,
                phase: progress.phase,
                lastAssistantMessage: progress.lastAssistantMessage,
                lastToolActivity: progress.lastToolActivity
                    ? truncate(progress.lastToolActivity, 120)
                    : undefined,
                toolCounts: progress.toolCounts ? { ...progress.toolCounts } : undefined,
                failedToolCalls: progress.failedToolCalls,
                responsePreview: response ? truncate(response, 120) : undefined,
                question: run.question ? truncate(run.question.question, 500) : undefined,
                usage: this.readUsage(run),
                mutationReport: this.mutationReport(run),
                mutating: run.mutating,
                workspaceId: run.workspaceId,
            };
        });
    }

    listWaiting(): Array<{ runId: string; agent: string; question: string }> {
        return this.listRuns()
            .filter((run) => run.status === "waiting_for_parent" && run.question !== undefined)
            .map((run) => ({
                runId: run.runId,
                agent: run.agent,
                question: run.question!,
            }));
    }

    async restore(
        records: PersistedAgentRun[],
        definitions: AgentDefinition[],
        context: AgentStartContext,
        onBackgroundUpdate?: AgentBackgroundCallback,
    ): Promise<{ restored: number; diagnostics: string[] }> {
        const diagnostics: string[] = [];
        const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));
        for (const record of records) {
            const suffix = /-(\d+)$/.exec(record.runId)?.[1];
            if (suffix) this.nextRunNumber = Math.max(this.nextRunNumber, Number(suffix) + 1);
        }

        for (const record of records.sort((a, b) => a.startedAt - b.startedAt)) {
            if (this.closing || this.restoreAbortController.signal.aborted) break;
            if (record.status === "removed" || record.ownerSessionId !== this.persistence?.ownerSessionId) continue;
            if (record.resumable === false) {
                diagnostics.push(`Could not restore ${record.runId}: this checkpoint is historical and was continued on another parent branch.`);
                continue;
            }
            const persistedTerminal = record.status === "completed"
                || record.status === "failed"
                || record.status === "aborted"
                || record.status === "canceled";
            const currentDefinition = definitionByName.get(record.agent);
            const definition = record.definitionSnapshot;
            if (!persistedTerminal && !definition) {
                diagnostics.push(`Could not restore ${record.runId}: its persisted agent definition snapshot is unavailable; start a new run.`);
                continue;
            }
            if (!persistedTerminal && currentDefinition && !isAgentDefinitionFingerprintCompatible(currentDefinition, record.definitionFingerprint)) {
                diagnostics.push(`Restored ${record.runId} using its persisted agent definition snapshot; the current definition has changed.`);
            } else if (!persistedTerminal && !currentDefinition) {
                diagnostics.push(`Restored ${record.runId} using its persisted agent definition snapshot; the current definition is unavailable.`);
            }
            const snapshotMutating = definition !== undefined && agentCanEdit(definition);
            const currentMutating = currentDefinition !== undefined && agentCanEdit(currentDefinition);
            if (!persistedTerminal && (
                record.mutating !== snapshotMutating
                || (snapshotMutating && (
                    !currentDefinition
                    || !currentMutating
                    || currentDefinition.name !== "worker"
                    || currentDefinition.source !== "builtin"
                ))
            )) {
                diagnostics.push(`Could not restore ${record.runId}: persisted metadata cannot alter mutation capability.`);
                continue;
            }
            if (!persistedTerminal && this.activeCount >= this.maxActiveRuns) {
                diagnostics.push(`Could not restore ${record.runId}: the active-run limit is ${this.maxActiveRuns}.`);
                continue;
            }
            if (!persistedTerminal && record.mutating && [...this.runs.values()].some((run) => (
                run.mutating
                && !isTerminalStatus(run.status)
                && mutationRunsConflict(record.workspaceId, run.workspaceId)
            ))) {
                diagnostics.push(`Could not restore ${record.runId}: another conflicting mutation-capable worker was restored first.`);
                continue;
            }

            const restoredStatus: AgentRunStatus = record.status === "starting" || record.status === "running"
                ? "interrupted"
                : record.status;
            const run: AgentRun = {
                id: record.runId,
                runInstanceId: record.runInstanceId ?? randomUUID(),
                title: deriveAgentTitle(record.task, record.title),
                agent: record.agent,
                agentSource: persistedTerminal ? record.agentSource : definition!.source,
                agentFilePath: persistedTerminal ? record.agentFilePath : definition!.filePath,
                definition,

                definitionFingerprint: record.definitionFingerprint,
                task: record.task,
                status: restoredStatus,
                background: record.background,
                question: restoredStatus === "waiting_for_parent" ? record.question : undefined,
                usageCheckpoint: cloneUsage(record.usageCheckpoint),
                usageSnapshot: cloneUsage(record.usageSnapshot),
                startedAt: record.startedAt,
                updatedAt: record.updatedAt,
                cwd: record.cwd ?? context.cwd,
                parentCwd: record.parentCwd ?? context.parentCwd ?? context.cwd,
                disposed: persistedTerminal,
                shutdownRequested: false,
                cancelRequested: false,
                mutating: persistedTerminal ? record.mutating : snapshotMutating,
                workspaceId: record.workspaceId,
                permissionPending: false,
                childSessionFile: record.childSessionFile,
                childSessionLeafId: record.childSessionLeafId,
                resumable: record.resumable,
                readOnlyReason: record.readOnlyReason,
                restoredProgress: record.progress,
                restoredMutationReport: record.mutationReport,
            };
            this.runs.set(run.id, run);
            this.emitRunEvent(run, {
                type: "run",
                action: "restored",
                runId: run.id,
                agent: run.agent,
                background: run.background,
                status: run.status,
                workspaceId: run.workspaceId,
            });

            if (persistedTerminal) {
                const content = record.terminalContent ?? `Agent ${run.id} ${record.status}.`;
                run.terminalOutcome = this.outcome(
                    run,
                    content,
                    record.terminalIsError ?? record.status !== "completed",
                    record.progress,
                    record.terminalError,
                );
                if (run.background) {
                    this.terminalOrder.push(run.id);
                    this.pruneRetainedResults();
                } else {
                    this.removeRun(run, "restored_terminal", false);
                }
                continue;
            }

            if (!record.childSessionFile) {
                diagnostics.push(`Could not restore ${record.runId}: its child transcript is unavailable.`);
                this.runs.delete(run.id);
                continue;
            }
            if (this.persistence?.usesSnapshotMarkers === true
                && record.resumable !== undefined
                && record.childSessionLeafId === undefined) {
                diagnostics.push(`Could not restore ${record.runId}: its checkpoint has no exact child transcript leaf.`);
                this.runs.delete(run.id);
                continue;
            }
            this.trace?.start(run.id, run.agent, {
                source: run.agentSource,
                background: run.background,
                restored: true,
                restoredStatus,
            });
            run.backgroundCallback = record.background ? onBackgroundUpdate : undefined;
            try {
                const acquired = await this.acquireRunContinuationLeaseWithRecovery(run, this.restoreAbortController.signal);
                if (!acquired || this.closing || this.restoreAbortController.signal.aborted) {
                    this.runs.delete(run.id);
                    continue;
                }
                await this.setupRun(run, definition!, {
                    ...context,
                    cwd: run.cwd,
                    workspaceId: run.workspaceId,
                    childSessionFile: record.childSessionFile,
                    childSessionLeafId: record.childSessionLeafId,
                    // V2 records are never repaired during restore. The legacy
                    // compatibility path retains its old factory contract only.
                    repairInterrupted: restoredStatus === "interrupted"
                        && this.persistence?.usesSnapshotMarkers !== true,
                    initialProgress: record.progress,
                    initialMutationReport: record.mutationReport,
                }, undefined, undefined, true);
                if (restoredStatus === "interrupted") {
                    run.restoredMutationReport = {
                        ...(run.restoredMutationReport ?? { changedFiles: [], bashApproved: false }),
                        interrupted: true,
                    };
                    if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
                        throw new Error("Could not persist the restored interrupted checkpoint.");
                    }
                }
            } catch (error) {
                diagnostics.push(`Could not restore ${record.runId}: ${errorMessage(error)}`);
                this.runs.delete(run.id);
            } finally {
                this.releaseRunContinuationLease(run);
            }
        }
        return { restored: this.runs.size, diagnostics };
    }

    /** Reserve the physical/display identity before an isolated workspace starts running. */
    reserveRunIdentity(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
    ): AgentRunIdentity {
        if (this.closing) throw new AgentActionError("Agent runtime is shutting down.");
        const definition = this.resolveDefinition(definitionOrName);
        this.validateRunStart(definition, task, context);
        return this.allocateRunIdentity(definition);
    }

    async start(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
        title?: string,
        identity?: AgentRunIdentity,
    ): Promise<AgentRunOutcome> {
        const { definition, run } = this.createRun(definitionOrName, task, context, false, title, identity);
        const setupOutcome = await this.setupRun(
            run,
            definition,
            context,
            signal,
            onProgress,
        );
        if (setupOutcome) return setupOutcome;
        return this.beginOperation(run, run.initialPrompt ?? task, signal, onProgress);
    }

    spawn(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        signal?: AbortSignal,
        onBackgroundUpdate?: AgentBackgroundCallback,
        title?: string,
        identity?: AgentRunIdentity,
    ): AgentRunOutcome {
        if (signal?.aborted) throw new AgentActionError("Agent spawn was aborted before launch.");
        const { definition, run } = this.createRun(definitionOrName, task, context, true, title, identity);
        run.backgroundCallback = onBackgroundUpdate;
        const taskPromise = this.launchBackground(run, definition, context).catch((error) => {
            if (isTerminalStatus(run.status)) return run.terminalOutcome!;
            return this.finishFailure(
                run,
                `Background agent failed unexpectedly: ${errorMessage(error)}`,
            );
        });
        this.trackBackgroundTask(run, taskPromise);
        return this.checkpointOutcome(
            run,
            `Agent ${run.id} started in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE} After a terminal notification, retrieve the full result with agent(action="collect", runId="${run.id}").`,
            false,
            { output: "", recentActivity: [] },
        );
    }

    async startContinuation(
        definitionOrName: AgentDefinition | string,
        task: string,
        prompt: string,
        context: AgentStartContext,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
        title?: string,
        identity?: AgentRunIdentity,
    ): Promise<AgentRunOutcome> {
        const { definition, run } = this.createRun(definitionOrName, task, context, false, title, identity);
        const setupOutcome = await this.setupRun(
            run,
            definition,
            context,
            signal,
            onProgress,
        );
        if (setupOutcome) return setupOutcome;
        return this.beginOperation(run, prompt, signal, onProgress);
    }

    async resume(
        runId: string,
        guidance?: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const run = this.runs.get(runId);
        if (!run) {
            throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        }
        if (run.status !== "waiting_for_parent" && run.status !== "interrupted") {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; only waiting or interrupted runs can be resumed.`,
            );
        }
        const normalizedGuidance = guidance?.trim();
        if (run.status === "waiting_for_parent" && !normalizedGuidance) {
            throw new AgentActionError("Waiting agent runs require parent guidance.");
        }
        if (normalizedGuidance && normalizedGuidance.length > MAX_GUIDANCE_CHARS) {
            throw new AgentActionError(`Parent guidance exceeds ${MAX_GUIDANCE_CHARS} characters.`);
        }
        if (this.closing) {
            throw new AgentActionError("Agent runtime is shutting down.");
        }

        if (signal?.aborted) throw new AgentActionError("Agent resume was aborted before launch.");
        const resumeGuidance = normalizedGuidance ?? INTERRUPTED_RESUME_GUIDANCE;
        const previousStatus = run.status;
        const previousQuestion = run.question;
        const previousUpdatedAt = run.updatedAt;
        try {
            const acquired = await this.acquireRunContinuationLeaseWithRecovery(
                run,
                this.continuationLeaseRecoverySignal(signal),
            );
            if (!acquired) {
                throw new AgentActionError("Agent resume was aborted before acquiring the continuation lease.");
            }
            if (run.status === "interrupted") {
                const repaired = run.handle?.repairInterrupted?.() ?? 0;
                run.childSessionLeafId = run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId;
                this.record(run, "session.repaired", { unmatchedToolCalls: repaired });
                if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
                    throw new AgentActionError("Could not persist the resumed delegated-agent checkpoint.");
                }
            }
            this.record(run, "resume.requested", { guidanceChars: resumeGuidance.length, userDriven: !normalizedGuidance });
            this.transitionStatus(run, "running");
            run.question = undefined;
            run.updatedAt = Date.now();
            if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
                throw new AgentActionError("Could not persist the resumed delegated-agent checkpoint.");
            }
        } catch (error) {
            if (run.status !== previousStatus) this.transitionStatus(run, previousStatus);
            run.question = previousQuestion;
            run.updatedAt = previousUpdatedAt;
            this.releaseRunContinuationLease(run);
            throw error;
        }
        const prompt = `Parent guidance:\n${resumeGuidance}`;
        if (!run.background) {
            try {
                return await this.beginOperation(run, prompt, signal, onProgress);
            } finally {
                this.releaseRunContinuationLease(run);
            }
        }

        const taskPromise = Promise.resolve()
            .then(() => this.beginOperation(run, prompt))
            .catch((error) => {
                if (isTerminalStatus(run.status)) return run.terminalOutcome!;
                return this.finishFailure(
                    run,
                    `Background agent failed unexpectedly: ${errorMessage(error)}`,
                );
            })
            .finally(() => this.releaseRunContinuationLease(run));
        this.trackBackgroundTask(run, taskPromise);
        return this.checkpointOutcome(
            run,
            `Agent ${run.id} resumed in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE}`,
            false,
            run.handle?.getProgress() ?? { output: "", recentActivity: [] },
        );
    }

    async cancel(runId: string): Promise<AgentRunOutcome> {
        const run = this.requireRun(runId);
        if (isTerminalStatus(run.status)) {
            throw new AgentActionError(
                `Agent run ${runId} is already ${run.status}; collect its result instead.`,
            );
        }
        this.record(run, "cancel.requested", { status: run.status });
        run.cancelRequested = true;
        if (run.status === "starting" || run.status === "running") {
            void this.abortRun(run)?.catch(() => {});
            if (run.background) await run.backgroundTask?.catch(() => {});
        }
        let terminalOutcome = run.terminalOutcome;
        if (!isTerminalStatus(run.status)) {
            terminalOutcome = this.finishTerminal(
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
            this.progressSnapshot(run),
            terminalOutcome?.details.error,
        );
        this.removeRun(run, "canceled");
        return outcome;
    }

    status(runId: string): AgentRunOutcome {
        const run = this.requireRun(runId);
        const progress = this.progressSnapshot(run);
        let content: string;
        if (run.status === "waiting_for_parent" && run.question) {
            content = this.waitingContent(run, run.question, progress);
        } else if (isTerminalStatus(run.status)) {
            content = run.status === "completed"
                ? `Agent ${run.id} completed. Retrieve its result with agent(action="collect", runId="${run.id}").`
                : `Agent ${run.id} ${run.status}: ${truncate(run.terminalOutcome?.content ?? "", 2_000)}\n\nRetrieve the retained result with agent(action="collect", runId="${run.id}").`;
        } else if (run.status === "interrupted") {
            content = `Agent ${run.id} was interrupted before it reached a safe terminal state. Resume it only with explicit, grounded guidance; interrupted tool outcomes may be uncertain.`;
        } else {
            const sections = [`Agent ${run.id} is ${run.status} in the background.`];
            if (progress.output.trim()) {
                sections.push(`Partial output:\n${truncate(progress.output.trim(), 4_000)}`);
            }
            if (progress.recentActivity.length) {
                sections.push(`Recent activity:\n- ${progress.recentActivity.slice(-8).join("\n- ")}`);
            }
            sections.push(BACKGROUND_AGENT_WAIT_GUIDANCE);
            content = sections.join("\n\n");
        }
        return this.checkpointOutcome(
            run,
            content,
            run.status === "failed" || run.status === "aborted",
            progress,
            run.terminalOutcome?.details.error,
        );
    }

    collect(runId: string): AgentRunOutcome {
        const run = this.requireRun(runId);
        if (!run.background) {
            throw new AgentActionError(`Agent run ${runId} is not a background run.`);
        }
        if (!isTerminalStatus(run.status) || !run.terminalOutcome) {
            throw new AgentActionError(
                `Agent run ${runId} is ${run.status}; wait for its automatic terminal notification before collecting.`,
            );
        }
        const progress = this.progressSnapshot(run);
        const outcome = this.checkpointOutcome(
            run,
            run.terminalOutcome.content,
            run.terminalOutcome.isError,
            progress,
            run.terminalOutcome.details.error,
        );
        this.record(run, "result.collected");
        this.removeRun(run, "collected");
        return outcome;
    }

    private createRun(
        definitionOrName: AgentDefinition | string,
        task: string,
        context: AgentStartContext,
        background: boolean,
        requestedTitle?: string,
        requestedIdentity?: AgentRunIdentity,
    ): { definition: AgentDefinition; run: AgentRun } {
        if (this.closing) throw new AgentActionError("Agent runtime is shutting down.");
        const definition = this.resolveDefinition(definitionOrName);
        this.validateRunStart(definition, task, context);
        const identity = requestedIdentity ?? this.allocateRunIdentity(definition);
        if (this.runs.has(identity.runId)) {
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
            initialPrompt: renderAgentTask(task, context.agentContext, definition.contextPolicy),
            status: "starting",
            background,
            usageCheckpoint: cloneUsage(ZERO_USAGE),
            usageSnapshot: cloneUsage(ZERO_USAGE),
            startedAt: now,
            updatedAt: now,
            cwd: context.cwd,
            parentCwd: context.parentCwd ?? context.cwd,
            workspaceId: context.workspaceId,
            disposed: false,
            shutdownRequested: false,
            cancelRequested: false,
            mutating: agentCanEdit(definition),
            definitionFingerprint: fingerprintAgentDefinition(definition),
            permissionPending: false,
            resumable: true,
        };
        this.runs.set(id, run);
        this.emitRunEvent(run, {
            type: "run",
            action: "created",
            runId: run.id,
            agent: run.agent,
            background: run.background,
            status: run.status,
            workspaceId: run.workspaceId,
        });
        if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
            this.runs.delete(run.id);
            throw new AgentActionError("Could not reserve the delegated-agent continuation checkpoint.");
        }
        try {
            this.acquireRunContinuationLease(run);
        } catch (error) {
            this.runs.delete(run.id);
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

    private acquireRunContinuationLease(run: AgentRun): void {
        if (run.continuationLease || !this.persistence?.usesSnapshotMarkers) return;
        const acquire = this.persistence.acquireContinuationLease;
        if (!acquire) return;
        run.continuationLease = acquire(run.runInstanceId, () => {
            run.continuationLeaseLost = true;
            void this.abortRun(run)?.catch(() => {});
        });
    }

    private releaseRunContinuationLease(run: AgentRun): void {
        const lease = run.continuationLease;
        if (!lease) return;
        run.continuationLease = undefined;
        lease.release();
    }

    private continuationLeaseRecoverySignal(signal?: AbortSignal): AbortSignal {
        if (!signal) return this.restoreAbortController.signal;
        return AbortSignal.any([this.restoreAbortController.signal, signal]);
    }

    private async acquireRunContinuationLeaseWithRecovery(
        run: AgentRun,
        signal: AbortSignal,
    ): Promise<boolean> {
        const deadline = Date.now() + CONTINUATION_LEASE_RECOVERY_TIMEOUT_MS;
        while (true) {
            if (this.closing || signal.aborted) return false;

            try {
                this.acquireRunContinuationLease(run);
                return true;
            } catch (error) {
                const retryAt = continuationLeaseRetryAt(error);
                if (retryAt === undefined || Date.now() >= deadline) throw error;

                const remaining = deadline - Date.now();
                const delay = Math.max(1, retryAt - Date.now() + CONTINUATION_LEASE_RECOVERY_GRACE_MS);
                try {
                    await sleep(Math.min(delay, remaining), signal);
                } catch (sleepError) {
                    if (signal.aborted || this.closing) return false;
                    throw sleepError;
                }
            }
        }
    }

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
            agentCanEdit(definition)
            && [...this.runs.values()].some((candidate) => (
                candidate.mutating
                && !isTerminalStatus(candidate.status)
                && mutationRunsConflict(context.workspaceId, candidate.workspaceId)
            ))
        ) {
            throw new AgentActionError(
                context.workspaceId
                    ? "A mutation-capable worker is already active in this workspace."
                    : "A same-checkout mutation-capable worker is already active.",
            );
        }
    }

    private allocateRunIdentity(definition: AgentDefinition): AgentRunIdentity {
        return {
            runId: `${definition.name}-${this.nextRunNumber++}`,
            runInstanceId: randomUUID(),
        };
    }

    private async setupRun(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
        preserveOnSetupFailure = false,
    ): Promise<AgentRunOutcome | undefined> {
        try {
            this.record(run, "setup.started");
            const setup = this.factory({
                ...context,
                definition,
                background: run.background,
                runId: run.id,
                runTitle: run.title,
                childSessionDir: this.persistence?.childSessionDir,
                childSessionFile: run.childSessionFile ?? context.childSessionFile,
                childSessionLeafId: run.childSessionLeafId ?? context.childSessionLeafId,
                repairInterrupted: context.repairInterrupted,
                initialProgress: context.initialProgress ?? run.restoredProgress,
                initialMutationReport: context.initialMutationReport ?? run.restoredMutationReport,
                onSessionCreated: (sessionFile, childSessionLeafId) => {
                    run.childSessionFile = sessionFile;
                    run.childSessionLeafId = childSessionLeafId;
                    this.persistRun(run);
                    context.onSessionCreated?.(sessionFile, childSessionLeafId);
                },
                onFileChanged: () => {
                    run.updatedAt = Date.now();
                    this.persistRun(run);
                    this.emitBackgroundUpdate(
                        run,
                        this.details(run, run.handle?.getProgress() ?? { output: "", recentActivity: [] }),
                    );
                },
                onProgress: (progress) => {
                    run.updatedAt = Date.now();
                    const childSessionLeafId = run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId;
                    const childLeafChanged = childSessionLeafId !== run.childSessionLeafId;
                    run.childSessionLeafId = childSessionLeafId;
                    if (childLeafChanged) {
                        this.persistRun(run);
                    }
                    const previousStatus = run.permissionPending ? "waiting_for_permission" : run.status;
                    run.permissionPending = progress.permissionPending === true;
                    this.record(run, "child.progress", {
                        outputChars: progress.output.length,
                        activity: progress.recentActivity[progress.recentActivity.length - 1] ?? "",
                    });
                    const details = this.details(run, progress);
                    if (previousStatus !== details.status) {
                        this.emitRunStatusChanged(run, previousStatus, details.status);
                    }
                    this.emitBackgroundUpdate(run, details);
                    onProgress?.(details);
                },
                onTrace: (type, data) => this.record(run, `child.${type}`, data),
            });
            run.setup = setup;
            run.handle = await setup;
            run.childSessionFile = run.handle.sessionFile ?? run.childSessionFile;
            run.childSessionLeafId = run.handle.getSessionLeafId?.() ?? run.childSessionLeafId;
            run.setup = undefined;
            if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
                return this.finishFailure(run, "Could not durably checkpoint the delegated-agent child session before execution.");
            }
            this.record(run, "setup.completed");
        } catch (error) {
            run.setup = undefined;
            const message = errorMessage(error);
            this.record(run, "setup.failed", { error: truncate(message, 500) });
            if (preserveOnSetupFailure) {
                this.runs.delete(run.id);
                throw new Error(`Failed to reopen child session: ${message}`);
            }
            return this.finishFailure(run, `Failed to create child session: ${message}`);
        }

        if (run.cancelRequested) {
            this.record(run, "setup.canceled_after_completion");
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (this.closing || run.shutdownRequested || signal?.aborted) {
            this.record(run, "setup.aborted_after_completion");
            if (signal?.aborted) await this.abortRun(run)?.catch(() => {});
            return this.preservingShutdown && run.childSessionFile
                ? this.finishInterrupted(run, "Agent run was interrupted during session shutdown.")
                : this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }
        return undefined;
    }

    private async launchBackground(
        run: AgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
    ): Promise<AgentRunOutcome> {
        const setupOutcome = await this.setupRun(run, definition, context);
        if (setupOutcome) return setupOutcome;
        return this.beginOperation(run, run.initialPrompt ?? run.task);
    }

    private requireRun(runId: string): AgentRun {
        const run = this.runs.get(runId);
        if (!run) throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        return run;
    }

    shutdown(): Promise<void> {
        this.shutdownPromise ??= this.performShutdown();
        return this.shutdownPromise;
    }

    private async performShutdown(): Promise<void> {
        this.closing = true;
        this.restoreAbortController.abort();
        this.preservingShutdown = this.persistence !== undefined;

        const runs = [...this.runs.values()];
        for (const run of runs) {
            this.record(run, "shutdown.requested", { status: run.status });
            run.shutdownRequested = true;
            if (run.status === "running" || run.status === "starting") {
                void this.abortRun(run)?.catch(() => {});
            }
        }

        await Promise.allSettled(
            runs
                .map((run) => run.setup)
                .filter((setup): setup is Promise<ChildAgentHandle> => setup !== undefined),
        );

        for (const run of runs) {
            run.shutdownRequested = true;
            if (run.status === "running" || run.status === "starting") {
                void this.abortRun(run)?.catch(() => {});
            }
        }
        await Promise.allSettled(
            runs
                .map((run) => run.operation)
                .filter((operation): operation is Promise<AgentRunOutcome> => operation !== undefined),
        );

        for (const run of runs) {
            if (!this.runs.has(run.id)) continue;
            if (this.preservingShutdown) {
                if (run.status === "waiting_for_parent" || run.status === "interrupted") {
                    this.persistRun(run);
                    this.disposeRun(run);
                } else if (!isTerminalStatus(run.status)) {
                    this.finishInterrupted(run, "Agent run was interrupted during session shutdown.");
                }
                this.removeRun(run, "shutdown", false);
                continue;
            }
            if (!isTerminalStatus(run.status)) {
                this.transitionStatus(run, "aborted");
                run.updatedAt = Date.now();
                this.disposeRun(run);
                this.trace?.finish(run.id, "aborted", {
                    isError: true,
                    reason: "session_shutdown",
                });
            }
            this.removeRun(run, "shutdown", false);
        }
    }

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
            return this.finishInterrupted(run, "Delegated-agent continuation ownership was lost before launch.");
        }
        if (this.closing || run.shutdownRequested || signal?.aborted) {
            if (signal?.aborted) await this.abortRun(run)?.catch(() => {});
            return this.preservingShutdown && run.childSessionFile
                ? this.finishInterrupted(run, "Agent run was interrupted during session shutdown.")
                : this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }
        this.transitionStatus(run, "running");
        run.updatedAt = Date.now();
        if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
            return this.finishFailure(run, "Could not durably checkpoint the delegated-agent operation before execution.");
        }
        this.emitBackgroundUpdate(
            run,
            this.details(run, run.handle?.getProgress() ?? { output: "", recentActivity: [] }),
        );
        this.record(run, "operation.started", {
            kind: prompt.startsWith("Parent guidance:\n") ? "resume" : "start",
            promptChars: prompt.length,
        });
        const operation = this.drive(run, prompt, signal, onProgress);
        run.operation = operation;
        try {
            return await operation;
        } finally {
            if (run.operation === operation) run.operation = undefined;
        }
    }

    private async drive(
        run: AgentRun,
        prompt: string,
        signal?: AbortSignal,
        onProgress?: AgentProgressCallback,
    ): Promise<AgentRunOutcome> {
        const handle = run.handle!;
        let aborted = signal?.aborted ?? false;
        const abort = () => {
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
                this.captureChildSessionLeaf(run);
                if (run.continuationLeaseLost) {
                    await run.abortPromise?.catch(() => {});
                    return this.finishInterrupted(run, "Delegated-agent continuation ownership was lost during execution.");
                }
                if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
                    await this.abortRun(run)?.catch(() => {});
                    return this.finishInterrupted(run, "Could not durably checkpoint the settled delegated-agent operation.");
                }
                this.record(run, "operation.prompt_settled");
            }
            await run.abortPromise?.catch(() => {});
        } catch (error) {
            const message = errorMessage(error);
            this.record(run, "operation.prompt_failed", { error: truncate(message, 500) });
            await run.abortPromise?.catch(() => {});
            if (run.continuationLeaseLost) {
                return this.finishInterrupted(run, "Delegated-agent continuation ownership was lost during execution.");
            }
            if (!aborted && !run.shutdownRequested && !run.cancelRequested) {
                return this.finishFailure(run, message);
            }
        } finally {
            signal?.removeEventListener("abort", abort);
        }

        if (run.cancelRequested) {
            return this.finishTerminal(run, "canceled", `Agent run ${run.id} canceled.`, false);
        }
        if (run.continuationLeaseLost) {
            return this.finishInterrupted(run, "Delegated-agent continuation ownership was lost during execution.");
        }
        if (aborted || run.shutdownRequested || this.closing) {
            return this.preservingShutdown && run.childSessionFile
                ? this.finishInterrupted(run, "Agent run was interrupted during session shutdown.")
                : this.finishTerminal(run, "aborted", "Agent run was aborted.", true);
        }

        const question = handle.takeParentQuestion();
        const progress = handle.getProgress();
        const childError = handle.getError();
        if (question) {
            this.record(run, "guidance.requested", {
                questionChars: question.question.length,
                questionPreview: truncate(question.question.replace(/\s+/g, " "), 240),
                optionCount: question.options?.length ?? 0,
            });
            this.transitionStatus(run, "waiting_for_parent");
            run.question = question;
            run.updatedAt = Date.now();
            const outcome = this.outcome(
                run,
                this.waitingContent(run, question, progress),
                false,
                progress,
            );
            if (!run.background) {
                run.usageCheckpoint = cloneUsage(run.handle!.getUsage());
            }
            run.restoredProgress = progress;
            run.restoredMutationReport = this.mutationReport(run);
            if (this.persistence?.usesSnapshotMarkers && !this.persistRun(run)) {
                return this.finishInterrupted(run, "Could not durably checkpoint the delegated-agent guidance request.");
            }
            this.releaseRunContinuationLease(run);
            onProgress?.(outcome.details);
            return outcome;
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

    private waitingContent(
        run: AgentRun,
        question: ParentQuestion,
        progress: ChildProgress,
    ): string {
        const sections = [
            `Agent ${run.id} is waiting for parent guidance.`,
            `Question: ${truncate(question.question, 4_000)}`,
        ];
        if (question.context) sections.push(`Context:\n${truncate(question.context, 12_000)}`);
        if (progress.output.trim()) {
            sections.push(`Partial child output:\n${truncate(progress.output.trim(), 12_000)}`);
        }
        if (question.options?.length) {
            sections.push(`Options:\n${question.options.map((option) => `- ${truncate(option, 1_000)}`).join("\n")}`);
        }
        if (question.recommendation) {
            sections.push(`Recommendation: ${truncate(question.recommendation, 4_000)}`);
        }
        sections.push(`Resume with agent(action="resume", runId="${run.id}", guidance="...").`);
        return sections.join("\n\n");
    }

    private finishFailure(
        run: AgentRun,
        error: string,
        progress: ChildProgress = run.handle?.getProgress() ?? { output: "", recentActivity: [] },
    ): AgentRunOutcome {
        return this.finishTerminal(run, "failed", error, true, progress);
    }

    private finishInterrupted(run: AgentRun, content: string): AgentRunOutcome {
        this.captureChildSessionLeaf(run);
        const progress = run.handle?.getProgress() ?? run.restoredProgress ?? { output: "", recentActivity: [] };
        this.transitionStatus(run, "interrupted");
        run.permissionPending = false;
        run.updatedAt = Date.now();
        run.restoredProgress = progress;
        run.restoredMutationReport = {
            ...this.mutationReport(run),
            interrupted: true,
        };
        const outcome = this.outcome(run, content, true, progress, content);
        this.persistRun(run);
        this.releaseRunContinuationLease(run);
        return outcome;
    }

    private finishTerminal(
        run: AgentRun,
        status: "completed" | "failed" | "aborted" | "canceled",
        content: string,
        isError: boolean,
        progress: ChildProgress = run.handle?.getProgress() ?? { output: "", recentActivity: [] },
    ): AgentRunOutcome {
        if (isTerminalStatus(run.status) && run.terminalOutcome) return run.terminalOutcome;
        this.captureChildSessionLeaf(run);
        this.transitionStatus(run, status);
        run.permissionPending = false;
        run.updatedAt = Date.now();
        const report = this.mutationReport(run);
        run.restoredProgress = progress;
        run.restoredMutationReport = report;
        const outcome = this.outcome(run, content, isError, progress, status === "failed" ? content : undefined);
        if (run.background) {
            run.terminalOutcome = outcome;
            const persisted = this.persistRun(run);
            if (this.persistence?.usesSnapshotMarkers && !persisted) {
                run.terminalOutcome = undefined;
                this.transitionStatus(run, "interrupted");
                run.updatedAt = Date.now();
                run.restoredMutationReport = { ...report, interrupted: true };
                const interrupted = this.outcome(
                    run,
                    "The terminal delegated-agent checkpoint could not be persisted; the run remains interrupted for explicit recovery.",
                    true,
                    progress,
                    "The terminal delegated-agent checkpoint could not be persisted.",
                );
                this.releaseRunContinuationLease(run);
                return interrupted;
            }
            this.terminalOrder.push(run.id);
            this.releaseRunContinuationLease(run);
            this.disposeRun(run);
            this.trace?.finish(run.id, status, {
                isError,
                inputTokens: outcome.details.usage.input,
                outputTokens: outcome.details.usage.output,
                contentChars: content.length,
                background: run.background,
            });
            // Completed transcripts remain browseable from /agents even after
            // the bounded in-memory result is collected or evicted.
            this.pruneRetainedResults();
        } else {
            this.removeRun(run, "terminal");
            this.disposeRun(run);
            this.trace?.finish(run.id, status, {
                isError,
                inputTokens: outcome.details.usage.input,
                outputTokens: outcome.details.usage.output,
                contentChars: content.length,
                background: run.background,
            });
        }
        return outcome;
    }

    private outcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
    ): AgentRunOutcome {
        const cumulative = this.readUsage(run);
        const usage = subtractUsage(cumulative, run.usageCheckpoint);
        const details = this.details(run, progress, error, cumulative);
        return { content, details, usage, isError };
    }

    private checkpointOutcome(
        run: AgentRun,
        content: string,
        isError: boolean,
        progress: ChildProgress,
        error?: string,
    ): AgentRunOutcome {
        const outcome = this.outcome(run, content, isError, progress, error);
        run.usageCheckpoint = cloneUsage(outcome.details.usage);
        this.persistRun(run);
        return outcome;
    }

    private details(
        run: AgentRun,
        progress: ChildProgress,
        error?: string,
        usage?: Usage,
    ): AgentRunDetails {
        const cumulative = usage ?? this.readUsage(run);
        return {
            runId: run.id,
            runInstanceId: run.runInstanceId,
            title: run.title,
            agent: run.agent,
            agentSource: run.agentSource,
            agentFilePath: run.agentFilePath,
            status: run.permissionPending ? "waiting_for_permission" : run.status,
            background: run.background,
            task: truncate(run.task, this.maxTaskChars),
            workspaceId: run.workspaceId,
            childSessionLeafId: run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId,
            output: progress.output ? truncate(progress.output, MAX_OUTPUT_CHARS) : undefined,
            question: run.question,
            recentActivity: progress.recentActivity.slice(-8),
            phase: progress.phase,
            lastAssistantMessage: progress.lastAssistantMessage,
            lastToolActivity: progress.lastToolActivity,
            toolCounts: progress.toolCounts ? { ...progress.toolCounts } : undefined,
            failedToolCalls: progress.failedToolCalls,
            usage: cloneUsage(cumulative),
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
            error,
            mutating: run.mutating,
            mutationReport: this.mutationReport(run),
        };
    }

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

    private readUsage(run: AgentRun): Usage {
        if (run.handle) run.usageSnapshot = cloneUsage(run.handle.getUsage());
        return cloneUsage(run.usageSnapshot);
    }

    private trackBackgroundTask(run: AgentRun, task: Promise<AgentRunOutcome>): void {
        run.backgroundTask = task;
        void task.then(
            (outcome) => {
                if (outcome.details.status === "waiting_for_parent" || isTerminalStatus(outcome.details.status)) {
                    this.emitBackgroundUpdate(run, outcome.details);
                }
                if (isTerminalStatus(outcome.details.status)) run.backgroundCallback = undefined;
                if (run.backgroundTask === task) run.backgroundTask = undefined;
            },
            () => {
                run.backgroundCallback = undefined;
                if (run.backgroundTask === task) run.backgroundTask = undefined;
            },
        );
    }

    private progressSnapshot(run: AgentRun): ChildProgress {
        if (run.handle) return run.handle.getProgress();
        if (run.restoredProgress) return {
            ...run.restoredProgress,
            recentActivity: [...run.restoredProgress.recentActivity],
            ...(run.restoredProgress.toolCounts
                ? { toolCounts: { ...run.restoredProgress.toolCounts } }
                : {}),
        };
        return {
            output: run.terminalOutcome?.details.output ?? "",
            recentActivity: run.terminalOutcome?.details.recentActivity ?? [],
        };
    }

    private pruneRetainedResults(): void {
        while (this.terminalOrder.length > this.maxRetainedResults) {
            const runId = this.terminalOrder.shift();
            const run = runId ? this.runs.get(runId) : undefined;
            if (run) this.removeRun(run, "pruned");
        }
    }

    private removeRun(
        run: AgentRun,
        reason: "collected" | "pruned" | "shutdown" | "terminal" | "canceled" | "restored_terminal" = "terminal",
        persistRemoval = true,
    ): void {
        run.backgroundCallback = undefined;
        this.runs.delete(run.id);
        this.emitRunEvent(run, {
            type: "run",
            action: "removed",
            runId: run.id,
            status: run.status,
            reason,
            workspaceId: run.workspaceId,
        });
        const terminalIndex = this.terminalOrder.indexOf(run.id);
        if (terminalIndex >= 0) this.terminalOrder.splice(terminalIndex, 1);
        if (persistRemoval) this.persistRun(run, "removed");
        this.releaseRunContinuationLease(run);
        this.disposeRun(run);
    }

    private mutationReport(run: AgentRun): WorkerMutationReport {
        const current = run.handle?.getMutationReport?.();
        const changedFiles = new Set([
            ...(run.restoredMutationReport?.changedFiles ?? []),
            ...(current?.changedFiles ?? []),
        ]);
        const readFiles = new Set([
            ...(run.restoredMutationReport?.readFiles ?? []),
            ...(current?.readFiles ?? []),
        ]);
        const interrupted = run.restoredMutationReport?.interrupted === true || current?.interrupted === true;
        return {
            changedFiles: [...changedFiles].sort(),
            ...(readFiles.size ? { readFiles: [...readFiles].sort() } : {}),
            bashApproved: run.restoredMutationReport?.bashApproved === true || current?.bashApproved === true,
            ...(interrupted ? { interrupted: true } : {}),
        };
    }

    private captureChildSessionLeaf(run: AgentRun): boolean {
        const childSessionLeafId = run.handle?.getSessionLeafId?.();
        if (childSessionLeafId === undefined || childSessionLeafId === run.childSessionLeafId) return false;
        run.childSessionLeafId = childSessionLeafId;
        return true;
    }

    private persistRun(
        run: AgentRun,
        status?: PersistedAgentRun["status"],
    ): boolean {
        if (!this.persistence) return false;
        if (this.persistence.usesSnapshotMarkers && run.continuationLeaseLost) return false;
        const durableStatus: PersistedAgentRun["status"] = status
            ?? (run.status === "waiting_for_permission" ? "running" : run.status);
        const progress = this.progressSnapshot(run);
        const usageSnapshot = this.readUsage(run);
        const terminal = run.terminalOutcome;
        run.childSessionLeafId = run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId;
        return this.persistence.save({
            version: 1,
            ownerSessionId: this.persistence.ownerSessionId,
            runId: run.id,
            runInstanceId: run.runInstanceId,
            title: run.title,
            agent: run.agent,
            agentSource: run.agentSource,
            agentFilePath: run.agentFilePath,
            definitionFingerprint: run.definitionFingerprint,
            ...(run.definition ? { definitionSnapshot: snapshotAgentDefinition(run.definition) } : {}),
            task: truncate(run.task, this.maxTaskChars),
            status: durableStatus,
            background: run.background,
            mutating: run.mutating,
            workspaceId: run.workspaceId,
            question: run.question,
            progress,
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
            mutationReport: this.mutationReport(run),
        });
    }

    private deleteChildSession(run: AgentRun): void {
        if (!run.childSessionFile || !this.persistence) return;
        this.persistence.deleteChildSession(run.childSessionFile);
        run.childSessionFile = undefined;
    }

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

    private transitionStatus(run: AgentRun, status: AgentRunStatus): void {
        const previousStatus = run.status;
        if (previousStatus === status) return;
        run.status = status;
        this.emitRunStatusChanged(run, previousStatus, status);
    }

    private emitRunStatusChanged(
        run: AgentRun,
        previousStatus: AgentRunStatus,
        status: AgentRunStatus,
    ): void {
        emitAgentEvent(this.events, run.cwd, {
            type: "run",
            action: "status_changed",
            parentCwd: run.parentCwd,
            runId: run.id,
            status,
            previousStatus,
            workspaceId: run.workspaceId,
        });
    }

    private emitRunEvent(run: AgentRun, event: Extract<AgentEventPayload, { type: "run" }>): void {
        emitAgentEvent(this.events, run.cwd, { ...event, parentCwd: run.parentCwd });
    }

    private record(run: AgentRun, type: string, data?: AgentTraceData): void {
        this.trace?.record(run.id, type, data);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
