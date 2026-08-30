import { randomUUID } from "node:crypto";

import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { selectWithMessage } from "../../../tui/select-with-message";
import { emitAgentEvent } from "../observability/events";
import type { AgentEventSink } from "../contracts/events";
import { AgentActionError, AgentRunManager } from "../runs/manager";
import type { AgentRunSummary, ChildAgentFactory } from "../contracts/runs";
import type { AgentWorkspace } from "../contracts/workspaces";
import { agentCanEdit, type AgentDefinition } from "../definitions/types";
import {
    claimAgentWorkspace,
    findAvailableAgentWorkspace,
    findUnpreparedAgentWorkspace,
    listAgentWorkspaces,
    MAX_AGENT_WORKSPACES,
    releaseAgentWorkspaceLease,
    getAgentWorkspace,
    transferAgentWorkspaceLease,
} from "./store";
import {
    createAgentWorkspace,
    recycleAgentWorkspaceForReuse,
    updateAgentWorkspace,
} from "./lifecycle";
import { reconcileNoChangeAgentWorkspaceLeases } from "./results";
import { latestAgentWorkspaceCheckpoint } from "./checkpoints";
import { git } from "./git";

export type WorkspacePromptChoice = "setup" | "skip" | "cancel";

export type WorkspaceSetupUiUpdate = Pick<AgentRunSummary, "status"> &
    Partial<Pick<AgentRunSummary, "activity" | "responsePreview" | "usage">>;

export type WorkspaceSetupUiCallback = (
    runId: string,
    workspace: AgentWorkspace,
    update: WorkspaceSetupUiUpdate,
) => void;

/** Named setup dependencies and UI/event controls for an isolated workspace. */
export interface WorkspaceSetupOptions {
    definition: AgentDefinition;
    factory: ChildAgentFactory;
    ctx: ExtensionContext;
    signal?: AbortSignal;
    setupRunId: string;
    onUiUpdate?: WorkspaceSetupUiCallback;
    events?: AgentEventSink;
    workspacesDir?: string;
}

export async function runWorkspaceSetup(
    workspace: AgentWorkspace,
    {
        definition,
        factory,
        ctx,
        signal,
        setupRunId,
        onUiUpdate,
        events,
        workspacesDir,
    }: WorkspaceSetupOptions,
): Promise<AgentWorkspace> {
    const workspaceOptions = workspacesDir ? { workspacesDir } : {};
    await updateAgentWorkspace(workspace, { setupState: "running" }, workspaceOptions);
    emitAgentEvent(
        {
            type: "workspace",
            action: "updated",
            workspaceId: workspace.id,
            reason: "setup_started",
        },
        { sink: events, cwd: ctx.cwd },
    );
    onUiUpdate?.(setupRunId, workspace, {
        status: "starting",
        activity: "Starting workspace setup",
    });
    ctx.ui.notify(`Preparing isolated workspace ${workspace.slug}…`, "info");
    const setupDefinition: AgentDefinition = {
        name: "workspace-setup",
        description: "Prepare an isolated development workspace without implementing the task",
        capabilities: ["read", "search", "command-runner"],
        model: definition.model,
        source: "builtin",
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
                emitAgentEvent(
                    {
                        type: "workspace",
                        action: "updated",
                        workspaceId: workspace.id,
                        reason: "setup_progress",
                    },
                    { sink: events, cwd: ctx.cwd },
                );
                onUiUpdate?.(setupRunId, workspace, {
                    status: progress.permissionPending ? "waiting_for_permission" : "running",
                    activity:
                        progress.recentActivity[progress.recentActivity.length - 1] ??
                        "Preparing workspace",
                    responsePreview: progress.output,
                });
            },
        });
        onUiUpdate?.(setupRunId, workspace, {
            status: "running",
            activity: "Preparing workspace",
        });
        const abortSetup = () => {
            void handle?.abort();
        };
        signal?.addEventListener("abort", abortSetup, { once: true });
        try {
            await handle.prompt(
                "Prepare this isolated workspace for the later implementation worker. Inspect the project configuration, then install or configure whatever project-local dependencies and environment artifacts are needed. Use only non-interactive bash commands inside this worktree, one command at a time with a suitable timeout; every command will require explicit approval. Do not implement the requested feature or make unrelated source changes. If setup needs unavailable credentials, interactive input, or a missing prerequisite, report it instead of waiting. Stop with a concise setup report.",
            );
        } finally {
            signal?.removeEventListener("abort", abortSetup);
        }
        const question = handle.takeParentQuestion();
        if (question)
            throw new AgentActionError(`Workspace setup requested guidance: ${question.question}`);
        const error = handle.getError();
        if (error) throw new AgentActionError(`Workspace setup failed: ${error}`);
        const summary = handle.getFinalOutput().trim();
        if (!summary)
            throw new AgentActionError("Workspace setup completed without a setup report.");
        const readyWorkspace = await updateAgentWorkspace(
            workspace,
            {
                setupState: "ready",
                setupSummary: summary,
            },
            workspaceOptions,
        );
        emitAgentEvent(
            {
                type: "workspace",
                action: "updated",
                workspaceId: readyWorkspace.id,
                reason: "setup_completed",
            },
            { sink: events, cwd: ctx.cwd },
        );
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
        const failedWorkspace = await updateAgentWorkspace(
            workspace,
            { setupState: "failed", setupSummary: message },
            workspaceOptions,
        );
        emitAgentEvent(
            {
                type: "workspace",
                action: "updated",
                workspaceId: failedWorkspace.id,
                reason: "setup_failed",
            },
            { sink: events, cwd: ctx.cwd },
        );
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

