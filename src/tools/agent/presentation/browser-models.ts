import type { Usage } from "@earendil-works/pi-ai";

import type {
    AgentWorkspace,
    AgentWorkspaceAction,
    AgentWorkspaceGitState,
} from "../contracts/workspaces";

export type { AgentWorkspaceAction } from "../contracts/workspaces";

export interface AgentSessionBrowserItem {
    kind: "current" | "past" | "empty";
    id: string;
    title: string;
    agent: string;
    status: string;
    task: string;
    startedAt?: number;
    updatedAt: number;
    sessionFile?: string;
    childSessionLeafId?: string | null;
    parentSessionId?: string;
    messageCount?: number;
    firstMessage?: string;
    allMessagesText?: string;
    transcript?: string;
    transcriptCollapsed?: string;
    activity?: string;
    responsePreview?: string;
    mutating?: boolean;
    usage?: Usage;
    changedFiles?: string[];
    readFiles?: string[];
    readOnlyReason?: string;
}

export type WorkspaceDispositionAction = Exclude<AgentWorkspaceAction, "inspect">;

export interface AgentWorkspaceBrowserAction {
    action: AgentWorkspaceAction;
    key: string;
    label: string;
}

export interface AgentWorkspaceGitView {
    kind: "available" | "unavailable";
    dirty: boolean;
    changedFiles?: number;
    stagedFiles?: number;
    unstagedFiles?: number;
    untrackedFiles?: number;
    headRevision?: string;
    error?: string;
    text: string;
}

export interface AgentWorkspaceBrowserItem {
    kind: "workspace";
    id: string;
    slug: string;
    cwd: string;
    repositoryRoot: string;
    worktreePath: string;
    baseRevision: string;
    status: "available" | "review_required";
    statusText: string;
    setupText: string;
    setupSummary?: string;
    leaseRunId?: string;
    leaseRunInstanceId?: string;
    leaseOwnerSessionId?: string;
    leaseAcquiredAt?: number;
    leaseText: string;
    leased: boolean;
    createdAt: number;
    updatedAt: number;
    git?: AgentWorkspaceGitView;
    actions: AgentWorkspaceBrowserAction[];
    notice: string;
}

function gitText(gitState: AgentWorkspaceGitState | undefined): string {
    if (!gitState) return "unknown";
    if (gitState.kind === "unavailable") {
        return `unavailable · ${gitState.error ?? "not a Git worktree"}`;
    }
    if (!gitState.dirty) return "clean";
    const files = gitState.changedFiles ?? 0;
    return `dirty · ${files} changed file${files === 1 ? "" : "s"}`;
}

function workspaceActions(
    workspace: AgentWorkspace,
    currentSessionId?: string,
): AgentWorkspaceBrowserAction[] {
    const actions: AgentWorkspaceBrowserAction[] = [];
    const ownedByAnotherSession = currentSessionId !== undefined
        && workspace.leaseOwnerSessionId !== undefined
        && workspace.leaseOwnerSessionId !== currentSessionId;
    const orphanedByAnotherSession = workspace.leaseState === "orphaned" && ownedByAnotherSession;
    if (orphanedByAnotherSession) {
        actions.push({ action: "recover", key: "x", label: "recover orphaned lease" });
    }
    if (workspace.latestResult && workspace.latestResult.status !== "discarded") {
        actions.push({ action: "inspect", key: "i", label: "inspect changes" });
    }
    if (ownedByAnotherSession) return actions;

    const currentResult = workspace.leaseRunId
        && workspace.latestResult?.runId === workspace.leaseRunId
        ? workspace.latestResult
        : undefined;
    const changed = Boolean(
        currentResult?.status === "prepared"
        && (
            currentResult.workerHead !== currentResult.baseRevision
            || currentResult.commits.length > 0
        )
    );
    if (changed) {
        actions.push(
            { action: "apply", key: "a", label: "apply" },
            { action: "retain", key: "t", label: "retain" },
        );
    }
    if (!workspace.leaseKind || workspace.leaseKind === "task") {
        if (workspace.leaseRunId && !currentResult) {
            actions.push(
                { action: "release", key: "l", label: "release stale lease" },
                { action: "discard", key: "d", label: "discard" },
            );
        } else if (!workspace.leaseRunId || workspace.latestResult) {
            actions.push(
                { action: "reset", key: "r", label: "reset" },
                { action: "discard", key: "d", label: "discard" },
            );
        }
    }
    return actions;
}

function workspaceNotice(workspace: AgentWorkspace, currentSessionId?: string): string {
    const ownedByAnotherSession = currentSessionId !== undefined
        && workspace.leaseOwnerSessionId !== undefined
        && workspace.leaseOwnerSessionId !== currentSessionId;
    if (workspace.leaseState === "orphaned" && ownedByAnotherSession) {
        return "The recorded run is no longer present in the durable run catalog. The lease and result remain protected until explicit recovery.";
    }
    if (workspace.leaseState === "orphaned") {
        return "The recorded run is no longer present in the durable run catalog, but this session has recovered control of the lease.";
    }
    if (ownedByAnotherSession) {
        return "This workspace is leased by another parent session and remains protected until that session dispositions its run.";
    }
    if (workspace.leaseRunId) {
        return "This workspace is leased and cannot be selected until its current run is explicitly dispositioned.";
    }
    if (workspace.status === "review_required") {
        return "This workspace requires explicit review before it can be reused.";
    }
    return "This workspace may be selected for an isolated worker.";
}

export function workspaceBrowserItem(
    workspace: AgentWorkspace,
    gitState?: AgentWorkspaceGitState,
    currentSessionId?: string,
): AgentWorkspaceBrowserItem {
    const leaseKind = workspace.leaseKind ?? "unknown";
    const orphaned = workspace.leaseState === "orphaned" ? " · orphaned" : "";
    return {
        kind: "workspace",
        id: workspace.id,
        slug: workspace.slug,
        cwd: workspace.cwd,
        repositoryRoot: workspace.repositoryRoot,
        worktreePath: workspace.worktreePath,
        baseRevision: workspace.baseRevision,
        status: workspace.status,
        statusText: workspace.leaseState === "orphaned"
            ? "orphaned lease"
            : workspace.leaseRunId
                ? "leased"
                : workspace.status.replaceAll("_", " "),
        setupText: workspace.setupState.replaceAll("_", " "),
        setupSummary: workspace.setupSummary,
        leaseRunId: workspace.leaseRunId,
        leaseRunInstanceId: workspace.leaseRunInstanceId,
        leaseOwnerSessionId: workspace.leaseOwnerSessionId,
        leaseAcquiredAt: workspace.leaseAcquiredAt,
        leaseText: workspace.leaseRunId
            ? `${leaseKind} · ${workspace.leaseRunId}${orphaned}`
            : "none",
        leased: Boolean(workspace.leaseRunId),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        git: gitState ? {
            ...gitState,
            dirty: gitState.dirty ?? false,
            text: gitText(gitState),
        } : undefined,
        actions: workspaceActions(workspace, currentSessionId),
        notice: workspaceNotice(workspace, currentSessionId),
    };
}
