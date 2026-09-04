import type { Usage } from "@earendil-works/pi-ai";

import {
    AgentContinuationLeaseBusyError,
    isAgentTerminalStatus,
    type AgentBackgroundCallback,
    type AgentContinuationLease,
    type AgentRunOutcome,
    type AgentRunStatus,
    type AgentWorkspaceCheckpointCallback,
    type ChildAgentFactoryContext,
    type ChildAgentHandle,
    type ChildProgress,
    type ParentQuestion,
} from "../contracts/runs";
import type { AgentDefinition } from "../definitions/types";
import type { WorkerMutationReport } from "../contracts/mutations";

export type AgentStartContext = Omit<
    ChildAgentFactoryContext,
    "definition" | "background" | "onProgress" | "onTrace"
>;

/**
 * Mutable state of one delegated run, owned by the lifecycle manager.
 *
 * Fields fall into four groups: identity and definition (stable after creation), the child handle
 * (created by setup, cleared by dispose), asynchronous work handles (each with exactly one owner,
 * see below), and restored state (what a checkpoint knew when this process had no child).
 */
export interface AgentRun {
    id: string;
    /** Physical identity; stable across revisions while `id` may be reused, and lease-scoped. */
    runInstanceId: string;
    title: string;
    agent: string;
    agentSource: string;
    agentFilePath?: string;
    /** Snapshot taken at creation, so later definition drift cannot change a live run's rules. */
    definition?: AgentDefinition;
    task: string;
    /** Task with runtime context rendered in; this is the first prompt actually sent to the child. */
    initialPrompt?: string;
    status: AgentRunStatus;
    background: boolean;
    /** Live child session, or `undefined` after dispose and while setup is pending. */
    handle?: ChildAgentHandle;
    /** Pending setup, kept only so shutdown can wait for a child still being created. */
    setup?: Promise<ChildAgentHandle>;
    /** Set while the run is parked on `ask_parent` guidance. */
    question?: ParentQuestion;
    /** Cumulative usage baseline for the parent-visible delta of the next reported outcome. */
    usageCheckpoint: Usage;
    /** Last usage read from the child, kept for display and checkpoints when no handle is live. */
    usageSnapshot: Usage;
    startedAt: number;
    updatedAt: number;
    cwd: string;
    parentCwd: string;
    disposed: boolean;
    /** Set during parent shutdown; setup and operation paths settle the run as interrupted. */
    shutdownRequested: boolean;
    /** Set by `cancel`; wins over abort and lease loss when several interruptions race. */
    cancelRequested: boolean;
    mutating: boolean;
    /** True when the child could not be created or reopened, which blocks workspace reuse. */
    setupFailed?: boolean;
    workspaceId?: string;
    workspaceResultId?: string;
    definitionFingerprint: string;
    /** Latest progress reported an approval wait, projected as `waiting_for_permission`. */
    permissionPending: boolean;
    childSessionFile?: string;
    childSessionLeafId?: string | null;
    resumable?: boolean;
    readOnlyReason?: string;
    /** Progress from the last checkpoint or finalization, used while no child handle is live. */
    restoredProgress?: ChildProgress;
    /** Mutation facts known at the last checkpoint, merged with the live handle's report. */
    restoredMutationReport?: WorkerMutationReport;
    /** Driving promise of the current operation; cleared once it settles. */
    operation?: Promise<AgentRunOutcome>;
    /**
     * Promise for the current operation, published before the driving promise exists so `cancel`
     * always has something to await.
     */
    operationSettled?: Promise<AgentRunOutcome>;
    /** Background task that keeps running after its action returned; cleared once settled. */
    backgroundTask?: Promise<AgentRunOutcome>;
    /** Callback that receives progress for a run the parent is not blocking on. */
    backgroundCallback?: AgentBackgroundCallback;
    /** Background callback supplied with the current foreground operation, for later detach. */
    onBackgroundUpdate?: AgentBackgroundCallback;
    /** True only while a foreground operation can still be moved to the background. */
    detachable?: boolean;
    /** Resolved by `moveForegroundToBackground` to release the awaiting foreground caller. */
    detachedOutcome?: Promise<AgentRunOutcome>;
    /** Resolve hook for `detachedOutcome`, cleared as soon as it is used. */
    resolveDetachedOutcome?: (outcome: AgentRunOutcome) => void;
    /** Continuation ownership held by this process for the run's instance ID. */
    continuationLease?: AgentContinuationLease;
    /** Another parent took the lease; stop writing and settle the run as interrupted. */
    continuationLeaseLost?: boolean;
    /** Settled terminal result, retained for `collect` on background runs. */
    terminalOutcome?: AgentRunOutcome;
    /** In-flight finalization, so concurrent terminal paths await one settlement instead of two. */
    terminalCompletion?: Promise<AgentRunOutcome>;
    /** Workspace checkpoint sink installed by the action that owns this run's workspaces. */
    workspaceCheckpoint?: AgentWorkspaceCheckpointCallback;
    /** Shared abort promise, created once so repeated abort requests do not stack. */
    abortPromise?: Promise<void>;
}

