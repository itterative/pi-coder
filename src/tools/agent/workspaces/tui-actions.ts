import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentWorkspace, AgentWorkspaceAction } from "../contracts/workspaces";
import type { AgentRunManager } from "../runs/manager";
import { executeWorkspaceAction } from "./actions";

export async function handleWorkspaceAction(
    workspace: AgentWorkspace,
    requestedAction: Exclude<AgentWorkspaceAction, "inspect"> | undefined,
    ctx: ExtensionCommandContext,
    manager: AgentRunManager,
): Promise<AgentWorkspace | null | undefined> {
    if (!requestedAction) return workspace;
    const action = requestedAction;
    try {
        const sessionId = ctx.sessionManager.getSessionId();
        const leaseRunId = workspace.leaseRunId;
        const activeLeaseRun = workspace.leaseRunId
            ? manager
                  .listRuns()
                  .find(
                      (run) =>
                          run.runId === workspace.leaseRunId &&
                          (workspace.leaseRunInstanceId === undefined ||
                              run.runInstanceId === workspace.leaseRunInstanceId) &&
                          !["completed", "failed", "aborted", "canceled"].includes(run.status),
                  )
            : undefined;
        if (activeLeaseRun && action !== "apply" && action !== "retain") {
            throw new Error(
                `Workspace ${workspace.slug} is still used by active run ${activeLeaseRun.runId}; finish or cancel that run first.`,
            );
        }
        if (action === "apply") {
            if (!leaseRunId) throw new Error("The workspace result is not currently leased.");
            const result = await executeWorkspaceAction({
                action: "apply",
                workspace,
                ownerSessionId: sessionId,
                runId: leaseRunId,
                runInstanceId: workspace.leaseRunInstanceId,
            });
            ctx.ui.notify(`Applied and released workspace ${workspace.slug}.`, "info");
            return result.workspace;
        }
        if (action === "retain") {
            if (!leaseRunId) throw new Error("The workspace result is not currently leased.");
            const result = await executeWorkspaceAction({
                action: "retain",
                workspace,
                ownerSessionId: sessionId,
                runId: leaseRunId,
                runInstanceId: workspace.leaseRunInstanceId,
            });
            ctx.ui.notify(`Retained workspace ${workspace.slug} for review.`, "info");
            return result.workspace;
        }
        if (action === "reset") {
            const result = await executeWorkspaceAction({
                action: "reset",
                workspace,
                ownerSessionId: sessionId,
                runId: leaseRunId,
                runInstanceId: workspace.leaseRunInstanceId,
            });
            ctx.ui.notify(`Reset workspace ${workspace.slug}; it is reusable.`, "info");
            return result.workspace;
        }
        if (action === "recover") {
            const result = await executeWorkspaceAction({
                action: "recover",
                workspace,
                ownerSessionId: sessionId,
            });
            ctx.ui.notify(`Recovered the orphaned lease for workspace ${workspace.slug}.`, "info");
            return result.workspace;
        }
        if (action === "release") {
            const result = await executeWorkspaceAction({ action: "release", workspace });
            ctx.ui.notify(`Released the stale lease for workspace ${workspace.slug}.`, "info");
            return result.workspace;
        }
        const result = await executeWorkspaceAction({
            action: "discard_workspace",
            workspace,
            ownerSessionId: sessionId,
            runId: leaseRunId,
            runInstanceId: workspace.leaseRunInstanceId,
            allowStaleLeaseWithoutResult:
                workspace.leaseRunId !== undefined && !workspace.latestResult,
        });
        ctx.ui.notify(`Discarded workspace ${workspace.slug}.`, "info");
        return result.workspace;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Workspace ${workspace.slug}: ${message}`, "warning");
        return workspace;
    }
}
