import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentCanEdit, discoverAgents } from "../definitions/discovery";
import type { AgentRequest } from "../definitions/validate";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import type { AgentRunDetails, AgentRunOutcome, PersistedAgentRun } from "../contracts/runs";
import { AgentActionError, AgentRunManager, type AgentBackgroundCallback } from "../runs/manager";
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
import {
    createAgentWorkspaceCheckpointCallback,
    latestAgentWorkspaceCheckpoint,
    restoreAgentWorkspaceCheckpoint,
} from "./checkpoints";
import { recycleAgentWorkspaceForReuse } from "./lifecycle";
import {
    claimAgentWorkspaceForContinuation,
    getAgentWorkspace,
    getAgentWorkspaceResult,
    getAgentWorkspaceResultById,
} from "./store";
import { git, hasAncestor } from "./git";

type ParentCatalogRecord = AgentRunCatalogRecord;

function parentWorkspaceOutcome(
    record: ParentCatalogRecord,
    workspace: AgentWorkspace,
    content: string,
    result?: AgentWorkspaceResult,
): AgentRunOutcome {
    const now = Date.now();
    const workspaceResult = result ?? workspace.latestResult;
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
            ...(workspaceResult ? { workspaceResult } : {}),
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
        workspaceResultId: record.workspaceResultId,
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
    const matches = (await listAgentRunCatalog(ctx.cwd)).filter(
        (candidate) => candidate.ownerSessionId === sessionId && candidate.runId === runId,
    );
    if (matches.length > 1) {
        throw new AgentActionError(
            `Run ${runId} is ambiguous because multiple physical runs share this display ID.`,
        );
    }
    const catalogRecord = matches[0];
    if (!catalogRecord) throw new AgentActionError(`Unknown or stale agent run ID: ${runId}`);
    return catalogRecord;
}

async function resolveParentWorkspaceRun(record: ParentCatalogRecord): Promise<AgentWorkspace> {
    if (!record.workspaceId) {
        throw new AgentActionError(
            `Run ${record.runId} has no isolated workspace owned by this session.`,
        );
    }
    const workspace = await getAgentWorkspace(record.workspaceId);
    if (!workspace) throw new AgentActionError(`Workspace ${record.workspaceId} is missing.`);
    return workspace;
}

async function resolveParentWorkspaceResult(
    record: ParentCatalogRecord,
    workspace: AgentWorkspace,
): Promise<AgentWorkspaceResult | undefined> {
    if (record.workspaceResultId) {
        const result = await getAgentWorkspaceResultById(record.workspaceResultId);
        if (
            !result ||
            result.workspaceId !== workspace.id ||
            result.runId !== record.runId ||
            (record.runInstanceId !== undefined && result.runInstanceId !== record.runInstanceId)
        ) {
            throw new AgentActionError(
                `Workspace result ${record.workspaceResultId} does not belong to run ${record.runId}.`,
            );
        }
        return result;
    }
    if (
        workspace.latestResult &&
        workspace.latestResult.workspaceId === workspace.id &&
        workspace.latestResult.runId === record.runId &&
        workspace.latestResult.runInstanceId === record.runInstanceId
    ) {
        return workspace.latestResult;
    }
    if (!record.runInstanceId) return undefined;
    return await getAgentWorkspaceResult(workspace.id, record.runId, record.runInstanceId);
}

interface ContinuationWorkspace {
    workspace: AgentWorkspace;
    checkpoint: NonNullable<Awaited<ReturnType<typeof latestAgentWorkspaceCheckpoint>>>;
}

