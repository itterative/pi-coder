import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emitAgentEvent } from "./observability/events";
import type { AgentParameters } from "./definitions/prompt";
import { validateAgentParameters } from "./definitions/validate";
import {
    AgentActionError,
    type AgentRunDetails,
    type AgentRunIdentity,
    type AgentRunOutcome,
} from "./runs/manager";
import { diagnosticText } from "./presentation/text";
import { failedOutcome, listOutcome } from "./presentation/outcomes";
import { unusedAgentContextWarning } from "./prompts/renderer";
import {
    prepareIsolatedWorkspace,
    type WorkspaceReservation,
} from "./workspaces/setup";
import { releaseAgentWorkspaceAfterNoChanges } from "./workspaces/results";
import { createAgentWorkspaceCheckpointCallback } from "./workspaces/checkpoints";
import {
    listAgentWorkspaces,
    releaseAgentWorkspaceLease,
    transferAgentWorkspaceLease,
} from "./workspaces/store";
import { executeParentWorkspaceAction } from "./workspaces/parent-actions";
import {
    prepareCollectedWorkspaceResult,
    prepareForegroundWorkspaceResult,
} from "./workspaces/finalization";
import agentConfig, { maxWorkspacesPerRepo } from "./config";
import type { AgentLifecycle } from "./lifecycle";
import type { AgentWorkspace } from "./contracts/workspaces";

/** Named controls and dependencies for dispatching a validated agent action. */
export interface ExecuteAgentActionOptions {
    signal?: AbortSignal;
    progress: (details: AgentRunDetails) => void;
    ctx: ExtensionContext;
    lifecycle: AgentLifecycle;
}

