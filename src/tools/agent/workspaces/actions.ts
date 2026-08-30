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
import { getAgentWorkspace, getAgentWorkspaceResult, getAgentWorkspaceResultById } from "./store";

export type WorkspaceActionRequest = (
    | {
          action: "apply";
          workspace: AgentWorkspace;
          ownerSessionId: string;
          runId: string;
          runInstanceId?: string;
      }
    | {
          action: "retain";
          workspace: AgentWorkspace;
          ownerSessionId: string;
          runId: string;
          runInstanceId?: string;
      }
    | {
          action: "reset";
          workspace: AgentWorkspace;
          ownerSessionId?: string;
          runId?: string;
          runInstanceId?: string;
      }
    | {
          action: "discard_result";
          workspace: AgentWorkspace;
          ownerSessionId: string;
          runId: string;
          runInstanceId?: string;
      }
    | {
          action: "discard_workspace";
          workspace: AgentWorkspace;
          ownerSessionId?: string;
          runId?: string;
          runInstanceId?: string;
          allowStaleLeaseWithoutResult?: boolean;
      }
    | { action: "recover"; workspace: AgentWorkspace; ownerSessionId: string }
    | { action: "release"; workspace: AgentWorkspace }
) & { workspacesDir?: string; resultId?: string };

export type WorkspaceActionEffect =
    "lease_changed" | "result_changed" | "workspace_updated" | "workspace_removed";

export interface WorkspaceActionResult {
    workspace: AgentWorkspace | null;
    result?: AgentWorkspaceResult;
    effects: WorkspaceActionEffect[];
    disposition:
        | "applied"
        | "retained"
        | "reset"
        | "discarded_result"
        | "discarded_workspace"
        | "recovered"
        | "released";
}

async function requirePreparedResult(
    workspace: AgentWorkspace,
    { leaseRunId, leaseRunInstanceId, workspacesDir, resultId }: AgentWorkspaceLeaseOptions,
    allowApplying = false,
): Promise<AgentWorkspaceResult> {
    const result = resultId
        ? await getAgentWorkspaceResultById(resultId, { workspacesDir })
        : await getAgentWorkspaceResult(workspace.id, leaseRunId, leaseRunInstanceId, {
              workspacesDir,
          });
    if (
        !result ||
        result.workspaceId !== workspace.id ||
        result.runId !== leaseRunId ||
        (leaseRunInstanceId !== undefined && result.runInstanceId !== leaseRunInstanceId) ||
        (result.status !== "prepared" && !(allowApplying && result.status === "applying"))
    ) {
        throw new Error(`Workspace ${workspace.id} has no prepared result for run ${leaseRunId}.`);
    }
    return result;
}

async function refreshed(
    workspace: AgentWorkspace,
    workspacesDir?: string,
): Promise<AgentWorkspace> {
    return (await getAgentWorkspace(workspace.id, { workspacesDir })) ?? workspace;
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
                resultId: request.resultId,
            };
            const prepared = await requirePreparedResult(workspace, leaseOptions, true);
            const result = await applyAgentWorkspaceApplication(workspace, {
                ...leaseOptions,
                resultId: prepared.id,
            });
            const ownsCurrentLease =
                workspace.leaseOwnerSessionId === request.ownerSessionId &&
                workspace.leaseRunId === request.runId &&
                workspace.leaseRunInstanceId === request.runInstanceId &&
                workspace.leaseKind === "task";
            if (ownsCurrentLease) {
                await releaseAgentWorkspaceAfterApplication(workspace.id, {
                    ...leaseOptions,
                    resultId: prepared.id,
                });
            }
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
                resultId: request.resultId,
            };
            const prepared = await requirePreparedResult(workspace, leaseOptions);
            await retainAgentWorkspaceResult(workspace.id, {
                ...leaseOptions,
                resultId: prepared.id,
            });
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
                    resultId: request.resultId,
                };
                const prepared = await requirePreparedResult(workspace, leaseOptions);
                await discardAgentWorkspaceResult(workspace.id, {
                    ...leaseOptions,
                    resultId: prepared.id,
                });
                return {
                    workspace: await refreshed(workspace, workspacesDir),
                    result: prepared,
                    effects: ["result_changed", "lease_changed", "workspace_updated"],
                    disposition: "discarded_result",
                };
            }
            const result = await getAgentWorkspaceResult(
                workspace.id,
                request.runId,
                request.runInstanceId,
                { workspacesDir },
            );
            if (!result) {
                throw new Error(
                    `Workspace ${workspace.id} has no result for run ${request.runId} to discard.`,
                );
            }
            await discardAgentWorkspaceResult(workspace.id, {
                ownerSessionId: request.ownerSessionId,
                leaseRunId: request.runId,
                leaseRunInstanceId: request.runInstanceId,
                workspacesDir,
                resultId: result.id,
            });
            return {
                workspace: await refreshed(workspace, workspacesDir),
                result,
                effects: ["result_changed", "workspace_updated"],
                disposition: "discarded_result",
            };
        }
        case "discard_workspace": {
            if (
                workspace.leaseRunId &&
                !workspace.latestResult &&
                request.allowStaleLeaseWithoutResult
            ) {
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
            const released = await releaseAgentWorkspaceLeaseForRecovery(workspace.id, {
                workspacesDir,
            });
            return {
                workspace: released,
                effects: ["lease_changed", "workspace_updated"],
                disposition: "released",
            };
        }
    }
}
