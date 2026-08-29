import type { Usage } from "@earendil-works/pi-ai";

import type { AgentDefinition } from "../definitions/types";
import type { WorkerMutationReport } from "./mutations";
import type { AgentTerminalStatus } from "./runs";

export const WORKSPACE_VERSION = 1 as const;

export type WorkspaceSetupState = "not_started" | "running" | "ready" | "skipped" | "failed";
export type WorkspaceStatus = "available" | "review_required";
export type WorkspaceLeaseKind = "setup" | "task";
export type WorkspaceLeaseState = "none" | "setup" | "known" | "orphaned" | "unknown";
export type WorkspaceResultStatus = "prepared" | "applied" | "discarded";

export interface AgentWorkspaceResult {
    id: string;
    workspaceId: string;
    runId: string;
    runInstanceId?: string;
    baseRevision: string;
    workerHead: string;
    commitRange: string;
    commits: string[];
    durableRef?: string;
    preparedAt: number;
    status: WorkspaceResultStatus;
    parentRevision?: string;
    appliedAt?: number;
}

export interface AgentWorkspaceGitState {
    kind: "available" | "unavailable";
    dirty?: boolean;
    changedFiles?: number;
    stagedFiles?: number;
    unstagedFiles?: number;
    untrackedFiles?: number;
    headRevision?: string;
    error?: string;
}

export interface AgentWorkspace {
    version: typeof WORKSPACE_VERSION;
    id: string;
    cwd: string;
    repositoryRoot: string;
    worktreePath: string;
    slug: string;
    baseRevision: string;
    setupState: WorkspaceSetupState;
    setupSummary?: string;
    status: WorkspaceStatus;
    leaseOwnerSessionId?: string;
    leaseRunId?: string;
    leaseRunInstanceId?: string;
    leaseKind?: WorkspaceLeaseKind;
    leaseAcquiredAt?: number;
    leaseState?: WorkspaceLeaseState;
    latestResult?: AgentWorkspaceResult;
    createdAt: number;
    updatedAt: number;
}

export interface AgentRunCatalogRecord {
    ownerSessionId: string;
    runId: string;
    runInstanceId?: string;
    parentCwd: string;
    executionCwd?: string;
    title: string;
    agent: string;
    agentSource: string;
    definitionSnapshot?: AgentDefinition;
    task: string;
    status: string;
    /** Original terminal status retained when status is the removal tombstone. */
    terminalStatus?: AgentTerminalStatus;
    background: boolean;
    mutating: boolean;
    workspaceId?: string;
    childSessionFile?: string;
    childSessionLeafId?: string | null;
    latestSnapshotId?: string;
    startedAt: number;
    updatedAt: number;
    usageSnapshot: Usage;
    responsePreview?: string;
    mutationReport?: WorkerMutationReport;
}

export type AgentWorkspaceAction = "inspect" | "apply" | "retain" | "reset" | "discard" | "release" | "recover";
