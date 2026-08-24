import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createAgentChild } from "../child";
import { discoverAgents } from "../discovery";
import {
    createAgentEventSink,
    emitAgentEvent,
    subscribeAgentEvents,
    type AgentEventSink,
} from "../events";
import { AgentMailbox } from "../mailbox";
import { loadAgentRunPersistence } from "../persistence";
import {
    listPastAgentSessions,
    loadAgentSessionTranscripts,
    currentAgentSessionItems,
    removeCurrentAgentTranscripts,
    type AgentSessionBrowserItem,
} from "../sessions";
import {
    AgentActionError,
    AgentRunManager,
    ZERO_USAGE,
    type AgentRunDetails,
    type AgentRunOutcome,
    type AgentRunSummary,
    type ChildAgentFactory,
} from "../runtime";
import {
    AgentTraceStore,
    isAgentTraceEnabled,
    registerAgentTraceCommand,
} from "../trace";
import {
    getAgentWorkspace,
    inspectAgentWorkspaceDiff,
    inspectAgentWorkspaceGitState,
    listAgentWorkspaces,
    prepareAgentWorkspaceApplication,
    releaseAgentWorkspaceAfterNoChanges,
    releaseAgentWorkspaceLease,
    reconcileNoChangeAgentWorkspaceLeases,
    transferAgentWorkspaceLease,
    type AgentWorkspace,
    type AgentWorkspaceResult,
} from "../workspaces";
import {
    showAgentSessionBrowser,
    type AgentSessionBrowserData,
} from "../../../tui/agent-session-browser";
import {
    availableAgentsPrompt,
    type AgentParameters,
} from "../prompt";
import {
    failedOutcome,
    listOutcome,
} from "../outcomes";
import {
    prepareIsolatedWorkspace,
    type WorkspaceReservation,
    type WorkspaceSetupUiUpdate,
} from "../workspace-setup";
import {
    AGENT_WIDGET_ID,
    clearCompletedWorkspaceSetupRun,
    diagnosticText,
    updateAgentUi,
} from "../ui";
import { registerAgentTool as registerAgentToolDefinition } from "../tool";
import { formatAgentToolContent } from "../presentation/formatting";
import { handleWorkspaceAction } from "../workspaces/tui-actions";
import { executeParentWorkspaceAction } from "../workspaces/parent-actions";
import {
    prepareCollectedWorkspaceResult,
    prepareForegroundWorkspaceResult,
} from "../workspaces/finalization";

export { clearCompletedWorkspaceSetupRun } from "../ui";

type WorkspaceSetupRuns = Map<string, AgentRunSummary>;

