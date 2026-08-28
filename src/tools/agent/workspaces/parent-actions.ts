import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentCanEdit, discoverAgents } from "../definitions/discovery";
import type { AgentRequest } from "../definitions/validate";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import { AgentActionError, AgentRunManager } from "../runs/manager";
import { ZERO_USAGE } from "../runs/usage";
import { diagnosticText } from "../presentation/text";
import { prepareForegroundWorkspaceResult } from "./finalization";
import type { AgentWorkspace, AgentWorkspaceResult } from "../contracts/workspaces";
import { listAgentRunCatalog } from "../storage/run-catalog";
import { executeWorkspaceAction } from "./actions";
import { inspectAgentWorkspaceResult } from "./results";
import { getAgentWorkspace, transferAgentWorkspaceLease } from "./store";
import { git, hasAncestor } from "./git";

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

/** Named dependencies and controls for dispatching a parent workspace action. */
export interface ExecuteParentWorkspaceActionOptions {
    ctx: ExtensionContext;
    manager: AgentRunManager;
    signal?: AbortSignal;
    progress: (details: AgentRunDetails) => void;
    events: AgentEventSink;
    discover?: (ctx: ExtensionContext) => ReturnType<typeof discoverAgents>;
}

export async function executeParentWorkspaceAction(
    params: Extract<AgentRequest, { action: "inspect" | "apply" | "discard" | "revise" }>,
    {
        ctx,
        manager,
        signal,
        progress,
        events,
        discover = (context) => discoverAgents(context.cwd, context.isProjectTrusted()),
    }: ExecuteParentWorkspaceActionOptions,
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
        emitAgentEvent({
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspace.id,
            reason: "parent_discarded",
        }, { sink: events, cwd: ctx.cwd });
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
        emitAgentEvent({
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspace.id,
            reason: "parent_applied",
        }, { sink: events, cwd: ctx.cwd });
        return parentWorkspaceOutcome(
            record,
            action.workspace ?? workspace,
            `Applied workspace result ${action.result?.id ?? params.runId} to the parent checkout.`,
        );
    }

    // Remaining action is "revise": inspect/discard/apply branches returned above.
    requireParentWorkspaceLease(workspace, sessionId, params.runId, record.runInstanceId);
    let workerHead: string;
    try {
        workerHead = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AgentActionError(`Could not inspect isolated workspace ${workspace.id} before revision: ${message}`);
    }
    if (!(await hasAncestor(workspace.worktreePath, workspace.baseRevision, workerHead))) {
        const message = [
            `Cannot revise workspace ${workspace.id}: worker revision ${workerHead} is not based on workspace base ${workspace.baseRevision}.`,
            "Reconcile or reset the workspace explicitly before revising; the existing result was preserved.",
        ].join(" ");
        throw new AgentActionError(message);
    }
    const discovered = discover(ctx);
    const definition = record.definitionSnapshot;
    if (!definition) {
        throw new AgentActionError(
            `Run ${params.runId} has no persisted agent definition snapshot; it cannot be revised. Start a new run instead.`,
        );
    }
    const currentDefinition = discovered.agents.find((agent) => agent.name === record.agent);
    if (agentCanEdit(definition) && (
        !currentDefinition
        || !agentCanEdit(currentDefinition)
        || currentDefinition.name !== "worker"
        || currentDefinition.source !== "builtin"
    )) {
        throw new AgentActionError(
            `Run ${params.runId} has an unauthorized persisted mutation capability; it cannot be revised.`,
        );
    }
    if (!record.childSessionFile) {
        throw new AgentActionError(`Run ${params.runId} has no persisted child session to revise.`);
    }

    const revisionContext = {
        cwd: workspace.worktreePath,
        parentCwd: ctx.cwd,
        workspaceId: workspace.id,
        parentContext: ctx,
        childSessionFile: record.childSessionFile,
        ...(record.childSessionLeafId !== undefined
            ? { childSessionLeafId: record.childSessionLeafId }
            : {}),
    };
    const runIdentity = manager.reserveRunIdentity(definition, record.task, revisionContext);
    const revisionPrompt = params.guidance;
    const outcome = await manager.startContinuation(
        definition,
        record.task,
        revisionPrompt,
        revisionContext,
        {
            signal,
            onProgress: progress,
            title: `${record.title} revision`,
            identity: runIdentity,
        },
    );

    let leaseTransferred = false;
    try {
        await transferAgentWorkspaceLease(workspace.id, {
            ownerSessionId: sessionId,
            fromLeaseRunId: params.runId,
            toLeaseRunId: runIdentity.runId,
            leaseKind: "task",
            fromLeaseRunInstanceId: record.runInstanceId,
            toLeaseRunInstanceId: runIdentity.runInstanceId,
        });
        leaseTransferred = true;
        const prepared = await prepareForegroundWorkspaceResult(outcome, ctx, events);
        prepared.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
        return prepared;
    } catch (error) {
        if (leaseTransferred) {
            await transferAgentWorkspaceLease(workspace.id, {
                ownerSessionId: sessionId,
                fromLeaseRunId: runIdentity.runId,
                toLeaseRunId: params.runId,
                leaseKind: "task",
                fromLeaseRunInstanceId: runIdentity.runInstanceId,
                toLeaseRunInstanceId: record.runInstanceId,
            }).catch(() => {});
        }
        throw error;
    }
}
