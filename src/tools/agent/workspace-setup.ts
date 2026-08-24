import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { selectWithMessage } from "../../tui/select-with-message";
import {
    AgentActionError,
    AgentRunManager,
    type AgentRunSummary,
    type ChildAgentFactory,
} from "./runtime";
import {
    claimAgentWorkspace,
    createAgentWorkspace,
    findAvailableAgentWorkspace,
    findUnpreparedAgentWorkspace,
    listAgentWorkspaces,
    MAX_AGENT_WORKSPACES,
    releaseAgentWorkspaceLease,
    transferAgentWorkspaceLease,
    updateAgentWorkspace,
    type AgentWorkspace,
} from "./workspaces";
import type { AgentDefinition } from "./discovery";

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
        tools: ["read", "bash"],
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

export interface WorkspaceReservation {
    workspace: AgentWorkspace;
    ownerSessionId: string;
    provisionalLeaseRunId: string;
}

export async function prepareIsolatedWorkspace(
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