export default function registerAgentTool(
    pi: ExtensionAPI,
    factory: ChildAgentFactory = createAgentChild,
): void {
    const traceStore = isAgentTraceEnabled() ? new AgentTraceStore() : undefined;
    const events: AgentEventSink = createAgentEventSink(pi.events);
    const createManager = () => new AgentRunManager(factory, 4, traceStore, 20, events);
    let manager = createManager();
    let cachedAgentPrompt = "";
    let activeContext: ExtensionContext | undefined;
    const setupRuns: WorkspaceSetupRuns = new Map();
    const refreshAgentUi = (ctx: ExtensionContext): void => {
        updateAgentUi(ctx, manager, [...setupRuns.values()]);
    };
    const unsubscribeAgentUiEvents = subscribeAgentEvents(pi.events, (event) => {
        if (!activeContext || activeContext.cwd !== event.cwd) return;
        refreshAgentUi(activeContext);
    });
    const emitWorkspaceEvent = (
        ctx: ExtensionContext,
        workspaceId: string,
        action: "created" | "updated" | "lease_changed" | "result_changed" | "removed",
        reason?: string,
    ): void => {
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action,
            workspaceId,
            reason,
        });
    };
    const updateSetupRun = (
        ctx: ExtensionContext,
        runId: string,
        workspace: AgentWorkspace,
        update: WorkspaceSetupUiUpdate,
    ): void => {
        const previous = setupRuns.get(runId);
        const now = Date.now();
        setupRuns.set(runId, {
            runId,
            title: `Setup ${workspace.slug}`,
            agent: "workspace-setup",
            status: update.status,
            background: false,
            task: "Prepare the isolated workspace for the implementation worker",
            startedAt: previous?.startedAt ?? now,
            updatedAt: now,
            activity: update.activity ?? previous?.activity,
            responsePreview: update.responsePreview ?? previous?.responsePreview,
            usage: update.usage ?? previous?.usage ?? ZERO_USAGE,
            mutating: true,
            workspaceId: workspace.id,
        });
        refreshAgentUi(ctx);
    };
    const clearCompletedWorkspaceSetup = (ctx: ExtensionContext, details: AgentRunDetails): void => {
        if (clearCompletedWorkspaceSetupRun(setupRuns, details)) {
            refreshAgentUi(ctx);
        }
    };
    const mailbox = new AgentMailbox(pi);
    let mailboxFlushScheduled = false;
    const flushMailbox = () => {
        mailbox.reconcile(manager.listRuns());
        mailbox.flush();
    };
    const isParentIdle = (ctx: ExtensionContext): boolean => {
        try {
            return ctx.isIdle();
        } catch {
            return false;
        }
    };
    const flushMailboxWhenIdle = (ctx: ExtensionContext) => {
        if (mailboxFlushScheduled || !isParentIdle(ctx)) return;
        mailboxFlushScheduled = true;
        queueMicrotask(() => {
            mailboxFlushScheduled = false;
            if (isParentIdle(ctx)) flushMailbox();
        });
    };
    if (traceStore) registerAgentTraceCommand(pi, traceStore);
    const showAgentBrowser = async (_args: string, ctx: ExtensionCommandContext) => {
        const loadBrowserData = async (): Promise<AgentSessionBrowserData> => {
            await manager.flushPersistence();
            const current = await loadAgentSessionTranscripts(
                currentAgentSessionItems([...manager.listRuns(), ...setupRuns.values()]),
            );
            let past: AgentSessionBrowserItem[];
            try {
                past = removeCurrentAgentTranscripts(
                    await listPastAgentSessions(ctx.cwd),
                    current,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not browse persisted delegated-agent sessions: ${message}`, "warning");
                past = [];
            }
            let workspaces: AgentWorkspace[];
            try {
                // Reconcile only verified no-change results. Changed or otherwise
                // uncertain leases remain protected until an explicit action.
                const released = await reconcileNoChangeAgentWorkspaceLeases(ctx.cwd);
                if (released > 0) {
                    ctx.ui.notify(
                        `Released ${released} verified no-change workspace lease${released === 1 ? "" : "s"}.`,
                        "info",
                    );
                    emitAgentEvent(events, ctx.cwd, {
                        type: "runtime",
                        action: "reconciled",
                        released,
                    });
                }
                workspaces = await listAgentWorkspaces(ctx.cwd);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not browse agent workspaces: ${message}`, "warning");
                workspaces = [];
            }
            const workspaceGitStates = new Map(
                await Promise.all(workspaces.map(async (workspace) => [
                    workspace.id,
                    await inspectAgentWorkspaceGitState(workspace),
                ] as const)),
            );
            return { current, past, workspaces, workspaceGitStates };
        };
        const initial = await loadBrowserData();
        await showAgentSessionBrowser({
            ...initial,
            cwd: ctx.cwd,
            currentSessionId: ctx.sessionManager.getSessionId(),
            eventBus: pi.events,
            onRefresh: loadBrowserData,
            onResume: async (item) => {
                try {
                    const outcome = await prepareForegroundWorkspaceResult(
                        await manager.resume(item.id, undefined, undefined, backgroundUpdate(ctx)),
                        ctx,
                        events,
                    );
                    clearCompletedWorkspaceSetup(ctx, outcome.details);
                    refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not resume ${item.id}: ${message}`, "warning");
                }
            },
            onCancel: async (item) => {
                try {
                    const outcome = await prepareForegroundWorkspaceResult(
                        await manager.cancel(item.id),
                        ctx,
                        events,
                    );
                    mailbox.notifyUserCanceled(outcome.details);
                    refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not cancel ${item.id}: ${message}`, "warning");
                }
            },
            onWorkspaceInspect: async (workspace) => inspectAgentWorkspaceDiff(workspace),
            onWorkspaceAction: async (workspace, action) => {
                const replacement = await handleWorkspaceAction(workspace, action, ctx, manager);
                if (replacement) {
                    initial.workspaceGitStates?.set(replacement.id, await inspectAgentWorkspaceGitState(replacement));
                }
                if (replacement !== workspace) {
                    if (action === "discard") {
                        emitWorkspaceEvent(ctx, workspace.id, "removed", action);
                    } else {
                        emitWorkspaceEvent(ctx, workspace.id, "updated", action);
                        if (action === "apply" || action === "retain") {
                            emitWorkspaceEvent(ctx, workspace.id, "result_changed", action);
                        }
                        if (action === "apply" || action === "retain" || action === "reset" || action === "release") {
                            emitWorkspaceEvent(ctx, workspace.id, "lease_changed", action);
                        }
                    }
                }
                return replacement;
            },
        }, ctx);
    };
    pi.registerCommand("agents", {
        description: "Browse delegated agents and isolated workspaces",
        handler: showAgentBrowser,
    });
    const notifiedWarnings = new Set<string>();

    const discover = (ctx: ExtensionContext) => {
        const result = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
        for (const diagnostic of result.diagnostics) {
            if (diagnostic.level !== "warning") continue;
            const text = diagnosticText(diagnostic);
            if (notifiedWarnings.has(text)) continue;
            notifiedWarnings.add(text);
            ctx.ui.notify(`pi-coder agents: ${text}`, "warning");
        }
        return result;
    };

    const backgroundUpdate = (ctx: ExtensionContext) => (details: AgentRunDetails) => {
        if (details.status === "completed" || details.status === "failed" || details.status === "aborted" || details.status === "canceled") {
            clearCompletedWorkspaceSetup(ctx, details);
        }
        refreshAgentUi(ctx);
        mailbox.queue(details);
        mailbox.reconcile(manager.listRuns());
        flushMailboxWhenIdle(ctx);
    };

    const restoreManager = async (ctx: ExtensionContext) => {
        let loaded: ReturnType<typeof loadAgentRunPersistence>;
        try {
            loaded = loadAgentRunPersistence(pi, ctx);
        } catch (error) {
            manager.setPersistence(undefined);
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`pi-coder agents: durable child storage is unavailable: ${message}`, "warning");
            return;
        }
        manager.setPersistence(loaded?.persistence);
        if (!loaded) return;
        const discovered = discover(ctx);
        const result = await manager.restore(
            loaded.records,
            discovered.agents,
            { cwd: ctx.cwd, parentContext: ctx },
            backgroundUpdate(ctx),
        );
        for (const diagnostic of result.diagnostics) ctx.ui.notify(`pi-coder agents: ${diagnostic}`, "warning");
        if (result.restored > 0) {
            ctx.ui.notify(`Restored ${result.restored} delegated agent run${result.restored === 1 ? "" : "s"}.`, "info");
        }
        refreshAgentUi(ctx);
        emitAgentEvent(events, ctx.cwd, { type: "runtime", action: "restored" });
        mailbox.reconcile(manager.listRuns());
        await manager.flushPersistence();
    };

    pi.on("session_start", async (_event, ctx) => {
        activeContext = ctx;
        const discovered = discover(ctx);
        cachedAgentPrompt = availableAgentsPrompt(discovered.agents);
        await restoreManager(ctx);
    });

    pi.on("agent_settled", () => {
        flushMailbox();
    });

    pi.on("before_agent_start", (event, ctx) => {
        if (event.systemPrompt.includes("<delegated_agents>")) {
            return { systemPrompt: event.systemPrompt };
        }
        if (!cachedAgentPrompt) {
            const discovered = discover(ctx);
            cachedAgentPrompt = availableAgentsPrompt(discovered.agents);
        }
        const projectContextEnd = "</project_context>";
        const idx = event.systemPrompt.indexOf(projectContextEnd);
        const systemPrompt = idx === -1
            ? `${event.systemPrompt}\n\n${cachedAgentPrompt}`
            : event.systemPrompt.slice(0, idx + projectContextEnd.length)
                + "\n\n"
                + cachedAgentPrompt
                + "\n"
                + event.systemPrompt.slice(idx + projectContextEnd.length);
        return { systemPrompt };
    });

    pi.on("session_before_tree", (_event, ctx) => {
        const unsafe = manager.listRuns().some((run) => (
            run.status === "starting" || run.status === "running" || run.status === "waiting_for_permission"
        )) || [...setupRuns.values()].some((run) => (
            run.status === "starting" || run.status === "running"
        ));
        if (!unsafe) return;
        ctx.ui.notify("Pause, finish, or cancel running delegated agents before navigating the session tree.", "warning");
        return { cancel: true };
    });

    pi.on("session_tree", async (_event, ctx) => {
        activeContext = ctx;
        mailbox.clear();
        // Prevent old-branch shutdown records from being appended at the new leaf.
        manager.setPersistence(undefined);
        await manager.shutdown();
        await manager.flushPersistence();
        emitAgentEvent(events, ctx.cwd, { type: "runtime", action: "reset" });
        setupRuns.clear();
        ctx.ui.setWidget(AGENT_WIDGET_ID, undefined);
        manager = createManager();
        const discovered = discover(ctx);
        cachedAgentPrompt = availableAgentsPrompt(discovered.agents);
        await restoreManager(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        mailbox.close();
        setupRuns.clear();
        ctx.ui.setWidget(AGENT_WIDGET_ID, undefined);
        await manager.shutdown();
        await manager.flushPersistence();
        emitAgentEvent(events, ctx.cwd, { type: "runtime", action: "shutdown" });
        activeContext = undefined;
        unsubscribeAgentUiEvents();
    });

    pi.on("tool_result", (event) => {
        if (event.toolName !== "agent") return;
        const details = event.details as Partial<AgentRunDetails> | undefined;
        if (details?.status === "failed" || details?.status === "aborted") {
            return { isError: true };
        }
    });

    registerAgentToolDefinition(pi, async (params: AgentParameters, signal, progress, ctx) => {
        let outcome: AgentRunOutcome;
        let reservation: WorkspaceReservation | undefined;
        try {
            if (params.action === "list") {
                outcome = listOutcome(manager);
            } else if (params.action === "start" || params.action === "spawn") {
                const discovered = discover(ctx);
                const definition = discovered.agents.find((agent) => agent.name === params.agent);
                if (!definition) {
                    throw new AgentActionError(`Unknown agent: ${params.agent}`);
                }
                reservation = params.isolation === "worktree"
                    ? await prepareIsolatedWorkspace(
                        ctx.cwd,
                        definition,
                        factory,
                        manager,
                        ctx,
                        signal,
                        (runId, workspace, update) => updateSetupRun(ctx, runId, workspace, update),
                        events,
                    )
                    : undefined;
                const runContext = {
                    cwd: reservation?.workspace.worktreePath ?? ctx.cwd,
                    parentCwd: ctx.cwd,
                    workspaceId: reservation?.workspace.id,
                    parentContext: ctx,
                };
                const background = backgroundUpdate(ctx);
                const workspaceBackground = (details: AgentRunDetails) => {
                    background(details);
                };
                outcome = params.action === "start"
                    ? await manager.start(
                        definition,
                        params.task,
                        runContext,
                        signal,
                        progress,
                        params.title,
                    )
                    : manager.spawn(
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
                    emitWorkspaceEvent(ctx, reservation.workspace.id, "lease_changed", "transferred");
                }
                if (params.action === "start") {
                    outcome = await prepareForegroundWorkspaceResult(outcome, ctx, events);
                }
                clearCompletedWorkspaceSetup(ctx, outcome.details);
                outcome.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
            } else if (params.action === "resume") {
                outcome = await manager.resume(params.runId, params.guidance, signal, progress);
                outcome = await prepareForegroundWorkspaceResult(outcome, ctx, events);
                clearCompletedWorkspaceSetup(ctx, outcome.details);
            } else if (params.action === "cancel") {
                outcome = await prepareForegroundWorkspaceResult(
                    await manager.cancel(params.runId),
                    ctx,
                    events,
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
                    manager,
                    signal,
                    progress,
                    events,
                );
            } else if (params.action === "status") {
                outcome = manager.status(params.runId);
            } else {
                const pending = manager.status(params.runId);
                const workspaceResult = await prepareCollectedWorkspaceResult(pending.details, ctx, events);
                const noWorkspaceChanges = workspaceResult
                    ? workspaceResult.workerHead === workspaceResult.baseRevision && workspaceResult.commits.length === 0
                    : false;
                // Keep a no-change lease held until the retained agent result
                // has actually been consumed. If manager.collect() rejects,
                // the caller must be able to retry collection and the lease
                // must not already have been released underneath it.
                outcome = manager.collect(params.runId);
                if (workspaceResult && noWorkspaceChanges) {
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
                if (workspaceResult) {
                    outcome.details.workspaceResult = workspaceResult;
                }
                clearCompletedWorkspaceSetup(ctx, outcome.details);
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

        outcome.content = formatAgentToolContent(params.action, outcome);

        refreshAgentUi(ctx);
        mailbox.reconcile(manager.listRuns());
        return outcome;
    });
}
