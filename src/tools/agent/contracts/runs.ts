import type { Usage } from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";

import type { AgentContext } from "./context";
import type { AgentDefinition } from "../definitions/types";
import type { WorkerMutationReport } from "./mutations";
import type { AgentTraceData } from "./trace";
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
    permissionPending?: boolean;
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
    workspaceId?: string;
    repairInterrupted?: boolean;
    initialProgress?: ChildProgress;
    initialMutationReport?: WorkerMutationReport;
    onSessionCreated?: (sessionFile: string | undefined) => void;
}

export type ChildAgentFactory = (
    context: ChildAgentFactoryContext,
) => Promise<ChildAgentHandle>;

export interface AgentRunDetails {
    runId: string;
    title: string;
    agent: string;
    agentSource?: string;
    agentFilePath?: string;
    status: AgentRunStatus;
    background?: boolean;
    task: string;
    output?: string;
    question?: ParentQuestion;
    recentActivity: string[];
    phase?: string;
    lastAssistantMessage?: string;
    lastToolActivity?: string;
    toolCounts?: Record<string, number>;
    usage: Usage;
    startedAt: number;
    updatedAt: number;
    error?: string;
    discoveryDiagnostics?: string[];
    workspaceId?: string;
    workspaceResult?: AgentWorkspaceResult;
    mutating?: boolean;
    mutationReport?: WorkerMutationReport;
}

export interface AgentRunOutcome {
    content: string;
    details: AgentRunDetails;
    usage: Usage;
    isError: boolean;
}

export type AgentProgressCallback = (details: AgentRunDetails) => void;
export type AgentBackgroundCallback = (details: AgentRunDetails) => void;

export interface PersistedAgentRun {
    version: 1;
    ownerSessionId: string;
    runId: string;
    /** Optional for backward compatibility with pre-title journals. */
    title?: string;
    agent: string;
    agentSource: string;
    agentFilePath?: string;
    definitionFingerprint: string;
    task: string;
    status: Exclude<AgentRunStatus, "waiting_for_permission"> | "removed";
    background: boolean;
    mutating: boolean;
    workspaceId?: string;
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
    terminalContent?: string;
    terminalError?: string;
    terminalIsError?: boolean;
    mutationReport?: WorkerMutationReport;
}

export interface AgentRunPersistence {
    ownerSessionId: string;
    childSessionDir: string;
    save(record: PersistedAgentRun): boolean;
    flush?: () => Promise<void>;
    deleteChildSession(sessionFile: string): void;
}

export interface AgentRunSummary {
    runId: string;
    title: string;
    agent: string;
    status: AgentRunStatus;
    background: boolean;
    task: string;
    startedAt: number;
    updatedAt: number;
    sessionFile?: string;
    activity?: string;
    phase?: string;
    lastAssistantMessage?: string;
    lastToolActivity?: string;
    toolCounts?: Record<string, number>;
    responsePreview?: string;
    question?: string;
    usage: Usage;
    mutationReport?: WorkerMutationReport;
    mutating?: boolean;
    workspaceId?: string;
}