async function acquireContinuationWorkspace(
    record: ParentCatalogRecord,
    workspace: AgentWorkspace,
    sessionId: string,
): Promise<ContinuationWorkspace> {
    if (!record.runInstanceId) {
        throw new AgentActionError(
            `Run ${record.runId} has no physical run identity; it cannot be continued safely.`,
        );
    }
    const checkpoint = await latestAgentWorkspaceCheckpoint(workspace.id, record.runInstanceId);
    if (!checkpoint || checkpoint.runId !== record.runId) {
        throw new AgentActionError(
            `Run ${record.runId} has no durable checkpoint in its original workspace; it cannot be continued safely.`,
        );
    }
    if (workspace.status === "recycling") {
        throw new AgentActionError(
            `Workspace ${workspace.id} is currently being recycled; try continuing again shortly.`,
        );
    }

    let acquired = workspace;
    let recycled = false;
    const ownsWorkspace =
        workspace.leaseOwnerSessionId === sessionId &&
        workspace.leaseRunId === record.runId &&
        workspace.leaseRunInstanceId === record.runInstanceId &&
        workspace.leaseKind === "task";
    if (!ownsWorkspace && workspace.leaseRunId) {
        if (workspace.leaseActive === true) {
            throw new AgentActionError(
                `Workspace ${workspace.id} is currently used by active run ${workspace.leaseRunId}; finish or cancel that run before continuing ${record.runId}.`,
            );
        }
        if (!workspace.leaseOwnerSessionId || !workspace.leaseRunInstanceId) {
            throw new AgentActionError(
                `Workspace ${workspace.id} has an incomplete lease and cannot safely resume run ${record.runId}.`,
            );
        }
        const occupantCheckpoint = await latestAgentWorkspaceCheckpoint(
            workspace.id,
            workspace.leaseRunInstanceId,
        );
        if (!occupantCheckpoint) {
            throw new AgentActionError(
                `Workspace ${workspace.id} is occupied by ${workspace.leaseRunId} without a durable checkpoint; disposition that run before continuing ${record.runId}.`,
            );
        }
        if (occupantCheckpoint.runStatus !== "interrupted") {
            const result = workspace.latestResult;
            if (
                !result ||
                result.runId !== workspace.leaseRunId ||
                (result.runInstanceId !== undefined &&
                    result.runInstanceId !== workspace.leaseRunInstanceId) ||
                result.status !== "prepared"
            ) {
                throw new AgentActionError(
                    `Workspace ${workspace.id} is occupied by ${workspace.leaseRunId} before its result was finalized; try continuing again after it settles.`,
                );
            }
        }
        const occupantHead = await git(workspace.repositoryRoot, [
            "rev-parse",
            occupantCheckpoint.durableRef,
        ]).catch(() => undefined);
        if (occupantHead !== occupantCheckpoint.headRevision) {
            throw new AgentActionError(
                `Workspace ${workspace.id} is occupied by ${workspace.leaseRunId} with an invalid checkpoint; disposition that run explicitly before continuing ${record.runId}.`,
            );
        }
        acquired = await recycleAgentWorkspaceForReuse(workspace.id, {
            previousOwnerSessionId: workspace.leaseOwnerSessionId,
            previousLeaseRunId: workspace.leaseRunId,
            previousLeaseRunInstanceId: workspace.leaseRunInstanceId,
            ownerSessionId: sessionId,
            leaseRunId: record.runId,
            leaseRunInstanceId: record.runInstanceId,
        });
        recycled = true;
    } else if (!ownsWorkspace) {
        acquired = await claimAgentWorkspaceForContinuation(workspace.id, {
            ownerSessionId: sessionId,
            leaseRunId: record.runId,
            leaseRunInstanceId: record.runInstanceId,
        });
    }

    if (!recycled) {
        const currentHead = await git(acquired.worktreePath, ["rev-parse", "HEAD"]);
        if (currentHead !== checkpoint.headRevision) {
            throw new AgentActionError(
                `Cannot continue workspace ${acquired.id}: its current revision ${currentHead} differs from checkpoint ${checkpoint.headRevision}. Reconcile or reset the workspace explicitly before continuing.`,
            );
        }
    }
    await restoreAgentWorkspaceCheckpoint(acquired, checkpoint);
    if (
        !(await hasAncestor(
            acquired.worktreePath,
            checkpoint.baseRevision,
            checkpoint.headRevision,
        ))
    ) {
        throw new AgentActionError(
            `Cannot continue workspace ${acquired.id}: checkpoint ${checkpoint.id} is not based on workspace base ${checkpoint.baseRevision}.`,
        );
    }
    return { workspace: acquired, checkpoint };
}

