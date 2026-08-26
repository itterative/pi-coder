import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "../definitions/discovery";
import type { AgentParameters } from "../definitions/prompt";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import { AgentActionError, AgentRunManager } from "../runs/manager";
import { ZERO_USAGE } from "../runs/usage";
import { diagnosticText } from "../presentation/widget";
import { prepareForegroundWorkspaceResult } from "./finalization";
import type { AgentWorkspace, AgentWorkspaceResult } from "../contracts/workspaces";
import { listAgentRunCatalog } from "../storage/run-catalog";
import { executeWorkspaceAction } from "./actions";
import { inspectAgentWorkspaceResult } from "./results";
import { getAgentWorkspace, transferAgentWorkspaceLease } from "./store";

function parentWorkspaceOutcome(
    record: Awaited<ReturnType<typeof listAgentRunCatalog>>[number],
    workspace: AgentWorkspace,
    content: string,
): AgentRunOutcome {
    const now = Date.now();
    return {
        content,
        details: {
            runId: record.runId,
            runInstanceId: record.runInstanceId,
            title: record.title,
            agent: record.agent,
            agentSource: record.agentSource,
            status: "completed",
            background: record.background,
            task: record.task,
            workspaceId: workspace.id,
            recentActivity: [],
            usage: record.usageSnapshot,
            startedAt: record.startedAt,
            updatedAt: now,
            ...(record.mutationReport ? { mutationReport: record.mutationReport } : {}),
            ...(workspace.latestResult ? { workspaceResult: workspace.latestResult } : {}),
        },
        usage: ZERO_USAGE,
        isError: false,
    };
}

async function resolveParentWorkspaceRun(
    runId: string,
    ctx: ExtensionContext,
    manager: AgentRunManager,
): Promise<{ record: Awaited<ReturnType<typeof listAgentRunCatalog>>[number]; workspace: AgentWorkspace }> {
    await manager.flushPersistence();
    const sessionId = ctx.sessionManager.getSessionId();
    const matches = (await listAgentRunCatalog(ctx.cwd)).filter((candidate) => (
        candidate.ownerSessionId === sessionId && candidate.runId === runId
    ));
    if (matches.length > 1) {
        throw new AgentActionError(`Run ${runId} is ambiguous because multiple physical runs share this display ID.`);
    }
    const record = matches[0];
    if (!record?.workspaceId) {
        throw new AgentActionError(`Run ${runId} has no isolated workspace owned by this session.`);
    }
    const workspace = await getAgentWorkspace(record.workspaceId);
    if (!workspace) throw new AgentActionError(`Workspace ${record.workspaceId} is missing.`);
    if (
        workspace.latestResult
        && (workspace.latestResult.runId !== runId
            || workspace.latestResult.runInstanceId !== record.runInstanceId)
    ) {
        throw new AgentActionError(`Workspace ${workspace.id} has a newer result than run ${runId}.`);
    }
    return { record, workspace };
}

function requireParentWorkspaceLease(
    workspace: AgentWorkspace,
    sessionId: string,
    runId: string,
    runInstanceId?: string,
): AgentWorkspaceResult {
    if (
        workspace.leaseOwnerSessionId !== sessionId
        || workspace.leaseRunId !== runId
        || (workspace.leaseRunInstanceId !== undefined && workspace.leaseRunInstanceId !== runInstanceId)
    ) {
        throw new AgentActionError(`Workspace ${workspace.id} is not currently leased by run ${runId}.`);
    }
    if (workspace.leaseKind !== "task" || !workspace.latestResult || workspace.latestResult.status !== "prepared") {
        throw new AgentActionError(`Workspace ${workspace.id} has no prepared result for run ${runId}.`);
    }
    return workspace.latestResult;
}

export async function executeParentWorkspaceAction(
    params: Extract<AgentParameters, { action: "inspect" | "apply" | "discard" | "revise" }>,
    ctx: ExtensionContext,
    manager: AgentRunManager,
    signal: AbortSignal | undefined,
    progress: (details: AgentRunDetails) => void,
    events: AgentEventSink,
): Promise<AgentRunOutcome> {
    const resolved = await resolveParentWorkspaceRun(params.runId, ctx, manager);
    const { record, workspace } = resolved;
    if (params.action === "inspect") {
        return parentWorkspaceOutcome(record, workspace, await inspectAgentWorkspaceResult(workspace));
    }

    const sessionId = ctx.sessionManager.getSessionId();
    if (params.action === "discard") {
        const hadLease = workspace.leaseRunId !== undefined;
        const action = await executeWorkspaceAction({
            action: "discard_result",
            workspace,
            ownerSessionId: sessionId,
            runId: params.runId,
            runInstanceId: record.runInstanceId,
        });
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspace.id,
            reason: "parent_discarded",
        });
        const content = hadLease
            ? `Discarded workspace result ${action.result?.id ?? params.runId}; the isolated workspace is reusable.`
            : `Cleaned up the isolated workspace for result ${params.runId}; the parent checkout was unchanged.`;
        return parentWorkspaceOutcome(record, action.workspace ?? workspace, content);
    }

    if (params.action === "apply") {
        const action = await executeWorkspaceAction({
            action: "apply",
            workspace,
            ownerSessionId: sessionId,
            runId: params.runId,
            runInstanceId: record.runInstanceId,
        });
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspace.id,
            reason: "parent_applied",
        });
        return parentWorkspaceOutcome(
            record,
            action.workspace ?? workspace,
            `Applied workspace result ${action.result?.id ?? params.runId} to the parent checkout.`,
        );
    }

    if (params.action !== "revise") throw new AgentActionError(`Unsupported parent workspace action: ${params.action}`);
    requireParentWorkspaceLease(workspace, sessionId, params.runId, record.runInstanceId);
    const discovered = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
    const definition = discovered.agents.find((agent) => agent.name === record.agent);
    if (!definition) throw new AgentActionError(`Unknown agent definition for ${record.agent}.`);
    const revisionTask = [
        "Continue the delegated task in the existing isolated workspace. Inspect the current worktree and the previous result before making changes.",
        `Original task: ${record.task}`,
        `Parent feedback: ${params.guidance}`,
    ].join("\\n\\n");
    const revisionContext = {
        cwd: workspace.worktreePath,
        parentCwd: ctx.cwd,
        workspaceId: workspace.id,
        parentContext: ctx,
    };
    const runIdentity = manager.reserveRunIdentity(definition, revisionTask, revisionContext);
    await transferAgentWorkspaceLease(
        workspace.id,
        sessionId,
        params.runId,
        runIdentity.runId,
        "task",
        undefined,
        record.runInstanceId,
        runIdentity.runInstanceId,
    );
    const outcome = await manager.start(
        definition,
        revisionTask,
        revisionContext,
        signal,
        progress,
        `${record.title} revision`,
        runIdentity,
    );
    const prepared = await prepareForegroundWorkspaceResult(outcome, ctx, events);
    prepared.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
    return prepared;
}
