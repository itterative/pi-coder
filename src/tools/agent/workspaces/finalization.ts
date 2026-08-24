import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import { AgentActionError } from "../runs/manager";
import type { AgentWorkspaceResult } from "../contracts/workspaces";
import { getAgentWorkspace } from "./store";
import {
    prepareAgentWorkspaceApplication,
    releaseAgentWorkspaceAfterNoChanges,
} from "./results";

export async function prepareCollectedWorkspaceResult(
    details: Pick<AgentRunDetails, "workspaceId" | "runId">,
    ctx: ExtensionContext,
    events?: AgentEventSink,
): Promise<AgentWorkspaceResult | undefined> {
    if (!details.workspaceId) return undefined;
    const workspace = await getAgentWorkspace(details.workspaceId);
    if (!workspace) {
        throw new AgentActionError(
            `Isolated workspace ${details.workspaceId} is missing; result was not collected.`,
        );
    }
    const result = await prepareAgentWorkspaceApplication(
        workspace,
        ctx.sessionManager.getSessionId(),
        details.runId,
    );
    emitAgentEvent(events, ctx.cwd, {
        type: "workspace",
        action: "result_changed",
        workspaceId: result.workspaceId,
        reason: "prepared",
    });
    return result;
}

function isTerminalAgentStatus(status: AgentRunDetails["status"]): boolean {
    return status === "completed"
        || status === "failed"
        || status === "aborted"
        || status === "canceled";
}

/** Finalize a foreground isolated run because it has no later collect action. */
export async function prepareForegroundWorkspaceResult(
    outcome: AgentRunOutcome,
    ctx: ExtensionContext,
    events?: AgentEventSink,
): Promise<AgentRunOutcome> {
    if (!isTerminalAgentStatus(outcome.details.status) || !outcome.details.workspaceId) return outcome;
    const workspaceResult = await prepareCollectedWorkspaceResult(outcome.details, ctx, events);
    if (!workspaceResult) return outcome;
    const noWorkspaceChanges = workspaceResult.workerHead === workspaceResult.baseRevision
        && workspaceResult.commits.length === 0;
    if (noWorkspaceChanges) {
        await releaseAgentWorkspaceAfterNoChanges(
            workspaceResult.workspaceId,
            ctx.sessionManager.getSessionId(),
            workspaceResult.runId,
        );
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspaceResult.workspaceId,
            reason: "released_no_changes",
        });
    }
    outcome.details.workspaceResult = workspaceResult;
    return outcome;
}
