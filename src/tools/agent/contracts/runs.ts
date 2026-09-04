import type { Usage } from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";

import type { AgentContext } from "./context";
import type { AgentDefinition } from "../definitions/types";
import type { AgentParameters } from "../definitions/prompt";
import type { WorkerMutationReport } from "./mutations";
import type { AgentTraceData } from "./trace";
import type { TodoProgress } from "../../../modules/todolist/progress";
import type { AgentWorkspaceResult } from "./workspaces";

export type AgentRunStatus =
    | "starting"
    | "running"
    | "waiting_for_permission"
    | "waiting_for_parent"
    | "interrupted"
    | "completed"
    | "failed"
    | "aborted"
    | "canceled";

export type AgentTerminalStatus = "completed" | "failed" | "aborted" | "canceled";

export function isAgentTerminalStatus(value: unknown): value is AgentTerminalStatus {
    return (
        value === "completed" || value === "failed" || value === "aborted" || value === "canceled"
    );
}

export interface ParentQuestion {
    question: string;
    context?: string;
    options?: string[];
    recommendation?: string;
}

export interface ChildProgress {
    output: string;
    lastAssistantMessage?: string;
    recentActivity: string[];
    phase?: string;
    lastToolActivity?: string;
    toolCounts?: Record<string, number>;
    failedToolCalls?: number;
    permissionPending?: boolean;
    /** Volatile TODO summary; intentionally excluded from durable snapshots. */
    todo?: TodoProgress;
}

export interface ChildAgentHandle {
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    takeParentQuestion(): ParentQuestion | undefined;
    getProgress(): ChildProgress;
    getFinalOutput(): string;
    getError(): string | undefined;
    getUsage(): Usage;
    getMutationReport?(): WorkerMutationReport;
    /** The exact append-only transcript leaf selected for this run. */
    getSessionLeafId?(): string | null;
    /** Repair an interrupted transcript only after explicit user resume. */
    repairInterrupted?(): number;
    sessionFile?: string;
}

export interface ChildAgentFactoryContext {
    /** Execution cwd; isolated workers use their persistent worktree here. */
    cwd: string;
    /** Parent project cwd used for browser/event scoping. */
    parentCwd?: string;
    definition: AgentDefinition;
    /** Dynamic context rendered into the initial delegated task message. */
    agentContext?: AgentContext;
    parentContext: unknown;
    events?: EventBus;
    background?: boolean;
    runId?: string;
    runTitle?: string;
    onProgress: (progress: ChildProgress) => void;
    onFileChanged?: (filePath: string) => void;
    onTrace?: (type: string, data?: AgentTraceData) => void;
    childSessionDir?: string;
    childSessionFile?: string;
    /** Exact child transcript leaf to restore; null explicitly selects root. */
    childSessionLeafId?: string | null;
    workspaceId?: string;
    /** Internal setup children are isolated even before a task lease exists. */
    isolated?: boolean;
    /**
     * Timeout for a Bash call that did not request one, used by children whose commands run
     * unattended. Deliberately a run-mode fact rather than something the gate infers from the
     * agent name, and not part of the durable definition contract.
     */
    defaultBashTimeoutSeconds?: number;
    repairInterrupted?: boolean;
    initialProgress?: ChildProgress;
    initialMutationReport?: WorkerMutationReport;
    onSessionCreated?: (sessionFile: string | undefined, childSessionLeafId: string | null) => void;
}

export type ChildAgentFactory = (context: ChildAgentFactoryContext) => Promise<ChildAgentHandle>;

export interface AgentRunDetails {
    runId: string;
    /** Globally unique physical run identity. */
    runInstanceId?: string;
    title: string;
    agent: string;
    agentSource?: string;
    agentFilePath?: string;
    /**
     * The tool action this result answers. `renderAgentResult` dispatches on it, so it belongs to the
     * result contract; derived from the request schema so the two cannot drift apart.
     */
    action?: AgentParameters["action"];
    status: AgentRunStatus;
    background?: boolean;
    task: string;
    /** Unwrapped action response retained for TUI rendering. */
    response?: string;
    output?: string;
    question?: ParentQuestion;
    recentActivity: string[];
    phase?: string;
    lastAssistantMessage?: string;
    lastToolActivity?: string;
    toolCounts?: Record<string, number>;
    failedToolCalls?: number;
    todo?: TodoProgress;
    usage: Usage;
    startedAt: number;
    updatedAt: number;
    error?: string;
    /** True when the child could not be created or reopened before prompting. */
    setupFailed?: boolean;
    discoveryDiagnostics?: string[];
    workspaceId?: string;
    workspaceResultId?: string;
    childSessionLeafId?: string | null;
    workspaceResult?: AgentWorkspaceResult;
    mutating?: boolean;
    mutationReport?: WorkerMutationReport;
}

export interface AgentRunOutcome {
    content: string;
    details: AgentRunDetails;
    usage: Usage;
    /** Set when content is the delegated child response rather than a lifecycle message. */
    hasResponse?: true;
    /** Parent-generated lines to append inside the tool metadata block. */
    additionalMetadata?: string[];
    isError: boolean;
}

