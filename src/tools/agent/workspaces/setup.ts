import { randomUUID } from "node:crypto";

import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { selectWithMessage } from "../../../tui/select-with-message";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import { AgentActionError, AgentRunManager } from "../runs/manager";
import type { AgentRunSummary, ChildAgentFactory } from "../contracts/runs";
import type { AgentWorkspace } from "../contracts/workspaces";
import type { AgentDefinition } from "../definitions/types";
import {
    claimAgentWorkspace,
    findAvailableAgentWorkspace,
    findUnpreparedAgentWorkspace,
    listAgentWorkspaces,
    MAX_AGENT_WORKSPACES,
    releaseAgentWorkspaceLease,
    transferAgentWorkspaceLease,
} from "./store";
import { createAgentWorkspace, updateAgentWorkspace } from "./lifecycle";
import { reconcileNoChangeAgentWorkspaceLeases } from "./results";

export type WorkspacePromptChoice = "setup" | "skip" | "cancel";

export type WorkspaceSetupUiUpdate = Pick<AgentRunSummary, "status"> & Partial<Pick<
    AgentRunSummary,
    "activity" | "responsePreview" | "usage"
>>;

export type WorkspaceSetupUiCallback = (
    runId: string,
    workspace: AgentWorkspace,
    update: WorkspaceSetupUiUpdate,
) => void;

export async function runWorkspaceSetup(
    workspace: AgentWorkspace,
    definition: AgentDefinition,
    factory: ChildAgentFactory,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    setupRunId: string,
    onUiUpdate?: WorkspaceSetupUiCallback,
    events?: AgentEventSink,
): Promise<AgentWorkspace> {
    await updateAgentWorkspace(workspace, { setupState: "running" });
    emitAgentEvent(events, ctx.cwd, {
        type: "workspace",
        action: "updated",
        workspaceId: workspace.id,
        reason: "setup_started",
    });
    onUiUpdate?.(setupRunId, workspace, {
        status: "starting",
        activity: "Starting workspace setup",
    });
    ctx.ui.notify(`Preparing isolated workspace ${workspace.slug}…`, "info");
    const setupDefinition: AgentDefinition = {
        name: "workspace-setup",
        description: "Prepare an isolated development workspace without implementing the task",
        capabilities: [],
        model: definition.model,
        source: "builtin",
        mutating: true,
        systemPrompt: `You are the isolated workspace setup specialist for a later implementation worker.

Your job is to prepare the development environment inside this isolated worktree. You are allowed and expected to install dependencies, create project-local environments, update dependency lockfiles, configure setup files, and generate project-local setup artifacts when needed. Use bash commands only inside this worktree; every command requires explicit parent approval, must be non-interactive, and should use a suitable timeout. Run setup commands one at a time and report a missing prerequisite instead of waiting for interactive input.

Do not implement the requested feature, edit unrelated source files, or make unrelated configuration changes. Keep changes limited to dependencies, environment configuration, and generated artifacts required for the later worker. When setup is complete, report the commands run, files or environment artifacts changed, remaining prerequisites, and how the later worker should validate its work.`,
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
            isolated: true,
            onProgress: (progress) => {
                emitAgentEvent(events, ctx.cwd, {
                    type: "workspace",
                    action: "updated",
                    workspaceId: workspace.id,
                    reason: "setup_progress",
                });
                onUiUpdate?.(setupRunId, workspace, {
                    status: progress.permissionPending ? "waiting_for_permission" : "running",
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
                "Prepare this isolated workspace for the later implementation worker. Inspect the project configuration, then install or configure whatever project-local dependencies and environment artifacts are needed. Use only non-interactive bash commands inside this worktree, one command at a time with a suitable timeout; every command will require explicit approval. Do not implement the requested feature or make unrelated source changes. If setup needs unavailable credentials, interactive input, or a missing prerequisite, report it instead of waiting. Stop with a concise setup report."
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
        const readyWorkspace = await updateAgentWorkspace(workspace, {
            setupState: "ready",
            setupSummary: summary,
        });
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "updated",
            workspaceId: readyWorkspace.id,
            reason: "setup_completed",
        });
        onUiUpdate?.(setupRunId, readyWorkspace, {
            status: "completed",
            activity: "Setup complete",
            responsePreview: summary,
            usage: handle.getUsage(),
        });
        return readyWorkspace;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUiUpdate?.(setupRunId, workspace, {
            status: "failed",
            activity: "Setup failed",
            responsePreview: message,
        });
        const failedWorkspace = await updateAgentWorkspace(workspace, { setupState: "failed", setupSummary: message });
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "updated",
            workspaceId: failedWorkspace.id,
            reason: "setup_failed",
        });
        throw error;
    } finally {
        handle?.dispose();
    }
}