/** Named dependencies and controls for dispatching a parent workspace action. */
export interface ExecuteParentWorkspaceActionOptions {
    ctx: ExtensionContext;
    manager: AgentRunManager;
    signal?: AbortSignal;
    progress: (details: AgentRunDetails) => void;
    events: AgentEventSink;
    onBackgroundUpdate?: AgentBackgroundCallback;
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
        onBackgroundUpdate,
        discover = (context) => discoverAgents(context.cwd, context.isProjectTrusted()),
    }: ExecuteParentWorkspaceActionOptions,
): Promise<AgentRunOutcome> {
    if (record.status !== "removed") {
        throw new AgentActionError(
            `Run ${params.runId} must be collected before it can be continued.`,
        );
    }
    const guidance = params.guidance?.trim();
    if (!guidance) {
        throw new AgentActionError(
            `Collected agent run ${params.runId} requires continuation guidance.`,
        );
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
        throw new AgentActionError(
            `Run ${params.runId} has no persisted child session to continue.`,
        );
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
            onBackgroundUpdate,
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
        onBackgroundUpdate,
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
            onBackgroundUpdate,
            discover,
        });
    }
    const workspace = await resolveParentWorkspaceRun(record);
    const exactResult =
        params.action === "continue"
            ? undefined
            : await resolveParentWorkspaceResult(record, workspace);
    if (params.action === "inspect") {
        return parentWorkspaceOutcome(
            record,
            workspace,
            await inspectAgentWorkspaceResult(workspace, exactResult),
            exactResult,
        );
    }

    const sessionId = ctx.sessionManager.getSessionId();
    if (params.action === "discard") {
        const action = await executeWorkspaceAction({
            action: "discard_result",
            workspace,
            ownerSessionId: sessionId,
            runId: params.runId,
            runInstanceId: record.runInstanceId,
            resultId: exactResult?.id,
        });
        emitAgentEvent(
            {
                type: "workspace",
                action: "lease_changed",
                workspaceId: workspace.id,
                reason: "parent_discarded",
            },
            { sink: events, cwd: ctx.cwd },
        );
        const content = action.effects.includes("lease_changed")
            ? `Discarded workspace result ${action.result?.id ?? params.runId}; the isolated workspace is reusable.`
            : `Discarded workspace result ${action.result?.id ?? params.runId}; the current workspace lease and worktree were unchanged.`;
        return parentWorkspaceOutcome(
            record,
            action.workspace ?? workspace,
            content,
            action.result,
        );
    }

    if (params.action === "apply") {
        const action = await executeWorkspaceAction({
            action: "apply",
            workspace,
            ownerSessionId: sessionId,
            runId: params.runId,
            runInstanceId: record.runInstanceId,
            resultId: exactResult?.id,
        });
        emitAgentEvent(
            {
                type: "workspace",
                action: "lease_changed",
                workspaceId: workspace.id,
                reason: "parent_applied",
            },
            { sink: events, cwd: ctx.cwd },
        );
        return parentWorkspaceOutcome(
            record,
            action.workspace ?? workspace,
            `Applied workspace result ${action.result?.id ?? params.runId} to the parent checkout.`,
            action.result,
        );
    }

    // Remaining action is "continue": reserve the logical run before
    // reclaiming and restoring its original physical workspace.
    const continuationLease = await manager.reserveContinuationLease?.(params.runId);
    try {
        const continuation = await acquireContinuationWorkspace(record, workspace, sessionId);
        const continuationWorkspace = continuation.workspace;
        const discovered = discover(ctx);
        const definition = record.definitionSnapshot;
        if (!definition) {
            throw new AgentActionError(
                `Run ${params.runId} has no persisted agent definition snapshot; it cannot be continued. Start a new run instead.`,
            );
        }
        const currentDefinition = discovered.agents.find((agent) => agent.name === record.agent);
        if (
            agentCanEdit(definition) &&
            (!currentDefinition ||
                !agentCanEdit(currentDefinition) ||
                currentDefinition.name !== "worker" ||
                currentDefinition.source !== "builtin")
        ) {
            throw new AgentActionError(
                `Run ${params.runId} has an unauthorized persisted mutation capability; it cannot be continued.`,
            );
        }
        if (!record.childSessionFile) {
            throw new AgentActionError(
                `Run ${params.runId} has no persisted child session to continue.`,
            );
        }

        const workspaceCheckpoint = createAgentWorkspaceCheckpointCallback(
            ctx.sessionManager.getSessionId(),
        );
        const revisionContext = {
            cwd: continuationWorkspace.worktreePath,
            parentCwd: ctx.cwd,
            workspaceId: continuationWorkspace.id,
            parentContext: ctx,
            childSessionFile: continuation.checkpoint.childSessionFile ?? record.childSessionFile,
            childSessionLeafId:
                continuation.checkpoint.childSessionLeafId ?? record.childSessionLeafId,
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
                onBackgroundUpdate,
                onWorkspaceCheckpoint: workspaceCheckpoint,
                title: `${record.title} revision`,
                identity: runIdentity,
                continuationLease,
            },
        );
        const prepared = await prepareForegroundWorkspaceResult(outcome, ctx, events, {
            baseRevision: continuation.checkpoint.baseRevision,
        });
        prepared.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
        return prepared;
    } catch (error) {
        try {
            await continuationLease?.release();
        } catch {
            // Preserve the original continuation error.
        }
        throw error;
    }
}