export interface ManualWorkspaceCreationOptions extends Omit<
    PrepareIsolatedWorkspaceOptions,
    "manager"
> {}

/** Create a workspace from the browser and optionally run its setup worker. */
export async function createAgentWorkspaceManually(
    cwd: string,
    {
        definition,
        factory,
        ctx,
        signal,
        onUiUpdate,
        events,
        dialogEvents,
        workspacesDir,
        maxWorkspaces,
    }: ManualWorkspaceCreationOptions,
): Promise<AgentWorkspace | undefined> {
    if (!agentCanEdit(definition)) {
        throw new AgentActionError(
            "Workspace setup is currently available only for the mutation-capable worker.",
        );
    }
    if (signal?.aborted) return undefined;

    const prompt = await selectWithMessage<WorkspacePromptChoice>(
        {
            title: "Create isolated workspace?",
            contentLines: [
                "A detached Git worktree will be created under pi-coder's .state/workspaces directory.",
                "Choose whether a limited setup worker should prepare it before the task worker starts.",
            ],
            items: [
                {
                    value: "setup",
                    label: "Create and run setup worker",
                    description:
                        "Prepare dependencies and project tooling before the task worker starts.",
                },
                {
                    value: "skip",
                    label: "Create and skip setup",
                    description: "Create the worktree without a setup pass.",
                },
                {
                    value: "cancel",
                    label: "Cancel",
                    description: "Do not create the isolated workspace.",
                },
            ],
            selectHelpText: "↑/↓ choose · Enter confirm · Esc cancel",
        },
        { ...ctx, events: dialogEvents },
        signal,
    );
    const choice = prompt?.value;
    if (!choice || choice === "cancel") return undefined;

    const workspaceOptions = {
        ...(workspacesDir ? { workspacesDir } : {}),
        ...(maxWorkspaces !== undefined ? { maxWorkspaces } : {}),
        // Manual creation intentionally skips the dirty-parent check and
        // snapshots the current committed HEAD instead.
        skipParentDirtyCheck: true,
    };
    const workspace = await createAgentWorkspace(cwd, workspaceOptions);
    emitAgentEvent(
        {
            type: "workspace",
            action: "created",
            workspaceId: workspace.id,
        },
        { sink: events, cwd: ctx.cwd },
    );

    if (choice === "skip") {
        return await updateAgentWorkspace(workspace, { setupState: "skipped" }, workspaceOptions);
    }

    const ownerSessionId = ctx.sessionManager.getSessionId();
    const setupRunId = `workspace-setup-${workspace.slug}-${randomUUID()}`;
    const setupRunInstanceId = randomUUID();
    const claimed = await claimAgentWorkspace(workspace.id, {
        ownerSessionId,
        leaseRunId: setupRunId,
        leaseRunInstanceId: setupRunInstanceId,
        leaseKind: "setup",
        ...workspaceOptions,
    });
    emitAgentEvent(
        {
            type: "workspace",
            action: "lease_changed",
            workspaceId: claimed.id,
            reason: "setup_claimed",
        },
        { sink: events, cwd: ctx.cwd },
    );
    let prepared: AgentWorkspace;
    try {
        prepared = await runWorkspaceSetup(claimed, {
            definition,
            factory,
            ctx,
            signal,
            setupRunId,
            onUiUpdate,
            events,
            workspacesDir,
        });
    } finally {
        await releaseAgentWorkspaceLease(workspace.id, {
            ownerSessionId,
            leaseRunId: setupRunId,
            leaseRunInstanceId: setupRunInstanceId,
            workspacesDir,
        });
        emitAgentEvent(
            {
                type: "workspace",
                action: "lease_changed",
                workspaceId: workspace.id,
                reason: "setup_released",
            },
            { sink: events, cwd: ctx.cwd },
        );
    }
    return (await getAgentWorkspace(workspace.id, { workspacesDir })) ?? prepared;
}

