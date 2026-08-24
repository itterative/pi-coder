import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createAgentChild } from "./child";
import { discoverAgents } from "./discovery";
import { AgentMailbox } from "./mailbox";
import { loadAgentRunPersistence } from "./persistence";
import {
    listPastAgentSessions,
    loadAgentSessionTranscripts,
    currentAgentSessionItems,
    removeCurrentAgentTranscripts,
    type AgentSessionBrowserItem,
} from "./sessions";
import {
    AgentActionError,
    AgentRunManager,
    ZERO_USAGE,
    type AgentRunDetails,
    type AgentRunOutcome,
    type AgentRunSummary,
    type ChildAgentFactory,
} from "./runtime";
import {
    AgentTraceStore,
    isAgentTraceEnabled,
    registerAgentTraceCommand,
} from "./trace";
import {
    releaseAgentWorkspaceLease,
    inspectAgentWorkspaceGitState,
    listAgentWorkspaces,
    transferAgentWorkspaceLease,
    type AgentWorkspace,
} from "./workspaces";
import { showAgentSessionBrowser } from "../../tui/agent-session-browser";
import {
    availableAgentsPrompt,
    type AgentParameters,
} from "./prompt";
import {
    failedOutcome,
    listOutcome,
} from "./outcomes";
import {
    prepareIsolatedWorkspace,
    type WorkspaceReservation,
    type WorkspaceSetupUiUpdate,
} from "./workspace-setup";
import {
    AGENT_WIDGET_ID,
    clearCompletedWorkspaceSetupRun,
    diagnosticText,
    updateAgentUi,
} from "./ui";
import { registerAgentTool as registerAgentToolDefinition } from "./tool";

export { clearCompletedWorkspaceSetupRun } from "./ui";

type WorkspaceSetupRuns = Map<string, AgentRunSummary>;

export default function registerAgentTool(
    pi: ExtensionAPI,
    factory: ChildAgentFactory = createAgentChild,
): void {
    const traceStore = isAgentTraceEnabled() ? new AgentTraceStore() : undefined;
    const createManager = () => new AgentRunManager(factory, 4, traceStore);
    let manager = createManager();
    let cachedAgentPrompt = "";
    const setupRuns: WorkspaceSetupRuns = new Map();
    const refreshAgentUi = (ctx: ExtensionContext): void => {
        updateAgentUi(ctx, manager, [...setupRuns.values()]);
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
        if (clearCompletedWorkspaceSetupRun(setupRuns, details)) refreshAgentUi(ctx);
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
        await showAgentSessionBrowser({
            current,
            past,
            workspaces,
            workspaceGitStates,
            onResume: async (item) => {
                try {
                    const outcome = await manager.resume(item.id, undefined, undefined, backgroundUpdate(ctx));
                    clearCompletedWorkspaceSetup(ctx, outcome.details);
                    refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not resume ${item.id}: ${message}`, "warning");
                }
            },
            onCancel: async (item) => {
                try {
                    const outcome = await manager.cancel(item.id);
                    mailbox.notifyUserCanceled(outcome.details);
                    refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not cancel ${item.id}: ${message}`, "warning");
                }
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
        mailbox.reconcile(manager.listRuns());
    };

    pi.on("session_start", async (_event, ctx) => {
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
        mailbox.clear();
        // Prevent old-branch shutdown records from being appended at the new leaf.
        manager.setPersistence(undefined);
        await manager.shutdown();
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
                    )
                    : undefined;
                const runContext = {
                    cwd: reservation?.workspace.worktreePath ?? ctx.cwd,
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
                }
                clearCompletedWorkspaceSetup(ctx, outcome.details);
                outcome.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
            } else if (params.action === "resume") {
                outcome = await manager.resume(params.runId, params.guidance, signal, progress);
                clearCompletedWorkspaceSetup(ctx, outcome.details);
            } else if (params.action === "cancel") {
                outcome = await manager.cancel(params.runId);
            } else if (params.action === "status") {
                outcome = manager.status(params.runId);
            } else {
                outcome = manager.collect(params.runId);
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

        refreshAgentUi(ctx);
        mailbox.reconcile(manager.listRuns());
        return outcome;
    });
}
