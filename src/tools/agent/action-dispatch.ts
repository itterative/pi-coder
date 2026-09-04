import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emitAgentEvent } from "./observability/events";
import type { AgentParameters } from "./definitions/prompt";
import { validateAgentParameters, type AgentRequest } from "./definitions/validate";
import {
    AgentActionError,
    type AgentRunDetails,
    type AgentRunIdentity,
    type AgentRunManager,
    type AgentRunOutcome,
} from "./runs/manager";
import { isAgentTerminalStatus, type AgentWorkspaceCheckpointCallback } from "./contracts/runs";
import { diagnosticText } from "./presentation/text";
import { failedOutcome, listOutcome } from "./presentation/outcomes";
import { unusedAgentContextWarning } from "./prompts/renderer";
import { prepareIsolatedWorkspace, type WorkspaceReservation } from "./workspaces/setup";
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
import type { AgentWorkspace, AgentWorkspaceResult } from "./contracts/workspaces";

/** Named controls and dependencies for dispatching a validated agent action. */
export interface ExecuteAgentActionOptions {
    signal?: AbortSignal;
    progress: (details: AgentRunDetails) => void;
    ctx: ExtensionContext;
    lifecycle: AgentLifecycle;
}

/** Per-call dependencies shared by every action handler. */
interface ActionScope {
    ctx: ExtensionContext;
    lifecycle: AgentLifecycle;
    signal?: AbortSignal;
    progress: (details: AgentRunDetails) => void;
    /**
     * Absent when the session cannot own durable state, in which case no action may attach a
     * workspace checkpoint.
     */
    workspaceCheckpoint?: AgentWorkspaceCheckpointCallback;
}

/**
 * Workspace bookkeeping for a `start` action, which can claim a worktree and its provisional lease
 * before the manager owns the run.
 *
 * `executeAgentAction` unwinds this state when the start fails, so the fields advance with the
 * transaction rather than being recomputed from run state after a failure.
 */
interface StartTransaction {
    reservation?: WorkspaceReservation;
    /** Identity the provisional lease moved to; absent means the provisional lease is still live. */
    leasedTo?: AgentRunIdentity;
    /** Once the manager owns the run, unwinding it is the manager's job, not this dispatcher's. */
    started: boolean;
}

type DiscoveredAgents = ReturnType<AgentLifecycle["discover"]>;
type StartRunContext = Parameters<AgentRunManager["start"]>[2];
type ParentActionDeps = Omit<
    Parameters<typeof executeParentWorkspaceAction>[1],
    "onBackgroundUpdate"
>;

/**
 * Runs one parent-facing agent action and returns the outcome to show the parent.
 *
 * Ordering that lives here, and must stay here:
 *
 * 1. Parameters are validated before anything is claimed, so a rejected action cannot leave a
 *    workspace or lease behind.
 * 2. A failed `start` is unwound from `StartTransaction` only while this dispatcher still owns what
 *    it claimed; once the manager owns the run, only the manager may unwind it.
 * 3. Every exit path funnels through `failedOutcome`, so an action never throws at the tool layer.
 * 4. A collected workspace result is linked to its run last, because the linkage needs the final
 *    outcome whether the action succeeded or failed.
 */