/** Named dependencies and UI/event controls for isolated workspace preparation. */
async function findRecyclableAgentWorkspace(
    cwd: string,
    manager: AgentRunManager,
    workspacesDir?: string,
): Promise<AgentWorkspace | undefined> {
    const options = workspacesDir ? { workspacesDir } : {};
    const candidates = (await listAgentWorkspaces(cwd, options))
        .filter((workspace) => {
            const localStatus = workspace.leaseRunId
                ? manager.getRunStatus(workspace.leaseRunId)
                : undefined;
            const locallyParkable =
                localStatus === "waiting_for_parent" ||
                localStatus === "interrupted" ||
                localStatus === "completed" ||
                localStatus === "failed" ||
                localStatus === "aborted" ||
                localStatus === "canceled";
            return (
                (workspace.setupState === "ready" || workspace.setupState === "skipped") &&
                workspace.leaseKind === "task" &&
                workspace.leaseOwnerSessionId &&
                workspace.leaseRunId &&
                workspace.leaseRunInstanceId &&
                (workspace.leaseActive !== true || locallyParkable) &&
                workspace.status !== "recycling"
            );
        })
        .sort((left, right) => left.updatedAt - right.updatedAt);

    for (const workspace of candidates) {
        const checkpoint = await latestAgentWorkspaceCheckpoint(
            workspace.id,
            workspace.leaseRunInstanceId!,
            options,
        );
        if (
            !checkpoint ||
            ![
                "waiting_for_parent",
                "interrupted",
                "completed",
                "failed",
                "aborted",
                "canceled",
            ].includes(checkpoint.runStatus)
        )
            continue;
        if (
            checkpoint.runStatus !== "waiting_for_parent" &&
            checkpoint.runStatus !== "interrupted"
        ) {
            const result = workspace.latestResult;
            if (
                !result ||
                result.runId !== workspace.leaseRunId ||
                (result.runInstanceId !== undefined &&
                    result.runInstanceId !== workspace.leaseRunInstanceId) ||
                result.status !== "prepared"
            )
                continue;
        }
        try {
            const head = await git(workspace.repositoryRoot, ["rev-parse", checkpoint.durableRef]);
            if (head !== checkpoint.headRevision) continue;
            const parked = await manager.parkWorkspaceRunForReuse(
                workspace.id,
                workspace.leaseRunId!,
            );
            if (!parked && manager.getRunStatus(workspace.leaseRunId!) !== undefined) continue;
            return workspace;
        } catch {
            // A missing or invalid checkpoint cannot safely authorize reuse.
        }
    }
    return undefined;
}

