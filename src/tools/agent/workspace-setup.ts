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
