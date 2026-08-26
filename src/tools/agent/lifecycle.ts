import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAgentChild } from "./child";
import agentConfig, {
    applyAgentConfig,
    shouldNotifyBusyWorkerChanges,
} from "./config";
import { discoverAgents } from "./definitions/discovery";
import {
    createAgentEventSink,
    emitAgentEvent,
    subscribeAgentEvents,
    type AgentEventSink,
} from "./observability/events";
import { AgentMailbox } from "./presentation/mailbox";
import { loadAgentRunPersistence } from "./runs/persistence";
import { availableAgentsPrompt } from "./definitions/prompt";
import {
    AgentRunManager,
    ZERO_USAGE,
    type AgentRunDetails,
    type AgentRunSummary,
    type ChildAgentFactory,
} from "./runs/manager";
import type { AgentTraceStore } from "./observability/trace";
import type { AgentWorkspace } from "./contracts/workspaces";
import type { WorkspaceSetupUiUpdate } from "./workspaces/setup";
import {
    clearAgentUi,
    clearCompletedWorkspaceSetupRun,
    diagnosticText,
    updateAgentUi,
} from "./presentation/widget";

export type WorkspaceEventAction = "created" | "updated" | "lease_changed" | "result_changed" | "removed";

export class AgentLifecycle {
    readonly events: AgentEventSink;
    readonly eventBus: ExtensionAPI["events"];

    private managerValue: AgentRunManager;
    private cachedAgentPrompt = "";
    private activeContext: ExtensionContext | undefined;
    private readonly setupRuns = new Map<string, AgentRunSummary>();
    private readonly mailbox: AgentMailbox;
    private mailboxFlushScheduled = false;
    private readonly notifiedMutationFiles = new Map<string, Set<string>>();
    private readonly notifiedWarnings = new Set<string>();
    private unsubscribeAgentUiEvents: () => void = () => {};
    readonly factory: ChildAgentFactory;

    constructor(
        private readonly pi: ExtensionAPI,
        factory: ChildAgentFactory = createAgentChild,
        private readonly traceStore?: AgentTraceStore,
    ) {
        this.eventBus = pi.events;
        this.factory = (context) => factory({ ...context, events: pi.events });
        this.events = createAgentEventSink(pi.events);
        this.managerValue = this.createManager();
        this.mailbox = new AgentMailbox(pi);
        this.unsubscribeAgentUiEvents = subscribeAgentEvents(pi.events, (event) => {
            if (!this.activeContext || this.activeContext.cwd !== event.cwd) return;
            this.refreshAgentUi(this.activeContext);
        });
    }

    get manager(): AgentRunManager {
        return this.managerValue;
    }

    get setupRunSummaries(): AgentRunSummary[] {
        return [...this.setupRuns.values()];
    }

