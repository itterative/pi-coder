import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import { AgentActionError } from "../runs/manager";
import type { AgentWorkspaceResult } from "../contracts/workspaces";
import { getAgentWorkspace } from "./store";
import { prepareAgentWorkspaceApplication, releaseAgentWorkspaceAfterNoChanges } from "./results";

export interface PrepareWorkspaceResultOptions {
    baseRevision?: string;
}

export async function prepareCollectedWorkspaceResult(
    details: Pick<AgentRunDetails, "workspaceId" | "runId" | "runInstanceId" | "setupFailed">,
    ctx: ExtensionContext,
    events?: AgentEventSink,
    options: PrepareWorkspaceResultOptions = {},
): Promise<AgentWorkspaceResult | undefined> {
    if (!details.workspaceId || details.setupFailed) return undefined;
    const workspace = await getAgentWorkspace(details.workspaceId);
    if (!workspace) {
        throw new AgentActionError(
            `Isolated workspace ${details.workspaceId} is missing; result was not collected.`,
        );
    }
    const result = await prepareAgentWorkspaceApplication(workspace, {
        ownerSessionId: ctx.sessionManager.getSessionId(),
        leaseRunId: details.runId,
        leaseRunInstanceId: details.runInstanceId,
        ...(options.baseRevision ? { baseRevision: options.baseRevision } : {}),
    });
    emitAgentEvent(
        {
            type: "workspace",
            action: "result_changed",
            workspaceId: result.workspaceId,
            reason: "prepared",
        },
        { sink: events, cwd: ctx.cwd },
    );
    return result;
}

function isTerminalAgentStatus(status: AgentRunDetails["status"]): boolean {
    return (
        status === "completed" ||
        status === "failed" ||
        status === "aborted" ||
        status === "canceled"
    );
}

/**
 * Explain a reconciled base to the parent when finalization had to replace the recorded one.
 *
 * The warning is deliberately non-blocking: the result is prepared and inspectable, and apply still
 * validates the patch against the current checkout.
 */
export function workspaceBaseAdjustmentWarning(result: AgentWorkspaceResult): string | undefined {
    if (!result.baseAdjustedFrom) {
        return undefined;
    }
    return `The isolated worktree no longer descended from its recorded base ${result.baseAdjustedFrom}; the result was prepared against ${result.baseRevision} instead. Inspect the diff before applying.`;
}

/** Finalize a foreground isolated run because it has no later collect action. */
export async function prepareForegroundWorkspaceResult(
    outcome: AgentRunOutcome,
    ctx: ExtensionContext,
    events?: AgentEventSink,
    options: PrepareWorkspaceResultOptions = {},
): Promise<AgentRunOutcome> {
    if (
        outcome.details.setupFailed ||
        !isTerminalAgentStatus(outcome.details.status) ||
        !outcome.details.workspaceId
    )
        return outcome;
    const workspaceResult = await prepareCollectedWorkspaceResult(
        outcome.details,
        ctx,
        events,
        options,
    );
    if (!workspaceResult) return outcome;
    const noWorkspaceChanges =
        workspaceResult.workerHead === workspaceResult.baseRevision &&
        workspaceResult.commits.length === 0;
    if (noWorkspaceChanges) {
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
            { sink: events, cwd: ctx.cwd },
        );
    }
    outcome.details.workspaceResult = workspaceResult;
    const warning = workspaceBaseAdjustmentWarning(workspaceResult);
    if (warning) {
        outcome.additionalMetadata = [...(outcome.additionalMetadata ?? []), warning];
    }
    return outcome;
}
