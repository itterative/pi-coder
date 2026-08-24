import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "../discovery";
import { emitAgentEvent, type AgentEventSink } from "../events";
import type { AgentParameters } from "../prompt";
import {
    AgentActionError,
    AgentRunManager,
    ZERO_USAGE,
    type AgentRunDetails,
    type AgentRunOutcome,
} from "../runtime";
import { diagnosticText } from "../ui";
import { prepareForegroundWorkspaceResult } from "./finalization";
import {
    executeWorkspaceAction,
    getAgentWorkspace,
    inspectAgentWorkspaceDiff,
    listAgentRunCatalog,
    transferAgentWorkspaceLease,
    type AgentWorkspace,
    type AgentWorkspaceResult,
} from "../workspaces";

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
    const record = (await listAgentRunCatalog(ctx.cwd)).find((candidate) => (
        candidate.ownerSessionId === sessionId && candidate.runId === runId
    ));
    if (!record?.workspaceId) {
        throw new AgentActionError(`Run ${runId} has no isolated workspace owned by this session.`);
    }
    const workspace = await getAgentWorkspace(record.workspaceId);
    if (!workspace) throw new AgentActionError(`Workspace ${record.workspaceId} is missing.`);
    if (workspace.latestResult && workspace.latestResult.runId !== runId) {
        throw new AgentActionError(`Workspace ${workspace.id} has a newer result than run ${runId}.`);
    }
    return { record, workspace };
}

function requireParentWorkspaceLease(
    workspace: AgentWorkspace,
    sessionId: string,
    runId: string,
): AgentWorkspaceResult {
    if (workspace.leaseOwnerSessionId !== sessionId || workspace.leaseRunId !== runId) {
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
        return parentWorkspaceOutcome(record, workspace, await inspectAgentWorkspaceDiff(workspace));
    }

    const sessionId = ctx.sessionManager.getSessionId();
    if (params.action === "discard") {
        const hadLease = workspace.leaseRunId !== undefined;
        const action = await executeWorkspaceAction({
            action: "discard_result",
            workspace,
            ownerSessionId: sessionId,
            runId: params.runId,
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
    requireParentWorkspaceLease(workspace, sessionId, params.runId);
    const discovered = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
    const definition = discovered.agents.find((agent) => agent.name === record.agent);
    if (!definition) throw new AgentActionError(`Unknown agent definition for ${record.agent}.`);
    const revisionTask = [
        "Continue the delegated task in the existing isolated workspace. Inspect the current worktree and the previous result before making changes.",
        `Original task: ${record.task}`,
        `Parent feedback: ${params.guidance}`,
    ].join("\\n\\n");
    const outcome = await manager.start(
        definition,
        revisionTask,
        {
            cwd: workspace.worktreePath,
            parentCwd: ctx.cwd,
            workspaceId: workspace.id,
            parentContext: ctx,
        },
        signal,
        progress,
        `${record.title} revision`,
    );
    await transferAgentWorkspaceLease(workspace.id, sessionId, params.runId, outcome.details.runId);
    const prepared = await prepareForegroundWorkspaceResult(outcome, ctx, events);
    prepared.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
    return prepared;
}