export type AgentProgressCallback = (details: AgentRunDetails) => void;
export type AgentBackgroundCallback = (details: AgentRunDetails) => void;

export interface PersistedAgentRun {
    version: 1;
    ownerSessionId: string;
    /** PID that last persisted this run; used only for conservative lease health checks. */
    ownerPid?: number;
    runId: string;
    /** Globally unique physical run identity. Required by V2 snapshots. */
    runInstanceId?: string;
    /** Optional for backward compatibility with pre-title journals. */
    title?: string;
    agent: string;
    agentSource: string;
    agentFilePath?: string;
    definitionFingerprint: string;
    /** Complete definition used when this run was started; absent only in legacy snapshots. */
    definitionSnapshot?: AgentDefinition;
    task: string;
    status: Exclude<AgentRunStatus, "waiting_for_permission"> | "removed";
    /** Original terminal status retained when status is the removal tombstone. */
    terminalStatus?: AgentTerminalStatus;
    background: boolean;
    mutating: boolean;
    workspaceId?: string;
    workspaceResultId?: string;
    question?: ParentQuestion;
    progress: ChildProgress;
    usageCheckpoint: Usage;
    usageSnapshot: Usage;
    startedAt: number;
    updatedAt: number;
    /** Parent project cwd; isolated runs execute in a different cwd. */
    parentCwd?: string;
    /** Execution cwd, which may be an isolated worktree. */
    cwd?: string;
    childSessionFile?: string;
    /** null means the child root; undefined is incompatible with V2 resume. */
    childSessionLeafId?: string | null;
    /** False marks an inspectable checkpoint superseded on another parent branch. */
    resumable?: boolean;
    readOnlyReason?: string;
    terminalContent?: string;
    terminalError?: string;
    terminalIsError?: boolean;
    setupFailed?: boolean;
    mutationReport?: WorkerMutationReport;
}

export interface AgentContinuationLease {
    release(): void | Promise<void>;
}

export class AgentContinuationLeaseBusyError extends Error {
    readonly leaseUntil: number;

    constructor(leaseUntil: number) {
        super("Delegated run continuation is already owned by another process.");
        this.name = "AgentContinuationLeaseBusyError";
        this.leaseUntil = leaseUntil;
    }
}

/** A delegated-run checkpoint the durable layer refused to write, together with the reason it gave. */
export interface AgentRefusedWrite {
    runId: string;
    /** Physical run identity, when the record carried one. */
    runInstanceId?: string;
    message: string;
}

/**
 * Reports every refused durable write.
 *
 * `AgentRunPersistence.save` returns only a boolean, so a caller cannot learn the reason from its own
 * result. This listener exists so diagnostics can see each cause rather than depending on the single
 * user-facing warning, which is deliberately budgeted to one notification per session.
 */
export type AgentRefusedWriteListener = (refusal: AgentRefusedWrite) => void;

export interface AgentRunPersistence {
    ownerSessionId: string;
    /** True when records are V2 marker/snapshot checkpoints. */
    usesSnapshotMarkers?: boolean;
    childSessionDir: string;
    save(record: PersistedAgentRun): Promise<boolean>;
    /** Acquires a renewable CAS lease for the physical run's active operation. */
    acquireContinuationLease?: (
        runInstanceId: string,
        onLost?: () => void,
    ) => Promise<AgentContinuationLease>;
    flush?: () => Promise<void>;
    close?: () => void | Promise<void>;
    deleteChildSession(sessionFile: string): void;
}

export interface AgentWorkspaceCheckpointRequest {
    workspaceId: string;
    runId: string;
    runInstanceId: string;
    kind: "intermediate" | "terminal";
    runStatus:
        "waiting_for_parent" | "interrupted" | "completed" | "failed" | "aborted" | "canceled";
    childSessionFile?: string;
    childSessionLeafId: string | null;
}

export type AgentWorkspaceCheckpointCallback = (
    request: AgentWorkspaceCheckpointRequest,
) => Promise<void>;

export interface AgentRunSummary {
    runId: string;
    runInstanceId?: string;
    title: string;
    agent: string;
    status: AgentRunStatus;
    background: boolean;
    task: string;
    startedAt: number;
    updatedAt: number;
    sessionFile?: string;
    childSessionLeafId?: string | null;
    /** @deprecated Use childSessionLeafId. */
    sessionLeafId?: string | null;
    readOnlyReason?: string;
    activity?: string;
    phase?: string;
    lastAssistantMessage?: string;
    lastToolActivity?: string;
    toolCounts?: Record<string, number>;
    failedToolCalls?: number;
    todo?: TodoProgress;
    responsePreview?: string;
    question?: string;
    usage: Usage;
    mutationReport?: WorkerMutationReport;
    mutating?: boolean;
    workspaceId?: string;
    /**
     * Workspace result ID recorded by `AgentRunManager.setWorkspaceResultId`.
     *
     * Exposed so a caller can correlate a run with its durable result without a second lookup; the
     * activity widget and `/agents` browser surface the workspace association, not this ID yet.
     */
    workspaceResultId?: string;
}