export interface WorkspaceReservation {
    workspace: AgentWorkspace;
    ownerSessionId: string;
    provisionalLeaseRunId: string;
    provisionalLeaseRunInstanceId: string;
}

export async function prepareIsolatedWorkspace(
    cwd: string,
    definition: AgentDefinition,
    factory: ChildAgentFactory,
    manager: AgentRunManager,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUiUpdate?: WorkspaceSetupUiCallback,
    events?: AgentEventSink,
    dialogEvents?: EventBus,
): Promise<WorkspaceReservation> {
    if (!definition.mutating) {
        throw new AgentActionError("Worktree isolation is currently available only for the mutation-capable worker.");
    }
    if (manager.hasActiveNonIsolatedMutatingRun) {
        throw new AgentActionError("A same-checkout mutation-capable worker is already active.");
    }

    const ownerSessionId = ctx.sessionManager.getSessionId();
    const provisionalLeaseRunId = `workspace-provision-${randomUUID()}`;
    const provisionalLeaseRunInstanceId = randomUUID();
    const released = await reconcileNoChangeAgentWorkspaceLeases(cwd);
    if (released > 0) {
        emitAgentEvent(events, cwd, {
            type: "runtime",
            action: "reconciled",
            released,
        });
    }
    const available = await findAvailableAgentWorkspace(cwd);
    if (available) {
        const workspace = await claimAgentWorkspace(
            available.id,
            ownerSessionId,
            provisionalLeaseRunId,
            "task",
            undefined,
            provisionalLeaseRunInstanceId,
        );
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "lease_changed",
            workspaceId: workspace.id,
            reason: "claimed",
        });
        return { workspace, ownerSessionId, provisionalLeaseRunId, provisionalLeaseRunInstanceId };
    }

    const existing = await findUnpreparedAgentWorkspace(cwd);
    if (!existing) {
        const workspaces = await listAgentWorkspaces(cwd);
        if (workspaces.length >= MAX_AGENT_WORKSPACES) {
            const summary = workspaces.map((workspace) => {
                const lease = workspace.leaseRunId ? `leased by ${workspace.leaseRunId}` : workspace.status;
                return `${workspace.slug} (${workspace.setupState}, ${lease})`;
            }).join(", ");
            throw new AgentActionError(
                `Workspace capacity reached (${MAX_AGENT_WORKSPACES}) for this project. Existing workspaces: ${summary}. Explicitly apply, retain, reset, or discard one before creating another.`,
            );
        }
    }
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
    }, { ...ctx, events: dialogEvents }, signal);
    const choice = prompt?.value;
    if (!choice || choice === "cancel") {
        const message = prompt?.message?.trim();
        throw new AgentActionError(
            `Isolated worker canceled before workspace setup.${message ? ` User message: ${message}` : ""}`,
        );
    }

    const workspace = existing ?? await createAgentWorkspace(cwd);
    if (!existing) {
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "created",
            workspaceId: workspace.id,
        });
    }
    const leaseKind = choice === "setup" ? "setup" : "task";
    try {
        const claimed = await claimAgentWorkspace(
            workspace.id,
            ownerSessionId,
            provisionalLeaseRunId,
            leaseKind,
            undefined,
            provisionalLeaseRunInstanceId,
        );
        emitAgentEvent(events, ctx.cwd, {
            type: "workspace",
            action: "lease_changed",
            workspaceId: claimed.id,
            reason: "claimed",
        });
        if (choice === "setup") {
            await runWorkspaceSetup(
                claimed,
                definition,
                factory,
                ctx,
                signal,
                provisionalLeaseRunId,
                onUiUpdate,
                events,
            );
        }
        else {
            const skipped = await updateAgentWorkspace(claimed, { setupState: "skipped" });
            emitAgentEvent(events, ctx.cwd, {
                type: "workspace",
                action: "updated",
                workspaceId: skipped.id,
                reason: "setup_skipped",
            });
        }
        return {
            workspace: claimed,
            ownerSessionId,
            provisionalLeaseRunId,
            provisionalLeaseRunInstanceId,
        };
    } catch (error) {
        try {
            await releaseAgentWorkspaceLease(
                workspace.id,
                ownerSessionId,
                provisionalLeaseRunId,
                undefined,
                provisionalLeaseRunInstanceId,
            );
            emitAgentEvent(events, ctx.cwd, {
                type: "workspace",
                action: "lease_changed",
                workspaceId: workspace.id,
                reason: "claim_rolled_back",
            });
        } catch {
            // Preserve the original setup error; an uncertain lease remains
            // protected for explicit recovery.
        }
        throw error;
    }
}
