import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emitAgentEvent } from "./observability/events";
import type { AgentParameters } from "./definitions/prompt";
import {
    AgentActionError,
    type AgentRunDetails,
    type AgentRunOutcome,
} from "./runs/manager";
import { diagnosticText } from "./presentation/widget";
import { failedOutcome, listOutcome } from "./presentation/outcomes";
import {
    prepareIsolatedWorkspace,
    type WorkspaceReservation,
} from "./workspaces/setup";
import { releaseAgentWorkspaceAfterNoChanges } from "./workspaces/results";
import {
    releaseAgentWorkspaceLease,
    transferAgentWorkspaceLease,
} from "./workspaces/store";
import { executeParentWorkspaceAction } from "./workspaces/parent-actions";
import {
    prepareCollectedWorkspaceResult,
    prepareForegroundWorkspaceResult,
} from "./workspaces/finalization";
import type { AgentLifecycle } from "./lifecycle";

export async function executeAgentAction(
    params: AgentParameters,
    signal: AbortSignal | undefined,
    progress: (details: AgentRunDetails) => void,
    ctx: ExtensionContext,
    lifecycle: AgentLifecycle,
): Promise<AgentRunOutcome> {
    let outcome: AgentRunOutcome;
    let reservation: WorkspaceReservation | undefined;
    try {
        if (params.action === "list") {
            outcome = listOutcome(lifecycle.manager);
        } else if (params.action === "start" || params.action === "spawn") {
            const discovered = lifecycle.discover(ctx);
            const definition = discovered.agents.find((agent) => agent.name === params.agent);
            if (!definition) {
                throw new AgentActionError(`Unknown agent: ${params.agent}`);
            }
            reservation = params.isolation === "worktree"
                ? await prepareIsolatedWorkspace(
                    ctx.cwd,
                    definition,
                    lifecycle.factory,
                    lifecycle.manager,
                    ctx,
                    signal,
                    (runId, workspace, update) => lifecycle.updateSetupRun(ctx, runId, workspace, update),
                    lifecycle.events,
                )
                : undefined;
            const runContext = {
                cwd: reservation?.workspace.worktreePath ?? ctx.cwd,
                parentCwd: ctx.cwd,
                workspaceId: reservation?.workspace.id,
                parentContext: ctx,
            };
            const background = lifecycle.backgroundUpdate(ctx);
            const workspaceBackground = (details: AgentRunDetails) => {
                background(details);
            };
            outcome = params.action === "start"
                ? await lifecycle.manager.start(
                    definition,
                    params.task,
                    runContext,
                    signal,
                    progress,
                    params.title,
                )
                : lifecycle.manager.spawn(
                    definition,
                    params.task,
                    runContext,
                    signal,
                    workspaceBackground,
                    params.title,
                );
            if (reservation) {
                await transferAgentWorkspaceLease(
                    reservation.workspace.id,
                    reservation.ownerSessionId,
                    reservation.provisionalLeaseRunId,
                    outcome.details.runId,
                );
                lifecycle.emitWorkspaceEvent(
                    ctx,
                    reservation.workspace.id,
                    "lease_changed",
                    "transferred",
                );
            }
            if (params.action === "start") {
                outcome = await prepareForegroundWorkspaceResult(outcome, ctx, lifecycle.events);
            }
            lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
            outcome.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
        } else if (params.action === "resume") {
            outcome = await lifecycle.manager.resume(params.runId, params.guidance, signal, progress);
            outcome = await prepareForegroundWorkspaceResult(outcome, ctx, lifecycle.events);
            lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
        } else if (params.action === "cancel") {
            outcome = await prepareForegroundWorkspaceResult(
                await lifecycle.manager.cancel(params.runId),
                ctx,
                lifecycle.events,
            );
        } else if (
            params.action === "inspect"
            || params.action === "apply"
            || params.action === "discard"
            || params.action === "revise"
        ) {
            outcome = await executeParentWorkspaceAction(
                params,
                ctx,
                lifecycle.manager,
                signal,
                progress,
                lifecycle.events,
            );
        } else if (params.action === "status") {
            outcome = lifecycle.manager.status(params.runId);
        } else {
            const pending = lifecycle.manager.status(params.runId);
            const workspaceResult = await prepareCollectedWorkspaceResult(
                pending.details,
                ctx,
                lifecycle.events,
            );
            const noWorkspaceChanges = workspaceResult
                ? workspaceResult.workerHead === workspaceResult.baseRevision
                    && workspaceResult.commits.length === 0
                : false;
            // Keep a no-change lease held until the retained agent result has
            // actually been consumed. If collect rejects, the caller must be
            // able to retry and the lease must remain protected.
            outcome = lifecycle.manager.collect(params.runId);
            if (workspaceResult && noWorkspaceChanges) {
                await releaseAgentWorkspaceAfterNoChanges(
                    workspaceResult.workspaceId,
                    ctx.sessionManager.getSessionId(),
                    workspaceResult.runId,
                );
                emitAgentEvent(lifecycle.events, ctx.cwd, {
                    type: "workspace",
                    action: "lease_changed",
                    workspaceId: workspaceResult.workspaceId,
                    reason: "released_no_changes",
                });
            }
            if (workspaceResult) {
                outcome.details.workspaceResult = workspaceResult;
            }
            lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
        }
    } catch (error) {
        if (reservation) {
            await releaseAgentWorkspaceLease(
                reservation.workspace.id,
                reservation.ownerSessionId,
                reservation.provisionalLeaseRunId,
            ).catch(() => {});
        }
        outcome = failedOutcome(params, error);
    }

    return outcome;
}
