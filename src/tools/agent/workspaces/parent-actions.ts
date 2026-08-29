import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentCanEdit, discoverAgents } from "../definitions/discovery";
import type { AgentRequest } from "../definitions/validate";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import type { AgentRunDetails, AgentRunOutcome, PersistedAgentRun } from "../contracts/runs";
import { AgentActionError, AgentRunManager } from "../runs/manager";
import { ZERO_USAGE } from "../runs/usage";
import { diagnosticText } from "../presentation/text";
import { prepareForegroundWorkspaceResult } from "./finalization";
import type {
    AgentRunCatalogRecord,
    AgentWorkspace,
    AgentWorkspaceResult,
} from "../contracts/workspaces";
import { listAgentRunCatalog } from "../storage/run-catalog";
import { executeWorkspaceAction } from "./actions";
import { inspectAgentWorkspaceResult } from "./results";
import { getAgentWorkspace } from "./store";
import { git, hasAncestor } from "./git";

type ParentCatalogRecord = AgentRunCatalogRecord;

function parentWorkspaceOutcome(
    record: ParentCatalogRecord,
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

function catalogRecordFromPersisted(
    record: PersistedAgentRun,
    fallbackCwd: string,
): ParentCatalogRecord {
    return {
        ownerSessionId: record.ownerSessionId,
        runId: record.runId,
        runInstanceId: record.runInstanceId,
        parentCwd: record.parentCwd ?? fallbackCwd,
        executionCwd: record.cwd,
        title: record.title ?? "Delegated task",
        agent: record.agent,
        agentSource: record.agentSource,
        definitionSnapshot: record.definitionSnapshot,
        task: record.task,
        status: record.status,
        background: record.background,
        mutating: record.mutating,
        workspaceId: record.workspaceId,
        childSessionFile: record.childSessionFile,
        childSessionLeafId: record.childSessionLeafId,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        usageSnapshot: record.usageSnapshot,
        mutationReport: record.mutationReport,
    };
}

async function resolveParentRunRecord(
    runId: string,
    ctx: ExtensionContext,
    manager: AgentRunManager,
): Promise<ParentCatalogRecord> {
    await manager.flushPersistence();
    const record = manager.getPersistedRun(runId);
    if (record) {
        if (record.ownerSessionId !== ctx.sessionManager.getSessionId()) {
            throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
        }
        return catalogRecordFromPersisted(record, ctx.cwd);
    }
    if (manager.hasPersistence) {
        throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
    }

    // Ephemeral/test runtimes have no active-branch persistence authority.
    // Keep the legacy catalog fallback only for those runtimes.
    const sessionId = ctx.sessionManager.getSessionId();
    const matches = (await listAgentRunCatalog(ctx.cwd)).filter((candidate) => (
        candidate.ownerSessionId === sessionId && candidate.runId === runId
    ));
    if (matches.length > 1) {
        throw new AgentActionError(`Run ${runId} is ambiguous because multiple physical runs share this display ID.`);
    }
    const catalogRecord = matches[0];
    if (!catalogRecord) throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
    return catalogRecord;
}

async function resolveParentWorkspaceRun(
    record: ParentCatalogRecord,
): Promise<AgentWorkspace> {
    if (!record.workspaceId) {
        throw new AgentActionError(`Run ${record.runId} has no isolated workspace owned by this session.`);
    }
    const workspace = await getAgentWorkspace(record.workspaceId);
    if (!workspace) throw new AgentActionError(`Workspace ${record.workspaceId} is missing.`);
    if (
        workspace.latestResult
        && (workspace.latestResult.runId !== record.runId
            || workspace.latestResult.runInstanceId !== record.runInstanceId)
    ) {
        throw new AgentActionError(`Workspace ${workspace.id} has a newer result than run ${record.runId}.`);
    }
    return workspace;
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

// Non-mutating runs have no workspace lease to transfer. Reuse the public
// run ID so a revision remains the same agent in the parent UI.
async function continueNonIsolatedRun(
    record: ParentCatalogRecord,
    params: Extract<AgentRequest, { action: "continue" }>,
    {
        ctx,
        manager,
        signal,
        progress,
        discover = (context) => discoverAgents(context.cwd, context.isProjectTrusted()),
    }: ExecuteParentWorkspaceActionOptions,
): Promise<AgentRunOutcome> {
    if (record.status !== "removed") {
        throw new AgentActionError(`Run ${params.runId} must be collected before it can be continued.`);
    }
    const guidance = params.guidance?.trim();
    if (!guidance) {
        throw new AgentActionError(`Collected agent run ${params.runId} requires continuation guidance.`);
    }
    if (record.mutating) {
        throw new AgentActionError(
            `Run ${params.runId} is mutation-capable but has no isolated workspace; it cannot be continued safely.`,
        );
    }
    const definition = record.definitionSnapshot;
    if (!definition) {
        throw new AgentActionError(
            `Run ${params.runId} has no persisted agent definition snapshot; it cannot be continued. Start a new run instead.`,
        );
    }
    if (agentCanEdit(definition)) {
        throw new AgentActionError(
            `Run ${params.runId} has an unauthorized persisted mutation capability; it cannot be continued.`,
        );
    }
    if (!record.childSessionFile) {
        throw new AgentActionError(`Run ${params.runId} has no persisted child session to continue.`);
    }

    const discovered = discover(ctx);
    const revisionContext = {
        cwd: record.executionCwd ?? record.parentCwd ?? ctx.cwd,
        parentCwd: ctx.cwd,
        parentContext: ctx,
        childSessionFile: record.childSessionFile,
        ...(record.childSessionLeafId !== undefined
            ? { childSessionLeafId: record.childSessionLeafId }
            : {}),
    };
    const runIdentity = manager.reserveRunIdentity(
        definition,
        record.task,
        revisionContext,
        record.runId,
        record.runInstanceId,
    );
    const outcome = await manager.startContinuation(
        definition,
        record.task,
        guidance,
        revisionContext,
        {
            signal,
            onProgress: progress,
            title: `${record.title} revision`,
            identity: runIdentity,
        },
    );
    outcome.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
    return outcome;
}

export async function executeParentWorkspaceAction(
    params: Extract<AgentRequest, { action: "inspect" | "apply" | "discard" | "continue" }>,
    {
        ctx,
        manager,
        signal,
        progress,
        events,
        discover = (context) => discoverAgents(context.cwd, context.isProjectTrusted()),
    }: ExecuteParentWorkspaceActionOptions,
): Promise<AgentRunOutcome> {
    const record = await resolveParentRunRecord(params.runId, ctx, manager);
    if (params.action === "continue" && !params.guidance?.trim()) {
        throw new AgentActionError(`Continued agent run ${params.runId} requires guidance.`);
    }
    if (params.action === "continue" && !record.workspaceId) {
        return continueNonIsolatedRun(record, params, {
            ctx,
            manager,
            signal,
            progress,
            events,
            discover,
        });
    }
    const workspace = await resolveParentWorkspaceRun(record);
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

    // Remaining action is "continue": inspect/discard/apply branches returned above.
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
            `Cannot continue workspace ${workspace.id}: worker revision ${workerHead} is not based on workspace base ${workspace.baseRevision}.`,
            "Reconcile or reset the workspace explicitly before continuing; the existing result was preserved."
        ].join(" ");
        throw new AgentActionError(message);
    }
    const discovered = discover(ctx);
    const definition = record.definitionSnapshot;
    if (!definition) {
        throw new AgentActionError(
            `Run ${params.runId} has no persisted agent definition snapshot; it cannot be continued. Start a new run instead.`
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
            `Run ${params.runId} has an unauthorized persisted mutation capability; it cannot be continued.`,
        );
    }
    if (!record.childSessionFile) {
        throw new AgentActionError(`Run ${params.runId} has no persisted child session to continue.`);
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
    const runIdentity = manager.reserveRunIdentity(
        definition,
        record.task,
        revisionContext,
        record.runId,
        record.runInstanceId,
    );
    const guidance = params.guidance!.trim();
    const outcome = await manager.startContinuation(
        definition,
        record.task,
        guidance,
        revisionContext,
        {
            signal,
            onProgress: progress,
            title: `${record.title} revision`,
            identity: runIdentity,
        },
    );
    const prepared = await prepareForegroundWorkspaceResult(outcome, ctx, events);
    prepared.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
    return prepared;
}