/** Definition resolution and capability facts recorded before a restored run is admitted. */
export interface RestorePreparation {
    definition?: AgentDefinition;
    currentDefinition?: AgentDefinition;
    persistedTerminal: boolean;
    snapshotMutating: boolean;
}

export class AgentActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentActionError";
    }
}

export const BACKGROUND_AGENT_WAIT_GUIDANCE =
    "Progress and the final result will be delivered asynchronously. Do not duplicate the same investigation in the parent unless you intentionally want overlapping work. If you have no other work to do, report your current progress to the user and end your turn. Do not sleep or poll; an automatic notification will arrive when the run finishes or needs parent guidance.";

export const INTERRUPTED_RESUME_GUIDANCE =
    "Continue from the persisted session. Inspect the current state before proceeding; do not assume interrupted tool calls completed.";

export const MAX_TASK_CHARS = 16_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_GUIDANCE_CHARS = 16_000;
export const MAX_OUTPUT_CHARS = 32_000;
/** Overall budget for waiting out a lease another manager still holds. */
export const CONTINUATION_LEASE_RECOVERY_TIMEOUT_MS = 35_000;
/** Slack added to a busy lease's advertised reclaim time, so clock skew cannot lose a retry. */
export const CONTINUATION_LEASE_RECOVERY_GRACE_MS = 250;

export function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Neutral progress snapshot for a child that has not reported anything yet. */
export function emptyProgress(): ChildProgress {
    return { output: "", recentActivity: [] };
}

export function deriveAgentTitle(task: string, requestedTitle?: string): string {
    const requested = requestedTitle?.replace(/\s+/g, " ").trim();
    if (requested) return truncate(requested, MAX_TITLE_CHARS);
    const firstLine =
        task
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? "Delegated task";
    return truncate(firstLine.replace(/^(?:[-*#>]\s*)+/, ""), MAX_TITLE_CHARS);
}

/**
 * Lifecycle flags every run starts with, whether freshly created or restored from a checkpoint.
 *
 * Restoring never inherits in-process flags from a persisted record: disposal, shutdown, cancel,
 * and permission-pending are properties of the live run only.
 */
export const RUN_DEFAULT_FLAGS = {
    disposed: false,
    shutdownRequested: false,
    cancelRequested: false,
    permissionPending: false,
} as const;

/** Count runs that have not reached a terminal status; used for active-run limits. */
export function countActiveRuns(runs: Iterable<AgentRun>): number {
    let active = 0;
    for (const run of runs) {
        if (!isAgentTerminalStatus(run.status)) {
            active += 1;
        }
    }
    return active;
}

export function continuationLeaseRetryAt(error: unknown): number | undefined {
    if (!(error instanceof AgentContinuationLeaseBusyError)) return undefined;
    return error.leaseUntil;
}

export function mutationRunsConflict(
    candidateWorkspaceId: string | undefined,
    activeWorkspaceId: string | undefined,
): boolean {
    // Same-checkout workers share the parent's files and remain single-flight.
    // Isolated workers have separate worktrees and may mutate concurrently.
    return (
        candidateWorkspaceId === undefined ||
        activeWorkspaceId === undefined ||
        candidateWorkspaceId === activeWorkspaceId
    );
}