export async function executeAgentAction(
    params: AgentParameters,
    {
        signal,
        progress,
        ctx,
        lifecycle,
    }: ExecuteAgentActionOptions,
): Promise<AgentRunOutcome> {
    let outcome: AgentRunOutcome;
    let reservation: WorkspaceReservation | undefined;
    let transferredLeaseIdentity: AgentRunIdentity | undefined;
    let startCompleted = false;
    const ownerSessionId = ctx.sessionManager?.getSessionId?.();
    const workspaceCheckpoint = ownerSessionId
        ? createAgentWorkspaceCheckpointCallback(ownerSessionId)
        : undefined;
    try {
        const request = validateAgentParameters(params);
        if (request.action === "list") {
            let workspaces: AgentWorkspace[] = [];
            let catalogWarning: string | undefined;
            try {
                workspaces = await listAgentWorkspaces(ctx.cwd, { includeMissingWorktrees: true });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                catalogWarning = `Could not read isolated workspace catalog: ${message}`;
                ctx.ui.notify(catalogWarning, "warning");
            }
            outcome = listOutcome(lifecycle.manager, workspaces);
            if (catalogWarning) outcome.content += `\n\nWarning: ${catalogWarning}`;
        } else if (request.action === "start") {
            const discovered = lifecycle.discover(ctx);
            const definition = discovered.agents.find((agent) => agent.name === request.agent);
            if (!definition) {
                throw new AgentActionError(`Unknown agent: ${request.agent}`);
            }
            if (definition.name === "advisor" && !definition.model) {
                throw new AgentActionError(
                    "The advisor is enabled but has no model configured. Select an advisor model in /agents first.",
                );
            }
            const contextWarning = unusedAgentContextWarning(
                definition.name,
                request.context,
                definition.contextPolicy,
            );
            reservation = request.isolation === "worktree"
                ? await prepareIsolatedWorkspace(
                    ctx.cwd,
                    {
                        definition,
                        factory: lifecycle.factory,
                        manager: lifecycle.manager,
                        ctx,
                        signal,
                        onUiUpdate: (runId, workspace, update) => lifecycle.updateSetupRun(ctx, runId, workspace, update),
                        events: lifecycle.events,
                        dialogEvents: lifecycle.eventBus,
                        maxWorkspaces: maxWorkspacesPerRepo(agentConfig.get(ctx.cwd)),
                    },
                )
                : undefined;
            const runContext = {
                cwd: reservation?.workspace.worktreePath ?? ctx.cwd,
                parentCwd: ctx.cwd,
                workspaceId: reservation?.workspace.id,
                isolated: reservation !== undefined,
                parentContext: ctx,
                agentContext: request.context,
            };
            const background = lifecycle.backgroundUpdate(ctx);
            const workspaceBackground = (details: AgentRunDetails) => {
                background(details);
            };
            const runIdentity = reservation
                ? lifecycle.manager.reserveRunIdentity(definition, request.task, runContext)
                : undefined;
            if (reservation && runIdentity) {
                await transferAgentWorkspaceLease(reservation.workspace.id, {
                    ownerSessionId: reservation.ownerSessionId,
                    fromLeaseRunId: reservation.provisionalLeaseRunId,
                    toLeaseRunId: runIdentity.runId,
                    leaseKind: "task",
                    fromLeaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
                    toLeaseRunInstanceId: runIdentity.runInstanceId,
                });
                transferredLeaseIdentity = runIdentity;
                lifecycle.emitWorkspaceEvent(
                    ctx,
                    reservation.workspace.id,
                    "lease_changed",
                    "transferred",
                );
            }
            outcome = await lifecycle.manager.start(
                definition,
                request.task,
                runContext,
                {
                    signal,
                    onProgress: progress,
                    onBackgroundUpdate: workspaceBackground,
                    title: request.title,
                    identity: runIdentity,
                    background: request.background,
                    ...(request.isolation === "worktree" && workspaceCheckpoint
                        ? { onWorkspaceCheckpoint: workspaceCheckpoint }
                        : {}),
                },
            );
            startCompleted = true;
            if (!request.background) {
                outcome = await prepareForegroundWorkspaceResult(outcome, ctx, lifecycle.events);
            }
            lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
            outcome.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
            if (contextWarning) {
                outcome = {
                    ...outcome,
                    additionalMetadata: [
                        ...(outcome.additionalMetadata ?? []),
                        contextWarning,
                    ],
                };
            }
        } else if (request.action === "continue") {
            const activeStatus = lifecycle.manager.getRunStatus(request.runId);
            const isTerminal = activeStatus === "completed"
                || activeStatus === "failed"
                || activeStatus === "aborted"
                || activeStatus === "canceled";
            if (activeStatus !== undefined && !isTerminal) {
                outcome = await lifecycle.manager.resume(request.runId, {
                    guidance: request.guidance,
                    signal,
                    onProgress: progress,
                    onBackgroundUpdate: lifecycle.backgroundUpdate(ctx),
                    ...(workspaceCheckpoint ? { onWorkspaceCheckpoint: workspaceCheckpoint } : {}),
                });
                outcome = await prepareForegroundWorkspaceResult(outcome, ctx, lifecycle.events);
                lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
            } else {
                outcome = await executeParentWorkspaceAction(request, {
                    ctx,
                    manager: lifecycle.manager,
                    signal,
                    progress,
                    events: lifecycle.events,
                    onBackgroundUpdate: lifecycle.backgroundUpdate(ctx),
                    discover: lifecycle.discover.bind(lifecycle),
                });
            }
        } else if (request.action === "cancel") {
            outcome = await prepareForegroundWorkspaceResult(
                await lifecycle.manager.cancel(request.runId, workspaceCheckpoint
                    ? { onWorkspaceCheckpoint: workspaceCheckpoint }
                    : {}),
                ctx,
                lifecycle.events,
            );
        } else if (
            request.action === "inspect"
            || request.action === "apply"
            || request.action === "discard"
        ) {
            outcome = await executeParentWorkspaceAction(request, {
                ctx,
                manager: lifecycle.manager,
                signal,
                progress,
                events: lifecycle.events,
                discover: lifecycle.discover.bind(lifecycle),
            });
        } else if (request.action === "status") {
            outcome = lifecycle.manager.status(request.runId);
        } else {
            const pending = lifecycle.manager.status(request.runId);
            const terminal = pending.details.status === "completed"
                || pending.details.status === "failed"
                || pending.details.status === "aborted"
                || pending.details.status === "canceled";
            if (!terminal) {
                throw new AgentActionError(
                    `Agent run ${request.runId} is ${pending.details.status}; wait for its terminal checkpoint before collecting.`,
                );
            }
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
            outcome = await lifecycle.manager.collect(request.runId);
            if (workspaceResult && noWorkspaceChanges) {
                await releaseAgentWorkspaceAfterNoChanges(workspaceResult.workspaceId, {
                    ownerSessionId: ctx.sessionManager.getSessionId(),
                    leaseRunId: workspaceResult.runId,
                    leaseRunInstanceId: workspaceResult.runInstanceId,
                });
                emitAgentEvent({
                    type: "workspace",
                    action: "lease_changed",
                    workspaceId: workspaceResult.workspaceId,
                    reason: "released_no_changes",
                }, { sink: lifecycle.events, cwd: ctx.cwd });
            }
            if (workspaceResult) {
                outcome.details.workspaceResult = workspaceResult;
            }
            lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
        }
    } catch (error) {
        if (reservation && transferredLeaseIdentity && !startCompleted) {
            await transferAgentWorkspaceLease(reservation.workspace.id, {
                ownerSessionId: reservation.ownerSessionId,
                fromLeaseRunId: transferredLeaseIdentity.runId,
                fromLeaseRunInstanceId: transferredLeaseIdentity.runInstanceId,
                toLeaseRunId: reservation.provisionalLeaseRunId,
                toLeaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
                leaseKind: "task",
            }).catch(() => {});
        }
        else if (reservation && !transferredLeaseIdentity) {
            await releaseAgentWorkspaceLease(reservation.workspace.id, {
                ownerSessionId: reservation.ownerSessionId,
                leaseRunId: reservation.provisionalLeaseRunId,
                leaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
            }).catch(() => {});
        }
        outcome = failedOutcome(params, error);
    }

    if (outcome.details.workspaceResult) {
        await lifecycle.manager.setWorkspaceResultId(
            outcome.details.runId,
            outcome.details.workspaceResult.id,
        );
    }
    return outcome;
}