export interface PrepareIsolatedWorkspaceOptions {
    definition: AgentDefinition;
    factory: ChildAgentFactory;
    manager: AgentRunManager;
    ctx: ExtensionContext;
    signal?: AbortSignal;
    onUiUpdate?: WorkspaceSetupUiCallback;
    events?: AgentEventSink;
    dialogEvents?: EventBus;
    workspacesDir?: string;
    maxWorkspaces?: number;
}

export async function prepareIsolatedWorkspace(
    cwd: string,
    {
        definition,
        factory,
        manager,
        ctx,
        signal,
        onUiUpdate,
        events,
        dialogEvents,
        workspacesDir,
        maxWorkspaces,
    }: PrepareIsolatedWorkspaceOptions,
): Promise<WorkspaceReservation> {
    if (!agentCanEdit(definition)) {
        throw new AgentActionError(
            "Worktree isolation is currently available only for the mutation-capable worker.",
        );
    }
    if (manager.hasActiveNonIsolatedMutatingRun) {
        throw new AgentActionError("A same-checkout mutation-capable worker is already active.");
    }

    // TODO(workspace-sharing): replace this conservative guard with a parent
    // working-tree snapshot/materialization strategy so isolated work can see
    // intentional uncommitted parent changes.
    const parentStatus = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (parentStatus) {
        throw new AgentActionError(
            "Cannot start an isolated worker while the parent checkout has uncommitted changes.",
        );
    }

    const ownerSessionId = ctx.sessionManager.getSessionId();
    const provisionalLeaseRunId = `workspace-provision-${randomUUID()}`;
    const provisionalLeaseRunInstanceId = randomUUID();
    const workspaceOptions = {
        ...(workspacesDir ? { workspacesDir } : {}),
        ...(maxWorkspaces !== undefined ? { maxWorkspaces } : {}),
    };
    const released = await reconcileNoChangeAgentWorkspaceLeases(cwd, workspaceOptions);
    if (released > 0) {
        emitAgentEvent(
            {
                type: "runtime",
                action: "reconciled",
                released,
            },
            { sink: events, cwd },
        );
    }
    const available = await findAvailableAgentWorkspace(cwd, workspaceOptions);
    if (available) {
        const workspace = await claimAgentWorkspace(available.id, {
            ownerSessionId,
            leaseRunId: provisionalLeaseRunId,
            leaseKind: "task",
            leaseRunInstanceId: provisionalLeaseRunInstanceId,
            ...workspaceOptions,
        });
        emitAgentEvent(
            {
                type: "workspace",
                action: "lease_changed",
                workspaceId: workspace.id,
                reason: "claimed",
            },
            { sink: events, cwd: ctx.cwd },
        );
        return { workspace, ownerSessionId, provisionalLeaseRunId, provisionalLeaseRunInstanceId };
    }

    const recyclable = await findRecyclableAgentWorkspace(cwd, manager, workspacesDir);
    if (recyclable) {
        const recycled = await recycleAgentWorkspaceForReuse(recyclable.id, {
            previousOwnerSessionId: recyclable.leaseOwnerSessionId!,
            previousLeaseRunId: recyclable.leaseRunId!,
            previousLeaseRunInstanceId: recyclable.leaseRunInstanceId!,
            ownerSessionId,
            leaseRunId: provisionalLeaseRunId,
            leaseRunInstanceId: provisionalLeaseRunInstanceId,
            ...(workspacesDir ? { workspacesDir } : {}),
        });
        emitAgentEvent(
            {
                type: "workspace",
                action: "lease_changed",
                workspaceId: recycled.id,
                reason: "recycled",
            },
            { sink: events, cwd: ctx.cwd },
        );
        return {
            workspace: recycled,
            ownerSessionId,
            provisionalLeaseRunId,
            provisionalLeaseRunInstanceId,
        };
    }

    const existing = await findUnpreparedAgentWorkspace(cwd, workspaceOptions);
    if (!existing) {
        const workspaces = await listAgentWorkspaces(cwd, workspaceOptions);
        const capacity =
            Number.isInteger(maxWorkspaces) && maxWorkspaces !== undefined && maxWorkspaces > 0
                ? maxWorkspaces
                : MAX_AGENT_WORKSPACES;
        if (workspaces.length >= capacity) {
            const summary = workspaces
                .map((workspace) => {
                    const lease = workspace.leaseRunId
                        ? `leased by ${workspace.leaseRunId}`
                        : workspace.status;
                    return `${workspace.slug} (${workspace.setupState}, ${lease})`;
                })
                .join(", ");
            throw new AgentActionError(
                `Workspace capacity reached (${capacity}) for this repository. Existing workspaces: ${summary}. Explicitly apply, retain, reset, or discard one before creating another.`,
            );
        }
    }
    const prompt = await selectWithMessage<WorkspacePromptChoice>(
        {
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
                    description:
                        "Prepare dependencies and project tooling before the task worker starts.",
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
        },
        { ...ctx, events: dialogEvents },
        signal,
    );
    const choice = prompt?.value;
    if (!choice || choice === "cancel") {
        const message = prompt?.message?.trim();
        throw new AgentActionError(
            `Isolated worker canceled before workspace setup.${message ? ` User message: ${message}` : ""}`,
        );
    }

    const workspace = existing ?? (await createAgentWorkspace(cwd, workspaceOptions));
    if (!existing) {
        emitAgentEvent(
            {
                type: "workspace",
                action: "created",
                workspaceId: workspace.id,
            },
            { sink: events, cwd: ctx.cwd },
        );
    }
    const leaseKind = choice === "setup" ? "setup" : "task";
    try {
        const claimed = await claimAgentWorkspace(workspace.id, {
            ownerSessionId,
            leaseRunId: provisionalLeaseRunId,
            leaseKind,
            leaseRunInstanceId: provisionalLeaseRunInstanceId,
            ...workspaceOptions,
        });
        emitAgentEvent(
            {
                type: "workspace",
                action: "lease_changed",
                workspaceId: claimed.id,
                reason: "claimed",
            },
            { sink: events, cwd: ctx.cwd },
        );
        if (choice === "setup") {
            await runWorkspaceSetup(claimed, {
                definition,
                factory,
                ctx,
                signal,
                setupRunId: provisionalLeaseRunId,
                onUiUpdate,
                events,
                workspacesDir,
            });
        } else {
            const skipped = await updateAgentWorkspace(
                claimed,
                { setupState: "skipped" },
                workspaceOptions,
            );
            emitAgentEvent(
                {
                    type: "workspace",
                    action: "updated",
                    workspaceId: skipped.id,
                    reason: "setup_skipped",
                },
                { sink: events, cwd: ctx.cwd },
            );
        }
        return {
            workspace: claimed,
            ownerSessionId,
            provisionalLeaseRunId,
            provisionalLeaseRunInstanceId,
        };
    } catch (error) {
        try {
            await releaseAgentWorkspaceLease(workspace.id, {
                ownerSessionId,
                leaseRunId: provisionalLeaseRunId,
                leaseRunInstanceId: provisionalLeaseRunInstanceId,
                ...workspaceOptions,
            });
            emitAgentEvent(
                {
                    type: "workspace",
                    action: "lease_changed",
                    workspaceId: workspace.id,
                    reason: "claim_rolled_back",
                },
                { sink: events, cwd: ctx.cwd },
            );
        } catch {
            // Preserve the original setup error; an uncertain lease remains
            // protected for explicit recovery.
        }
        throw error;
    }
}
