import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { selectWithMessage } from "../../tui/select-with-message";
import { type Static, Type } from "typebox";

import { createAgentChild } from "./child";
import {
    discoverAgents,
    type AgentDefinition,
    type AgentDiagnostic,
} from "./discovery";
import { AgentMailbox } from "./mailbox";
import { loadAgentRunPersistence } from "./persistence";
import {
    claimAgentWorkspace,
    completeAgentWorkspaceLease,
    createAgentWorkspace,
    findAvailableAgentWorkspace,
    findUnpreparedAgentWorkspace,
    inspectAgentWorkspaceGitState,
    listAgentWorkspaces,
    releaseAgentWorkspaceLease,
    transferAgentWorkspaceLease,
    updateAgentWorkspace,
    type AgentWorkspace,
} from "./workspaces";
import {
    currentAgentSessionItems,
    listPastAgentSessions,
    loadAgentSessionTranscripts,
    removeCurrentAgentTranscripts,
    type AgentSessionBrowserItem,
} from "./sessions";
import { showAgentSessionBrowser } from "../../tui/agent-session-browser";
import {
    AgentActionError,
    AgentRunManager,
    ZERO_USAGE,
    deriveAgentTitle,
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

const parameters = Type.Union([
    Type.Object({
        action: Type.Literal("list"),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("start"),
        agent: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 16_000 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        isolation: Type.Optional(Type.Literal("worktree")),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("spawn"),
        agent: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 16_000 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        isolation: Type.Optional(Type.Literal("worktree")),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("resume"),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
        guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("cancel"),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Union([Type.Literal("status"), Type.Literal("collect")]),
        runId: Type.String({ minLength: 1, maxLength: 100 }),
    }, { additionalProperties: false }),
]);

type AgentParameters = Static<typeof parameters>;

function cloneUsage(): Usage {
    return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
}

function listOutcome(manager: AgentRunManager): AgentRunOutcome {
    const runs = manager.listRuns();
    const content = runs.length
        ? runs.map((run) => {
            const nextAction = run.status === "waiting_for_parent" || run.status === "interrupted"
                ? `resume with guidance using runId=${JSON.stringify(run.runId)}`
                : run.status === "completed" || run.status === "failed" || run.status === "aborted" || run.status === "canceled"
                    ? `collect with runId=${JSON.stringify(run.runId)}`
                    : "wait for its automatic notification";
            return `- ${JSON.stringify(run.runId)} · ${JSON.stringify(run.title)} · ${run.agent} · ${run.status}\n  Task: ${JSON.stringify(run.task)}\n  Next: ${nextAction}`;
        }).join("\n")
        : "No delegated agent runs are currently tracked.";
    const now = Date.now();
    return {
        content,
        details: {
            runId: "list",
            title: "Delegated agent runs",
            agent: "runtime",
            status: "completed",
            background: false,
            task: "List delegated agent runs",
            recentActivity: [],
            usage: cloneUsage(),
            startedAt: now,
            updatedAt: now,
        },
        usage: cloneUsage(),
        isError: false,
    };
}

function failedOutcome(params: AgentParameters, error: unknown): AgentRunOutcome {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    const isNewRun = params.action === "start" || params.action === "spawn";
    const runId = isNewRun ? "unstarted" : "unknown";
    return {
        content: `Agent action failed: ${message}`,
        details: {
            runId,
            title: isNewRun ? deriveAgentTitle(params.task, params.title) : "Agent action",
            agent: isNewRun ? params.agent : "unknown",
            status: "failed",
            background: params.action === "spawn",
            task: isNewRun ? params.task.slice(0, 2_000) : "",
            recentActivity: [],
            usage: cloneUsage(),
            startedAt: now,
            updatedAt: now,
            error: message,
        },
        usage: cloneUsage(),
        isError: true,
    };
}

function updateResult(details: AgentRunDetails) {
    const activity = details.recentActivity[details.recentActivity.length - 1];
    const text = activity
        ? `Agent ${details.title} (${details.runId}): ${activity}`
        : `Agent ${details.title} (${details.runId}): ${details.status}`;
    return {
        content: [{ type: "text" as const, text }],
        details,
    };
}

function availableAgentsPrompt(agents: AgentDefinition[]): string {
    const lines = ["## Delegated agents"];
    for (const agent of agents.slice(0, 20)) {
        const description = agent.description.replace(/\s+/g, " ").slice(0, 300);
        lines.push(`- ${agent.name} (${agent.source}): [${agent.mutating ? "mutation-capable" : "read-only"}] ${JSON.stringify(description)}`);
    }
    if (agents.length > 20) lines.push(`- …and ${agents.length - 20} more agents`);
    lines.push(
        "Use action=\"start\" for foreground delegation or action=\"spawn\" to launch concurrent background work.",
        "Use action=\"list\" to recover delegated run IDs, titles, statuses, and next actions; this is preferable to polling each run.",
        "Do not poll background runs with action=\"status\". Automatic mailbox notifications arrive when a run finishes or needs parent guidance.",
        "After a terminal notification, retrieve the full result with action=\"collect\"; mailbox markers never inject full child output automatically.",
        "A waiting result is paused, not completed. Investigate or obtain guidance, then resume it; cancel it if no longer needed. An interrupted durable run never resumes automatically; wait for explicit user direction before resuming or canceling it.",
        "The built-in worker mutates the selected checkout or explicitly requested worktree. Every edit/write/bash action requires an explicit user permission prompt, and only one worker can be active at once.",
        "Use isolation=\"worktree\" when the worker should run in a persistent isolated Git worktree; a new worktree may prompt for an optional setup worker.",
    );
    return `<delegated_agents>\n${lines.join("\n")}\n</delegated_agents>`;
}

type WorkspacePromptChoice = "setup" | "skip" | "cancel";

type WorkspaceSetupUiUpdate = Pick<AgentRunSummary, "status"> & Partial<Pick<
    AgentRunSummary,
    "activity" | "responsePreview" | "usage"
>>;
type WorkspaceSetupUiCallback = (
    runId: string,
    workspace: AgentWorkspace,
    update: WorkspaceSetupUiUpdate,
) => void;

async function runWorkspaceSetup(
    workspace: AgentWorkspace,
    definition: AgentDefinition,
    factory: ChildAgentFactory,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    setupRunId: string,
    onUiUpdate?: WorkspaceSetupUiCallback,
): Promise<AgentWorkspace> {
    onUiUpdate?.(setupRunId, workspace, {
        status: "starting",
        activity: "Starting workspace setup",
    });
    await updateAgentWorkspace(workspace, { setupState: "running" });
    ctx.ui.notify(`Preparing isolated workspace ${workspace.slug}…`, "info");
    const setupDefinition: AgentDefinition = {
        name: "workspace-setup",
        description: "Prepare an isolated development workspace without implementing the task",
        tools: [...definition.tools],
        model: definition.model,
        source: "builtin",
        mutating: definition.mutating,
        systemPrompt: `You are the isolated workspace setup specialist for a later implementation worker.

Your only job is to inspect the project and assess its existing development environment. Do not install packages, update dependencies, edit configuration or lockfiles, generate files, run formatters, or otherwise modify any project or environment files. You may inspect existing dependencies and run read-only validation commands when useful. If a prerequisite is missing, report it instead of trying to install or repair it. Do not implement features or make unrelated source changes. Stop after inspection and report the commands you ran, environment assumptions, missing prerequisites, and how the later worker should validate its work.`,
    };
    let handle: Awaited<ReturnType<ChildAgentFactory>> | undefined;
    try {
        handle = await factory({
            cwd: workspace.worktreePath,
            definition: setupDefinition,
            parentContext: ctx,
            background: false,
            runId: `workspace-setup-${workspace.slug}`,
            runTitle: `Setup ${workspace.slug}`,
            onProgress: (progress) => {
                onUiUpdate?.(setupRunId, workspace, {
                    status: "running",
                    activity: progress.recentActivity[progress.recentActivity.length - 1] ?? "Preparing workspace",
                    responsePreview: progress.output,
                });
            },
        });
        onUiUpdate?.(setupRunId, workspace, {
            status: "running",
            activity: "Preparing workspace",
        });
        const abortSetup = () => { void handle?.abort(); };
        signal?.addEventListener("abort", abortSetup, { once: true });
        try {
            await handle.prompt(
                "Inspect this isolated workspace for a later implementation worker. Check the existing dependencies and available development/test commands, but do not install packages or modify any project or environment files. If something is missing, report it instead of repairing it. Do not implement features; stop with a concise environment report.",
            );
        } finally {
            signal?.removeEventListener("abort", abortSetup);
        }
        const question = handle.takeParentQuestion();
        if (question) throw new AgentActionError(`Workspace setup requested guidance: ${question.question}`);
        const error = handle.getError();
        if (error) throw new AgentActionError(`Workspace setup failed: ${error}`);
        const summary = handle.getFinalOutput().trim();
        if (!summary) throw new AgentActionError("Workspace setup completed without a setup report.");
        onUiUpdate?.(setupRunId, workspace, {
            status: "completed",
            activity: "Setup complete",
            responsePreview: summary,
            usage: handle.getUsage(),
        });
        return updateAgentWorkspace(workspace, {
            setupState: "ready",
            setupSummary: summary,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUiUpdate?.(setupRunId, workspace, {
            status: "failed",
            activity: "Setup failed",
            responsePreview: message,
        });
        await updateAgentWorkspace(workspace, { setupState: "failed", setupSummary: message });
        throw error;
    } finally {
        handle?.dispose();
    }
}

interface WorkspaceReservation {
    workspace: AgentWorkspace;
    ownerSessionId: string;
    provisionalLeaseRunId: string;
}

async function prepareIsolatedWorkspace(
    cwd: string,
    definition: AgentDefinition,
    factory: ChildAgentFactory,
    manager: AgentRunManager,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUiUpdate?: WorkspaceSetupUiCallback,
): Promise<WorkspaceReservation> {
    if (!definition.mutating) {
        throw new AgentActionError("Worktree isolation is currently available only for the mutation-capable worker.");
    }
    if (manager.hasActiveMutatingRun) {
        throw new AgentActionError("A mutation-capable worker is already active.");
    }

    const ownerSessionId = ctx.sessionManager.getSessionId();
    const provisionalLeaseRunId = `workspace-provision-${randomUUID()}`;
    const available = await findAvailableAgentWorkspace(cwd);
    if (available) {
        const workspace = await claimAgentWorkspace(
            available.id,
            ownerSessionId,
            provisionalLeaseRunId,
            "task",
        );
        return { workspace, ownerSessionId, provisionalLeaseRunId };
    }

    const existing = await findUnpreparedAgentWorkspace(cwd);
    const prompt = await selectWithMessage<WorkspacePromptChoice>({
        title: existing ? "Prepare isolated workspace?" : "Create isolated workspace?",
        contentLines: existing
            ? [
                `Workspace ${existing.slug} exists but has not been prepared.`,
                `Path: ${existing.worktreePath}`,
                "Choose whether a limited setup worker should prepare it before the task.",
            ]
            : [
                "No ready isolated workspace exists for this project.",
                "A detached Git worktree will be created under pi-coder's .state/workspaces directory.",
                "Choose whether a limited setup worker should prepare it before the task.",
            ],
        items: [
            {
                value: "setup",
                label: existing ? "Run setup worker" : "Create and run setup worker",
                description: "Prepare dependencies and project tooling before the task worker starts.",
            },
            {
                value: "skip",
                label: existing ? "Skip setup" : "Create and skip setup",
                description: "Start the task worker in the worktree without a setup pass.",
            },
            {
                value: "cancel",
                label: "Cancel",
                description: "Do not start the isolated worker.",
            },
        ],
        selectHelpText: "↑/↓ choose · Enter confirm · Esc cancel",
    }, ctx, signal);
    const choice = prompt?.value;
    if (!choice || choice === "cancel") {
        throw new AgentActionError("Isolated worker canceled before workspace setup.");
    }

    const workspace = existing ?? await createAgentWorkspace(cwd);
    const leaseKind = choice === "setup" ? "setup" : "task";
    try {
        const claimed = await claimAgentWorkspace(
            workspace.id,
            ownerSessionId,
            provisionalLeaseRunId,
            leaseKind,
        );
        if (choice === "setup") {
            await runWorkspaceSetup(
                claimed,
                definition,
                factory,
                ctx,
                signal,
                provisionalLeaseRunId,
                onUiUpdate,
            );
        }
        else await updateAgentWorkspace(claimed, { setupState: "skipped" });
        return {
            workspace: claimed,
            ownerSessionId,
            provisionalLeaseRunId,
        };
    } catch (error) {
        await releaseAgentWorkspaceLease(workspace.id, ownerSessionId, provisionalLeaseRunId).catch(() => {});
        throw error;
    }
}

function diagnosticText(diagnostic: AgentDiagnostic): string {
    const paths = diagnostic.paths.length ? ` [${diagnostic.paths.join(", ")}]` : "";
    return `${diagnostic.message}${paths}`;
}

function oneLinePreview(text: string, maxChars = 180): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isTerminalAgentStatus(status: AgentRunDetails["status"]): boolean {
    return status === "completed"
        || status === "failed"
        || status === "aborted"
        || status === "canceled";
}

const AGENT_WIDGET_ID = "pi-coder-agent-activity";

function updateAgentUi(
    ctx: ExtensionContext,
    manager: AgentRunManager,
    extraRuns: AgentRunSummary[] = [],
): void {
    const runs = [...manager.listRuns(), ...extraRuns];
    if (!runs.length) {
        ctx.ui.setWidget(AGENT_WIDGET_ID, undefined);
        return;
    }

    const activeRuns = runs.filter((run) => (
        run.status === "starting" || run.status === "running" || run.status === "waiting_for_permission" || run.status === "waiting_for_parent" || run.status === "interrupted"
    ));
    const terminalRuns = runs.filter((run) => !activeRuns.includes(run)).slice(-3);
    const visibleRuns = [...activeRuns, ...terminalRuns];
    const activityLines = visibleRuns.map((run) => {
        const response = run.responsePreview
            ? ` · “${oneLinePreview(run.responsePreview, 72)}”`
            : "";
        const label = run.agent === "workspace-setup" ? run.title : run.runId;
        if (run.status === "starting") {
            return `● ${label} — Starting: ${oneLinePreview(run.task, 90)}`;
        }
        if (run.status === "running") {
            return `● ${label} — ${run.activity ?? "Working"}${response}`;
        }
        if (run.status === "waiting_for_permission") {
            return `? ${label} — ${run.activity ?? "Waiting for mutation permission"}${response}`;
        }
        if (run.status === "waiting_for_parent") {
            return `? ${label} — Waiting: ${oneLinePreview(run.question ?? "parent guidance", 100)}${response}`;
        }
        if (run.status === "interrupted") {
            return `! ${label} — Interrupted; resume with explicit guidance${response}`;
        }
        if (run.status === "completed") {
            return `✓ ${label} — Ready to collect${response}`;
        }
        if (run.status === "failed") {
            return `! ${label} — Failed; result ready to collect${response}`;
        }
        return `× ${label} — ${run.status}`;
    });
    if (runs.length > visibleRuns.length) {
        activityLines.push(`… ${runs.length - visibleRuns.length} older result(s) hidden`);
    }
    ctx.ui.setWidget(AGENT_WIDGET_ID, activityLines, { placement: "aboveEditor" });
}

export default function registerAgentTool(
    pi: ExtensionAPI,
    factory: ChildAgentFactory = createAgentChild,
): void {
    const traceStore = isAgentTraceEnabled() ? new AgentTraceStore() : undefined;
    const createManager = () => new AgentRunManager(factory, 4, traceStore);
    let manager = createManager();
    let cachedAgentPrompt = "";
    const setupRuns = new Map<string, AgentRunSummary>();
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
    const mailbox = new AgentMailbox(pi);
    const releaseWorkspaceForRun = async (ctx: ExtensionContext, details: AgentRunDetails): Promise<void> => {
        if (!details.workspaceId || !isTerminalAgentStatus(details.status)) return;
        try {
            await completeAgentWorkspaceLease(
                details.workspaceId,
                ctx.sessionManager.getSessionId(),
                details.runId,
            );
        } catch (error) {
            ctx.ui.notify(
                `Could not release workspace lease for ${details.runId}: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
            );
        }
    };
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
                    await releaseWorkspaceForRun(ctx, outcome.details);
                    refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not resume ${item.id}: ${message}`, "warning");
                }
            },
            onCancel: async (item) => {
                try {
                    const outcome = await manager.cancel(item.id);
                    await releaseWorkspaceForRun(ctx, outcome.details);
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

    pi.registerTool({
        name: "agent",
        label: "Agent",
        description:
            "Delegate codebase work to a built-in or custom agent. Scout and custom agents are read-only; the built-in "
            + "worker can edit the selected checkout or isolated worktree and run bash only through explicit per-action user permission prompts. "
            + "Run work in the foreground or background; optionally provide a short human-readable title; list, status, collect, resume, or cancel retained runs. In persisted "
            + "parent sessions, paused and interrupted child context survives reload, restart, and switching away and back.",
        promptSnippet:
            "Use agent for substantial delegated work: scout/custom agents explore read-only, while worker performs permission-gated implementation.",
        promptGuidelines: [
            "Use list to recover delegated run IDs and statuses after compaction or session restoration; use the returned IDs for status, resume, collect, or cancel",
            "Use start when the result is needed immediately; use spawn for independent work that can run concurrently; provide a short title when the run should be easy to identify later",
            "Do not poll spawned runs with status; automatic follow-up mailbox context notifies you when they finish or need parent guidance",
            "After a terminal notification, retrieve the full result with collect; mailbox updates never interrupt current work and never include the full result",
            "A waiting agent is paused, not completed; investigate or obtain guidance, then resume it, or cancel it if no longer needed",
            "Durable interrupted runs never replay or resume automatically; wait for explicit user direction before resuming or canceling them, and account for uncertain tool outcomes",
            "Background agents cannot open direct user dialogs; they request parent guidance instead",
            "Use the returned run ID exactly; runs are cwd-confined and durable only within the exact persisted parent session",
            "Only the built-in worker may mutate; each edit, write, or bash call requires an explicit user prompt, and only one worker may be active at once",
        ],
        parameters,
        executionMode: "sequential",
        renderCall(args, theme) {
            if (args.action === "list") {
                return new Text(theme.fg("toolTitle", theme.bold("agent list")), 0, 0);
            }
            if (args.action === "start" || args.action === "spawn") {
                return new Text(
                    theme.fg("toolTitle", theme.bold(`agent ${args.action} `))
                    + theme.fg("accent", args.title ?? args.agent)
                    + theme.fg("muted", ` (${args.agent}) — ${args.task}`),
                    0,
                    0,
                );
            }
            return new Text(
                theme.fg("toolTitle", theme.bold(`agent ${args.action} `))
                + theme.fg("accent", args.runId),
                0,
                0,
            );
        },
        renderResult(result, { expanded }, theme) {
            const details = result.details as AgentRunDetails;
            const color = details.status === "completed"
                ? "success"
                : details.status === "waiting_for_parent" || details.status === "waiting_for_permission" || details.status === "interrupted"
                    ? "warning"
                    : details.status === "starting" || details.status === "running"
                        ? "accent"
                        : details.status === "canceled"
                            ? "muted"
                            : "error";
            const content = result.content.find((part) => part.type === "text");
            const source = details.agentSource ? ` (${details.agentSource})` : "";
            let text = theme.fg(color, `${details.title} (${details.runId})${source}: ${details.status}`);
            if (!expanded && details.status === "waiting_for_permission") {
                text += theme.fg("warning", `\n${oneLinePreview(details.recentActivity[details.recentActivity.length - 1] ?? "Waiting for mutation permission")}`);
            } else if (!expanded && details.status === "interrupted") {
                text += theme.fg("warning", `\nResume with explicit guidance: ${details.runId}`);
            } else if (!expanded && details.status === "waiting_for_parent") {
                const question = oneLinePreview(details.question?.question ?? "");
                if (question) text += `\n${theme.fg("warning", `Question: ${question}`)}`;
                text += theme.fg("muted", `\nResume required: ${details.runId}`);
            } else if (
                !expanded
                && (details.status === "completed" || details.status === "starting" || details.status === "running")
                && content?.type === "text"
            ) {
                const preview = oneLinePreview(content.text);
                if (preview) text += `\n${theme.fg("muted", `${details.status === "completed" ? "Result" : "Status"}: ${preview}`)}`;
            } else if (expanded && content?.type === "text") {
                text += theme.fg("muted", `\nTitle: ${details.title}\nTask: ${details.task}`);
                text += `\n\n${content.text}`;
                if (details.recentActivity.length) {
                    text += theme.fg("muted", `\n\nActivity:\n- ${details.recentActivity.join("\n- ")}`);
                }
                if (details.discoveryDiagnostics?.length) {
                    text += theme.fg("muted", `\n\nDiscovery diagnostics:\n- ${details.discoveryDiagnostics.join("\n- ")}`);
                }
                const usage = details.usage;
                text += theme.fg(
                    "muted",
                    `\n\nUsage: ${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, $${usage.cost.total.toFixed(4)}`,
                );
            }
            return new Text(text, 0, 0);
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
            let outcome: AgentRunOutcome;
            let reservation: WorkspaceReservation | undefined;
            const progress = (details: AgentRunDetails) => onUpdate?.(updateResult(details));
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
                        void releaseWorkspaceForRun(ctx, details);
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
                        await releaseWorkspaceForRun(ctx, outcome.details);
                    }
                    outcome.details.discoveryDiagnostics = discovered.diagnostics.map(diagnosticText);
                } else if (params.action === "resume") {
                    outcome = await manager.resume(params.runId, params.guidance, signal, progress);
                    await releaseWorkspaceForRun(ctx, outcome.details);
                } else if (params.action === "cancel") {
                    outcome = await manager.cancel(params.runId);
                    await releaseWorkspaceForRun(ctx, outcome.details);
                } else if (params.action === "status") {
                    outcome = manager.status(params.runId);
                } else {
                    outcome = manager.collect(params.runId);
                    await releaseWorkspaceForRun(ctx, outcome.details);
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
            return {
                content: [{ type: "text", text: outcome.content }],
                details: outcome.details,
                usage: outcome.usage,
            };
        },
    });
}