export async function executeAgentAction(
    params: AgentParameters,
    { signal, progress, ctx, lifecycle }: ExecuteAgentActionOptions,
): Promise<AgentRunOutcome> {
    const workspaceCheckpoint = checkpointCallbackFor(ctx);
    const scope: ActionScope = { ctx, lifecycle, signal, progress, workspaceCheckpoint };
    const transaction: StartTransaction = { started: false };
    let outcome: AgentRunOutcome;
    try {
        const request = validateAgentParameters(params);
        outcome = await dispatchAction(request, scope, transaction);
    } catch (error) {
        await unwindStartTransaction(transaction);
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

/** Routes a validated request to its handler; every action has exactly one handler. */
async function dispatchAction(
    request: AgentRequest,
    scope: ActionScope,
    transaction: StartTransaction,
): Promise<AgentRunOutcome> {
    switch (request.action) {
        case "list":
            return dispatchList(scope);
        case "start":
            return dispatchStart(request, scope, transaction);
        case "continue":
            return dispatchContinue(request, scope);
        case "cancel":
            return dispatchCancel(request, scope);
        case "inspect":
        case "apply":
        case "discard":
            return executeParentWorkspaceAction(request, parentActionDeps(scope));
        case "status":
            return scope.lifecycle.manager.status(request.runId);
        case "collect":
            return dispatchCollect(request, scope);
    }
}

function checkpointCallbackFor(
    ctx: ExtensionContext,
): AgentWorkspaceCheckpointCallback | undefined {
    const ownerSessionId = ctx.sessionManager?.getSessionId?.();
    if (!ownerSessionId) {
        return undefined;
    }
    return createAgentWorkspaceCheckpointCallback(ownerSessionId);
}

/**
 * Lists live runs plus workspace blockers.
 *
 * An unreadable workspace catalog degrades the list rather than failing the action: the manager's
 * in-memory runs are still authoritative, so the warning is appended to a usable result.
 */
async function dispatchList(scope: ActionScope): Promise<AgentRunOutcome> {
    const { ctx, lifecycle } = scope;
    let workspaces: AgentWorkspace[] = [];
    let catalogWarning: string | undefined;
    try {
        workspaces = await listAgentWorkspaces(ctx.cwd, { includeMissingWorktrees: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        catalogWarning = `Could not read isolated workspace catalog: ${message}`;
        ctx.ui.notify(catalogWarning, "warning");
    }

    const outcome = listOutcome(lifecycle.manager, workspaces);
    if (catalogWarning) {
        outcome.content += `\n\nWarning: ${catalogWarning}`;
    }
    return outcome;
}

/**
 * Starts a run, optionally in a freshly reserved worktree.
 *
 * The lease must move onto the real run identity before the run exists, otherwise a crash between
 * reservation and start strands a provisional lease no run can release.
 */
async function dispatchStart(
    request: Extract<AgentRequest, { action: "start" }>,
    scope: ActionScope,
    transaction: StartTransaction,
): Promise<AgentRunOutcome> {
    const { ctx, lifecycle } = scope;
    const discovered = lifecycle.discover(ctx);
    const definition = requireStartDefinition(discovered, request);
    const contextWarning = unusedAgentContextWarning(
        definition.name,
        request.context,
        definition.contextPolicy,
    );
    transaction.reservation = await reserveWorkspace(request, definition, scope);
    const runContext = startRunContext(request, ctx, transaction.reservation);
    transaction.leasedTo = await claimWorkspaceLease(
        transaction.reservation,
        definition,
        request,
        runContext,
        scope,
    );
    const outcome = await lifecycle.manager.start(definition, request.task, runContext, {
        signal: scope.signal,
        onProgress: scope.progress,
        onBackgroundUpdate: lifecycle.backgroundUpdate(ctx),
        title: request.title,
        identity: transaction.leasedTo,
        background: request.background,
        ...(request.isolation === "worktree" && scope.workspaceCheckpoint
            ? { onWorkspaceCheckpoint: scope.workspaceCheckpoint }
            : {}),
    });
    transaction.started = true;

    return finishStartOutcome(outcome, request, scope, contextWarning, discovered);
}

/** Resolve the requested definition, or explain to the parent why it cannot run. */
function requireStartDefinition(
    discovered: DiscoveredAgents,
    request: Extract<AgentRequest, { action: "start" }>,
): DiscoveredAgents["agents"][number] {
    const definition = discovered.agents.find((agent) => agent.name === request.agent);
    if (!definition) {
        throw new AgentActionError(`Unknown agent: ${request.agent}`);
    }
    if (definition.name === "advisor" && !definition.model) {
        throw new AgentActionError(
            "The advisor is enabled but has no model configured. Select an advisor model in /agents first.",
        );
    }
    return definition;
}

async function reserveWorkspace(
    request: Extract<AgentRequest, { action: "start" }>,
    definition: DiscoveredAgents["agents"][number],
    scope: ActionScope,
): Promise<WorkspaceReservation | undefined> {
    if (request.isolation !== "worktree") {
        return undefined;
    }
    const { ctx, lifecycle } = scope;
    return prepareIsolatedWorkspace(ctx.cwd, {
        definition,
        factory: lifecycle.factory,
        manager: lifecycle.manager,
        ctx,
        signal: scope.signal,
        onUiUpdate: (runId, workspace, update) =>
            lifecycle.updateSetupRun(ctx, runId, workspace, update),
        events: lifecycle.events,
        dialogEvents: lifecycle.eventBus,
        maxWorkspaces: maxWorkspacesPerRepo(agentConfig.get(ctx.cwd)),
    });
}

function startRunContext(
    request: Extract<AgentRequest, { action: "start" }>,
    ctx: ExtensionContext,
    reservation: WorkspaceReservation | undefined,
): StartRunContext {
    return {
        cwd: reservation?.workspace.worktreePath ?? ctx.cwd,
        parentCwd: ctx.cwd,
        workspaceId: reservation?.workspace.id,
        isolated: reservation !== undefined,
        parentContext: ctx,
        agentContext: request.context,
    };
}

/**
 * Reserves the run identity and transfers the workspace lease onto it.
 *
 * Returns undefined for a same-checkout start, which claims no workspace and therefore needs no
 * transfer.
 */
async function claimWorkspaceLease(
    reservation: WorkspaceReservation | undefined,
    definition: DiscoveredAgents["agents"][number],
    request: Extract<AgentRequest, { action: "start" }>,
    runContext: StartRunContext,
    scope: ActionScope,
): Promise<AgentRunIdentity | undefined> {
    if (!reservation) {
        return undefined;
    }
    const { ctx, lifecycle } = scope;
    const identity = lifecycle.manager.reserveRunIdentity(definition, request.task, runContext);
    await transferAgentWorkspaceLease(reservation.workspace.id, {
        ownerSessionId: reservation.ownerSessionId,
        fromLeaseRunId: reservation.provisionalLeaseRunId,
        fromLeaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
        toLeaseRunId: identity.runId,
        toLeaseRunInstanceId: identity.runInstanceId,
        leaseKind: "task",
    });
    lifecycle.emitWorkspaceEvent(ctx, reservation.workspace.id, "lease_changed", "transferred");
    return identity;
}

/**
 * Applies the post-start presentation steps in their required order.
 *
 * A background start has no foreground workspace result to prepare, and discovery diagnostics are
 * attached last so they describe the run the parent is about to see.
 */
async function finishStartOutcome(
    outcome: AgentRunOutcome,
    request: Extract<AgentRequest, { action: "start" }>,
    scope: ActionScope,
    contextWarning: string | undefined,
    discovered: DiscoveredAgents,
): Promise<AgentRunOutcome> {
    const { ctx, lifecycle } = scope;
    let result = outcome;
    if (!request.background) {
        result = await prepareForegroundWorkspaceResult(result, ctx, lifecycle.events);
    }
    lifecycle.clearCompletedWorkspaceSetup(ctx, result.details);
    result.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
    if (!contextWarning) {
        return result;
    }
    return {
        ...result,
        additionalMetadata: [...(result.additionalMetadata ?? []), contextWarning],
    };
}

/**
 * Continues a run with parent guidance.
 *
 * A run the manager no longer tracks, or one that already reached a terminal checkpoint, is resumed
 * from its durable workspace record by the parent workspace actions instead.
 */
async function dispatchContinue(
    request: Extract<AgentRequest, { action: "continue" }>,
    scope: ActionScope,
): Promise<AgentRunOutcome> {
    const { ctx, lifecycle } = scope;
    const activeStatus = lifecycle.manager.getRunStatus(request.runId);
    if (activeStatus === undefined || isAgentTerminalStatus(activeStatus)) {
        return executeParentWorkspaceAction(request, {
            ...parentActionDeps(scope),
            onBackgroundUpdate: lifecycle.backgroundUpdate(ctx),
        });
    }

    let outcome = await lifecycle.manager.resume(request.runId, {
        guidance: request.guidance,
        signal: scope.signal,
        onProgress: scope.progress,
        onBackgroundUpdate: lifecycle.backgroundUpdate(ctx),
        ...(scope.workspaceCheckpoint ? { onWorkspaceCheckpoint: scope.workspaceCheckpoint } : {}),
    });
    outcome = await prepareForegroundWorkspaceResult(outcome, ctx, lifecycle.events);
    lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
    return outcome;
}

async function dispatchCancel(
    request: Extract<AgentRequest, { action: "cancel" }>,
    scope: ActionScope,
): Promise<AgentRunOutcome> {
    const { ctx, lifecycle } = scope;
    const outcome = await lifecycle.manager.cancel(request.runId, {
        ...(scope.workspaceCheckpoint ? { onWorkspaceCheckpoint: scope.workspaceCheckpoint } : {}),
    });
    return prepareForegroundWorkspaceResult(outcome, ctx, lifecycle.events);
}

function parentActionDeps(scope: ActionScope): ParentActionDeps {
    const { ctx, lifecycle } = scope;
    return {
        ctx,
        manager: lifecycle.manager,
        signal: scope.signal,
        progress: scope.progress,
        events: lifecycle.events,
        discover: lifecycle.discover.bind(lifecycle),
    };
}

/**
 * Collects a retained background result and its workspace changes.
 *
 * The result must be prepared before `collect` consumes it, and a no-change lease is only released
 * afterwards, so a rejected collect can be retried while its lease stays protected.
 */
async function dispatchCollect(
    request: Extract<AgentRequest, { action: "collect" }>,
    scope: ActionScope,
): Promise<AgentRunOutcome> {
    const { ctx, lifecycle } = scope;
    const pending = lifecycle.manager.status(request.runId);
    if (!isAgentTerminalStatus(pending.details.status)) {
        throw new AgentActionError(
            `Agent run ${request.runId} is ${pending.details.status}; wait for its terminal checkpoint before collecting.`,
        );
    }

    const workspaceResult = await prepareCollectedWorkspaceResult(
        pending.details,
        ctx,
        lifecycle.events,
    );
    const outcome = await lifecycle.manager.collect(request.runId);
    if (workspaceResult) {
        await releaseLeaseForNoChanges(workspaceResult, scope);
        outcome.details.workspaceResult = workspaceResult;
    }
    lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
    return outcome;
}

/**
 * Releases the lease a committed-nothing worker still holds.
 *
 * The lease exists to protect a result the parent has not consumed; with no commits there is no
 * result to protect, so releasing it lets the next start reuse the worktree.
 */
async function releaseLeaseForNoChanges(
    workspaceResult: AgentWorkspaceResult,
    scope: ActionScope,
): Promise<void> {
    const { ctx, lifecycle } = scope;
    const noWorkspaceChanges =
        workspaceResult.workerHead === workspaceResult.baseRevision &&
        workspaceResult.commits.length === 0;
    if (!noWorkspaceChanges) {
        return;
    }

    await releaseAgentWorkspaceAfterNoChanges(workspaceResult.workspaceId, {
        ownerSessionId: ctx.sessionManager.getSessionId(),
        leaseRunId: workspaceResult.runId,
        leaseRunInstanceId: workspaceResult.runInstanceId,
    });
    emitAgentEvent(
        {
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspaceResult.workspaceId,
            reason: "released_no_changes",
        },
        { sink: lifecycle.events, cwd: ctx.cwd },
    );
}

/**
 * Undoes the workspace claims of a failed start.
 *
 * A lease that already moved onto a run identity must move back to the provisional identity; a lease
 * that never moved is simply released. Both unwinds swallow their own failure because the parent
 * needs the original start error, and a stranded lease is recoverable from `/agents`.
 */
async function unwindStartTransaction(transaction: StartTransaction): Promise<void> {
    const reservation = transaction.reservation;
    if (!reservation) {
        return;
    }

    if (transaction.leasedTo) {
        if (transaction.started) {
            // The manager owns the run and therefore owns unwinding its lease.
            return;
        }
        await transferAgentWorkspaceLease(reservation.workspace.id, {
            ownerSessionId: reservation.ownerSessionId,
            fromLeaseRunId: transaction.leasedTo.runId,
            fromLeaseRunInstanceId: transaction.leasedTo.runInstanceId,
            toLeaseRunId: reservation.provisionalLeaseRunId,
            toLeaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
            leaseKind: "task",
        }).catch(() => {});
        return;
    }

    await releaseAgentWorkspaceLease(reservation.workspace.id, {
        ownerSessionId: reservation.ownerSessionId,
        leaseRunId: reservation.provisionalLeaseRunId,
        leaseRunInstanceId: reservation.provisionalLeaseRunInstanceId,
    }).catch(() => {});
}
