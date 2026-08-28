import type { AgentWorkspace, AgentWorkspaceResult } from "../contracts/workspaces";
import type { AgentWorkspaceLeaseOptions } from "./store";
import {
    discardAgentWorkspace,
    recoverAgentWorkspaceLease,
    releaseAgentWorkspaceLeaseForRecovery,
    resetAgentWorkspaceForReuse,
} from "./lifecycle";
import {
    applyAgentWorkspaceApplication,
    discardAgentWorkspaceResult,
    releaseAgentWorkspaceAfterApplication,
    retainAgentWorkspaceResult,
} from "./results";
import { getAgentWorkspace } from "./store";

export type WorkspaceActionRequest = (
    | { action: "apply"; workspace: AgentWorkspace; ownerSessionId: string; runId: string; runInstanceId?: string }
    | { action: "retain"; workspace: AgentWorkspace; ownerSessionId: string; runId: string; runInstanceId?: string }
    | { action: "reset"; workspace: AgentWorkspace; ownerSessionId?: string; runId?: string; runInstanceId?: string }
    | { action: "discard_result"; workspace: AgentWorkspace; ownerSessionId: string; runId: string; runInstanceId?: string }
    | { action: "discard_workspace"; workspace: AgentWorkspace; ownerSessionId?: string; runId?: string; runInstanceId?: string; allowStaleLeaseWithoutResult?: boolean }
    | { action: "recover"; workspace: AgentWorkspace; ownerSessionId: string }
    | { action: "release"; workspace: AgentWorkspace }
) & { workspacesDir?: string };

export type WorkspaceActionEffect = "lease_changed" | "result_changed" | "workspace_updated" | "workspace_removed";

export interface WorkspaceActionResult {
    workspace: AgentWorkspace | null;
    result?: AgentWorkspaceResult;
    effects: WorkspaceActionEffect[];
    disposition: "applied" | "retained" | "reset" | "discarded_result" | "discarded_workspace" | "recovered" | "released";
}

function requirePreparedResult(
    workspace: AgentWorkspace,
    { ownerSessionId, leaseRunId, leaseRunInstanceId }: AgentWorkspaceLeaseOptions,
): AgentWorkspaceResult {
    if (
        workspace.leaseOwnerSessionId !== ownerSessionId
        || workspace.leaseRunId !== leaseRunId
        || (workspace.leaseRunInstanceId !== undefined && workspace.leaseRunInstanceId !== leaseRunInstanceId)
    ) {
        throw new Error(`Workspace ${workspace.id} is not currently leased by run ${leaseRunId}.`);
    }
    if (
        workspace.leaseKind !== "task"
        || !workspace.latestResult
        || workspace.latestResult.status !== "prepared"
        || workspace.latestResult.runId !== leaseRunId
        || (workspace.leaseRunInstanceId !== undefined && workspace.latestResult.runInstanceId !== leaseRunInstanceId)
    ) {
        throw new Error(`Workspace ${workspace.id} has no prepared result for run ${leaseRunId}.`);
    }
    return workspace.latestResult;
}

async function refreshed(workspace: AgentWorkspace, workspacesDir?: string): Promise<AgentWorkspace> {
    return await getAgentWorkspace(workspace.id, { workspacesDir }) ?? workspace;
}

/**
 * Executes workspace state transitions shared by parent-tool and TUI adapters.
 * Confirmation, active-run checks, notifications, and event emission remain at
 * the adapter boundary.
 */
export async function executeWorkspaceAction(
    request: WorkspaceActionRequest,
): Promise<WorkspaceActionResult> {
    const { workspace, workspacesDir } = request;
    switch (request.action) {
        case "apply": {
            const leaseOptions = {
                ownerSessionId: request.ownerSessionId,
                leaseRunId: request.runId,
                workspacesDir,
                leaseRunInstanceId: request.runInstanceId,
            };
            requirePreparedResult(workspace, leaseOptions);
            const result = await applyAgentWorkspaceApplication(workspace, leaseOptions);
            await releaseAgentWorkspaceAfterApplication(workspace.id, leaseOptions);
            return {
                workspace: await refreshed(workspace, workspacesDir),
                result,
                effects: ["result_changed", "lease_changed", "workspace_updated"],
                disposition: "applied",
            };
        }
        case "retain": {
            const leaseOptions = {
                ownerSessionId: request.ownerSessionId,
                leaseRunId: request.runId,
                workspacesDir,
                leaseRunInstanceId: request.runInstanceId,
            };
            const prepared = requirePreparedResult(workspace, leaseOptions);
            await retainAgentWorkspaceResult(workspace.id, leaseOptions);
            return {
                workspace: await refreshed(workspace, workspacesDir),
                result: prepared,
                effects: ["result_changed", "lease_changed", "workspace_updated"],
                disposition: "retained",
            };
        }
        case "reset": {
            const reset = await resetAgentWorkspaceForReuse(workspace.id, {
                ownerSessionId: request.ownerSessionId,
                leaseRunId: request.runId,
                workspacesDir,
                leaseRunInstanceId: request.runInstanceId,
            });
            return {
                workspace: reset,
                effects: ["lease_changed", "workspace_updated"],
                disposition: "reset",
            };
        }
        case "discard_result": {
            if (workspace.leaseRunId) {
                const leaseOptions = {
                    ownerSessionId: request.ownerSessionId,
                    leaseRunId: request.runId,
                    workspacesDir,
                    leaseRunInstanceId: request.runInstanceId,
                };
                const prepared = requirePreparedResult(workspace, leaseOptions);
                await discardAgentWorkspaceResult(workspace.id, leaseOptions);
                return {
                    workspace: await refreshed(workspace, workspacesDir),
                    result: prepared,
                    effects: ["result_changed", "lease_changed", "workspace_updated"],
                    disposition: "discarded_result",
                };
            }
            if (
                !workspace.latestResult
                || workspace.latestResult.runId !== request.runId
                || (workspace.latestResult.runInstanceId !== undefined && workspace.latestResult.runInstanceId !== request.runInstanceId)
            ) {
                throw new Error(`Workspace ${workspace.id} has no result for run ${request.runId} to discard.`);
            }
            const result = workspace.latestResult;
            const reset = await resetAgentWorkspaceForReuse(workspace.id, { workspacesDir });
            return {
                workspace: reset,
                result,
                effects: ["result_changed", "lease_changed", "workspace_updated"],
                disposition: "discarded_result",
            };
        }
        case "discard_workspace": {
            if (workspace.leaseRunId && !workspace.latestResult && request.allowStaleLeaseWithoutResult) {
                await discardAgentWorkspace(workspace.id, { workspacesDir });
            } else {
                await discardAgentWorkspace(workspace.id, {
                    ownerSessionId: request.ownerSessionId,
                    leaseRunId: request.runId,
                    workspacesDir,
                    leaseRunInstanceId: request.runInstanceId,
                });
            }
            return {
                workspace: null,
                effects: ["workspace_removed"],
                disposition: "discarded_workspace",
            };
        }
        case "recover": {
            const recovered = await recoverAgentWorkspaceLease(workspace.id, {
                ownerSessionId: request.ownerSessionId,
                workspacesDir,
            });
            return {
                workspace: recovered,
                effects: ["lease_changed", "workspace_updated"],
                disposition: "recovered",
            };
        }
        case "release": {
            const released = await releaseAgentWorkspaceLeaseForRecovery(workspace.id, { workspacesDir });
            return {
                workspace: released,
                effects: ["lease_changed", "workspace_updated"],
                disposition: "released",
            };
        }
    }
}