    register(): void {
        this.pi.on("session_start", async (_event, ctx) => {
            this.activeContext = ctx;
            const discovered = this.discover(ctx);
            this.cachedAgentPrompt = availableAgentsPrompt(discovered.agents);
            await this.restoreManager(ctx);
        });

        this.pi.on("agent_settled", () => {
            this.flushMailbox();
        });

        this.pi.on("before_agent_start", (event, ctx) => {
            if (!this.cachedAgentPrompt) {
                this.refreshAgentPrompt(ctx);
            }
            const delegatedStart = event.systemPrompt.indexOf("<delegated_agents>");
            const delegatedEndMarker = "</delegated_agents>";
            const delegatedEnd = event.systemPrompt.indexOf(delegatedEndMarker);
            if (delegatedStart !== -1 && delegatedEnd !== -1 && delegatedEnd > delegatedStart) {
                const systemPrompt = event.systemPrompt.slice(0, delegatedStart)
                    + this.cachedAgentPrompt
                    + event.systemPrompt.slice(delegatedEnd + delegatedEndMarker.length);
                return { systemPrompt };
            }
            const projectContextEnd = "</project_context>";
            const idx = event.systemPrompt.indexOf(projectContextEnd);
            const systemPrompt = idx === -1
                ? `${event.systemPrompt}\n\n${this.cachedAgentPrompt}`
                : event.systemPrompt.slice(0, idx + projectContextEnd.length)
                    + "\n\n"
                    + this.cachedAgentPrompt
                    + "\n"
                    + event.systemPrompt.slice(idx + projectContextEnd.length);
            return { systemPrompt };
        });

        this.pi.on("session_before_tree", (_event, ctx) => {
            const unsafe = this.manager.listRuns().some((run) => (
                run.status === "starting" || run.status === "running" || run.status === "waiting_for_permission"
            )) || this.setupRunSummaries.some((run) => (
                run.status === "starting"
                || run.status === "running"
                || run.status === "waiting_for_permission"
            ));
            if (!unsafe) return;
            ctx.ui.notify("Pause, finish, or cancel running delegated agents before navigating the session tree.", "warning");
            return { cancel: true };
        });

        this.pi.on("session_tree", async (_event, ctx) => {
            this.activeContext = ctx;
            this.mailbox.clear();
            this.notifiedMutationFiles.clear();
            // Drain old-branch writes before detaching persistence. Shutdown must not
            // append records at the newly selected branch leaf.
            await this.manager.flushPersistence();
            this.manager.closePersistence();
            this.manager.setPersistence(undefined);
            await this.manager.shutdown();
            emitAgentEvent(this.events, ctx.cwd, { type: "runtime", action: "reset" });
            this.setupRuns.clear();
            clearAgentUi(ctx, this.pi.events);
            this.managerValue = this.createManager();
            const discovered = this.discover(ctx);
            this.cachedAgentPrompt = availableAgentsPrompt(discovered.agents);
            await this.restoreManager(ctx);
        });

        this.pi.on("session_shutdown", async (_event, ctx) => {
            this.mailbox.close();
            this.notifiedMutationFiles.clear();
            this.setupRuns.clear();
            clearAgentUi(ctx, this.pi.events);
            await this.manager.shutdown();
            await this.manager.flushPersistence();
            this.manager.closePersistence();
            emitAgentEvent(this.events, ctx.cwd, { type: "runtime", action: "shutdown" });
            this.activeContext = undefined;
            this.unsubscribeAgentUiEvents();
        });

        this.pi.on("tool_result", (event) => {
            if (event.toolName !== "agent") return;
            const details = event.details as Partial<AgentRunDetails> | undefined;
            if (details?.status === "failed" || details?.status === "aborted") {
                return { isError: true };
            }
        });
    }

    discover(ctx: ExtensionContext): ReturnType<typeof discoverAgents> {
        const result = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
        result.agents = applyAgentConfig(result.agents, agentConfig.load(ctx.cwd));
        for (const diagnostic of result.diagnostics) {
            if (diagnostic.level !== "warning") continue;
            const text = diagnosticText(diagnostic);
            if (this.notifiedWarnings.has(text)) continue;
            this.notifiedWarnings.add(text);
            ctx.ui.notify(`pi-coder agents: ${text}`, "warning");
        }
        return result;
    }

    refreshAgentPrompt(ctx: ExtensionContext): void {
        const discovered = this.discover(ctx);
        this.cachedAgentPrompt = availableAgentsPrompt(discovered.agents);
    }

    refreshAgentUi(ctx: ExtensionContext): void {
        updateAgentUi(ctx, this.manager, this.setupRunSummaries, this.pi.events);
    }

    emitWorkspaceEvent(
        ctx: ExtensionContext,
        workspaceId: string,
        action: WorkspaceEventAction,
        reason?: string,
    ): void {
        emitAgentEvent(this.events, ctx.cwd, {
            type: "workspace",
            action,
            workspaceId,
            reason,
        });
    }

    updateSetupRun(
        ctx: ExtensionContext,
        runId: string,
        workspace: AgentWorkspace,
        update: WorkspaceSetupUiUpdate,
    ): void {
        const previous = this.setupRuns.get(runId);
        const now = Date.now();
        this.setupRuns.set(runId, {
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
        this.refreshAgentUi(ctx);
    }

    clearCompletedWorkspaceSetup(ctx: ExtensionContext, details: AgentRunDetails): void {
        if (clearCompletedWorkspaceSetupRun(this.setupRuns, details)) {
            this.refreshAgentUi(ctx);
        }
    }

    backgroundUpdate(ctx: ExtensionContext): (details: AgentRunDetails) => void {
        return (details) => {
            if (
                details.status === "completed"
                || details.status === "failed"
                || details.status === "aborted"
                || details.status === "canceled"
            ) {
                this.clearCompletedWorkspaceSetup(ctx, details);
            }
            this.refreshAgentUi(ctx);
            if (
                details.background
                && details.mutating
                && details.workspaceId === undefined
                && shouldNotifyBusyWorkerChanges(agentConfig.get(ctx.cwd))
            ) {
                const changedFiles = details.mutationReport?.changedFiles ?? [];
                const notified = this.notifiedMutationFiles.get(details.runId) ?? new Set<string>();
                const newChangedFiles = changedFiles.filter((filePath) => !notified.has(filePath));
                if (newChangedFiles.length) {
                    for (const filePath of newChangedFiles) notified.add(filePath);
                    this.notifiedMutationFiles.set(details.runId, notified);
                    this.mailbox.notifyMutation(details, newChangedFiles, !this.isParentIdle(ctx));
                }
            }
            this.mailbox.queue(details);
            this.reconcileMailbox();
            this.flushMailboxWhenIdle(ctx);
        };
    }

    notifyUserCanceled(details: AgentRunDetails): void {
        this.mailbox.notifyUserCanceled(details);
    }

    reconcileMailbox(): void {
        const runs = this.manager.listRuns();
        this.mailbox.reconcile(runs);
        const runIds = new Set(runs.map((run) => run.runId));
        for (const runId of this.notifiedMutationFiles.keys()) {
            if (!runIds.has(runId)) this.notifiedMutationFiles.delete(runId);
        }
    }

    private createManager(): AgentRunManager {
        return new AgentRunManager(this.factory, 4, this.traceStore, 20, this.events);
    }

    private flushMailbox(): void {
        this.reconcileMailbox();
        this.mailbox.flush();
    }

    private isParentIdle(ctx: ExtensionContext): boolean {
        try {
            return ctx.isIdle();
        } catch {
            return false;
        }
    }

    private flushMailboxWhenIdle(ctx: ExtensionContext): void {
        if (this.mailboxFlushScheduled || !this.isParentIdle(ctx)) return;
        this.mailboxFlushScheduled = true;
        queueMicrotask(() => {
            this.mailboxFlushScheduled = false;
            if (this.isParentIdle(ctx)) this.flushMailbox();
        });
    }

    private async restoreManager(ctx: ExtensionContext): Promise<void> {
        let loaded: Awaited<ReturnType<typeof loadAgentRunPersistence>>;
        try {
            loaded = await loadAgentRunPersistence(ctx);
        } catch (error) {
            this.manager.setPersistence(undefined);
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`pi-coder agents: durable child storage is unavailable: ${message}`, "warning");
            return;
        }
        this.manager.setPersistence(loaded?.persistence);
        if (!loaded) return;
        for (const diagnostic of loaded.diagnostics ?? []) {
            ctx.ui.notify(`pi-coder agents: ${diagnostic}`, "warning");
        }
        const discovered = this.discover(ctx);
        const result = await this.manager.restore(
            loaded.records,
            discovered.agents,
            { cwd: ctx.cwd, parentContext: ctx },
            this.backgroundUpdate(ctx),
        );
        for (const diagnostic of result.diagnostics) {
            ctx.ui.notify(`pi-coder agents: ${diagnostic}`, "warning");
        }
        if (result.restored > 0) {
            ctx.ui.notify(
                `Restored ${result.restored} delegated agent run${result.restored === 1 ? "" : "s"}.`,
                "info",
            );
        }
        this.refreshAgentUi(ctx);
        emitAgentEvent(this.events, ctx.cwd, { type: "runtime", action: "restored" });
        this.reconcileMailbox();
        await this.manager.flushPersistence();
    }
}
