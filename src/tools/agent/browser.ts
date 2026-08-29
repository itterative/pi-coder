import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import agentConfig, {
    BUILTIN_AGENT_NAMES,
    isAdvisorEnabled,
    shouldNotifyBusyWorkerChanges,
    type BuiltinAgentName,
} from "./config";
import type { AgentWorkspace } from "./contracts/workspaces";
import { emitAgentEvent } from "./observability/events";
import {
    type AgentSessionBrowserItem,
    type WorkspaceDispositionAction,
    workspaceBrowserItem,
} from "./presentation/browser-models";
import {
    currentAgentSessionItems,
    listAgentPastSessionLists,
    loadAgentSessionTranscriptForItem,
    loadAgentSessionTranscripts,
    removeCurrentAgentTranscripts,
} from "./presentation/sessions";
import { confirm } from "../../tui/confirmation";
import {
    showAgentSessionBrowser,
    type AgentModelOption,
    type AgentSessionBrowserData,
    type AgentSetting,
} from "../../tui/agents";
import type { AgentLifecycle } from "./lifecycle";
import { prepareForegroundWorkspaceResult } from "./workspaces/finalization";
import { inspectAgentWorkspaceResult, reconcileNoChangeAgentWorkspaceLeases } from "./workspaces/results";
import { inspectAgentWorkspaceGitState, listAgentWorkspaces } from "./workspaces/store";
import { handleWorkspaceAction } from "./workspaces/tui-actions";

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function workspaceActionConfirmation(
    action: WorkspaceDispositionAction,
    slug: string,
): { title: string; message: string } {
    switch (action) {
        case "apply":
            return {
                title: "Apply agent changes?",
                message: `Copy every change made by the agent in "${slug}" into your current project. Files in your current project may be added, changed, or removed. The workspace will remain available for review and will not be reused automatically.`,
            };
        case "retain":
            return {
                title: "Keep agent changes?",
                message: `Keep the changes made by the agent in "${slug}" aside for you to review later, without copying them into your current project. The workspace will stay reserved until you reset or delete it.`,
            };
        case "reset":
            return {
                title: "Reset workspace?",
                message: `Permanently remove all changes made in "${slug}", including saved agent results, and restore it to the latest version of your current project. It will then be available for a new task. Your current project will not be changed.`,
            };
        case "discard":
            return {
                title: "Delete workspace?",
                message: `Permanently delete the "${slug}" workspace, including its isolated files and all saved agent changes. This frees a workspace slot. Your current project will not be changed.`,
            };
        case "release":
            return {
                title: "Free workspace?",
                message: `Remove the old lock from "${slug}" without changing or deleting any files. The workspace and its contents will stay as they are and can be used again.`,
            };
        case "recover":
            return {
                title: "Recover workspace?",
                message: `Assign the abandoned workspace "${slug}" to your current session so you can manage its saved result. Nothing will be changed or copied into your current project.`,
            };
    }
}

export function mergeHistoricalAgentSessions(
    allPast: AgentSessionBrowserItem[],
    activeBranchPast: AgentSessionBrowserItem[],
    current: AgentSessionBrowserItem[],
): AgentSessionBrowserItem[] {
    const activeByFile = new Map(
        activeBranchPast
            .filter((item) => item.sessionFile)
            .map((item) => [path.resolve(item.sessionFile!), item]),
    );
    return removeCurrentAgentTranscripts(
        allPast.map((item) => (
            item.sessionFile
                ? activeByFile.get(path.resolve(item.sessionFile)) ?? item
                : item
        )),
        current,
    );
}

function settingLabel(name: BuiltinAgentName): string {
    return `${name[0]!.toUpperCase()}${name.slice(1)} model`;
}

function buildSettings(cwd: string): AgentSetting[] {
    const config = agentConfig.get(cwd);
    return [
        {
            id: "notifyBusyWorkerChanges" as const,
            label: "Busy worker change notifications",
            description: "Get an immediate update when a worker changes your files while the main assistant is still working. Turn this off to receive the update only when the worker finishes.",
            enabled: shouldNotifyBusyWorkerChanges(config),
        },
        {
            id: "advisorEnabled" as const,
            label: "Advisor availability",
            description: "Allow the parent agent to consult the read-only senior advisor. Configure its model separately below.",
            enabled: isAdvisorEnabled(config),
        },
        ...BUILTIN_AGENT_NAMES.map((id) => ({
            id,
            label: settingLabel(id),
            description: `Model used when the built-in ${id} agent runs.`,
            model: config.models?.[id],
        })),
    ];
}

function buildModelOptions(ctx: ExtensionCommandContext, cwd: string): AgentModelOption[] {
    const config = agentConfig.get(cwd);
    const options: AgentModelOption[] = [{
        label: "Parent model",
        description: ctx.model ? `Use ${ctx.model.provider}/${ctx.model.id}` : "Use the current pi model",
    }];
    const models = new Map<string, AgentModelOption>();
    for (const model of ctx.modelRegistry.getAvailable()) {
        const id = `${model.provider}/${model.id}`;
        models.set(id, {
            id,
            label: id,
            description: model.name,
        });
    }
    for (const configured of Object.values(config.models ?? {})) {
        if (configured && !models.has(configured)) {
            models.set(configured, {
                id: configured,
                label: configured,
                description: "Configured model is not currently available",
            });
        }
    }
    options.push(...[...models.values()].sort((left, right) => left.label.localeCompare(right.label)));
    return options;
}

export function registerAgentBrowser(pi: ExtensionAPI, lifecycle: AgentLifecycle): void {
    const showAgentBrowser = async (_args: string, ctx: ExtensionCommandContext) => {
        const currentSessionId = ctx.sessionManager.getSessionId();
        let workspaceDomains = new Map<string, AgentWorkspace>();
        const requireWorkspace = (workspaceId: string): AgentWorkspace => {
            const workspace = workspaceDomains.get(workspaceId);
            if (!workspace) {
                throw new Error(`Workspace ${workspaceId} is no longer available.`);
            }
            return workspace;
        };
        const loadBrowserData = async (signal?: AbortSignal): Promise<AgentSessionBrowserData> => {
            signal?.throwIfAborted();
            await lifecycle.manager.flushPersistence();
            signal?.throwIfAborted();
            const current = await loadAgentSessionTranscripts(
                currentAgentSessionItems([
                    ...lifecycle.manager.listRuns(),
                    ...lifecycle.setupRunSummaries,
                ]),
            );
            signal?.throwIfAborted();
            let sessionPast: AgentSessionBrowserItem[];
            let past: AgentSessionBrowserItem[];
            try {
                // One enumeration pass feeds all three views; re-listing per
                // view would re-scan every child transcript each time.
                const pastLists = await listAgentPastSessionLists(ctx.cwd, {
                    activeBranch: {
                        parentSessionId: currentSessionId,
                        parentSessionFile: ctx.sessionManager.getSessionFile(),
                        parentSessionLeafId: ctx.sessionManager.getLeafId(),
                    },
                });
                const sessionPastRecords = pastLists.all.filter(
                    (item) => item.parentSessionId === currentSessionId,
                );
                sessionPast = mergeHistoricalAgentSessions(sessionPastRecords, pastLists.activeBranch, current);
                past = mergeHistoricalAgentSessions(pastLists.all, pastLists.activeBranch, current);
            } catch (error) {
                if (signal?.aborted) {
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not browse persisted delegated-agent sessions: ${message}`, "warning");
                sessionPast = [];
                past = [];
            }
            signal?.throwIfAborted();
            let workspaceRecords: AgentWorkspace[];
            try {
                // Reconcile only verified no-change results. Changed or otherwise
                // uncertain leases remain protected until an explicit action.
                const released = await reconcileNoChangeAgentWorkspaceLeases(ctx.cwd);
                signal?.throwIfAborted();
                if (released > 0) {
                    ctx.ui.notify(
                        `Released ${released} verified no-change workspace lease${released === 1 ? "" : "s"}.`,
                        "info",
                    );
                    emitAgentEvent({
                        type: "runtime",
                        action: "reconciled",
                        released,
                    }, { sink: lifecycle.events, cwd: ctx.cwd });
                }
                workspaceRecords = await listAgentWorkspaces(ctx.cwd);
                signal?.throwIfAborted();
            } catch (error) {
                if (signal?.aborted) {
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not browse agent workspaces: ${message}`, "warning");
                workspaceRecords = [];
            }
            signal?.throwIfAborted();
            workspaceDomains = new Map(workspaceRecords.map((workspace) => [workspace.id, workspace]));
            const workspaces = await Promise.all(workspaceRecords.map(async (workspace) => workspaceBrowserItem(
                workspace,
                {
                    gitState: await inspectAgentWorkspaceGitState(workspace),
                    currentSessionId,
                },
            )));
            signal?.throwIfAborted();
            return {
                current,
                sessionPast,
                past,
                workspaces,
                settings: buildSettings(ctx.cwd),
                models: buildModelOptions(ctx, ctx.cwd),
            };
        };

        const initial: AgentSessionBrowserData = {
            current: [],
            sessionPast: [],
            past: [],
            workspaces: [],
            settings: buildSettings(ctx.cwd),
            models: buildModelOptions(ctx, ctx.cwd),
        };
        await showAgentSessionBrowser({
            ...initial,
            loadingAgents: true,
            loadingWorkspaces: true,
            onInitialLoad: loadBrowserData,
            cwd: ctx.cwd,
            eventBus: pi.events,
            onRefresh: loadBrowserData,
            onResume: async (item) => {
                try {
                    const outcome = await prepareForegroundWorkspaceResult(
                        await lifecycle.manager.resume(item.id, {
                            onProgress: lifecycle.backgroundUpdate(ctx),
                        }),
                        ctx,
                        lifecycle.events,
                    );
                    if (outcome.details.workspaceResult) {
                        lifecycle.manager.setWorkspaceResultId(
                            outcome.details.runId,
                            outcome.details.workspaceResult.id,
                        );
                    }
                    lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
                    lifecycle.publishAgentStatus();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not resume ${item.id}: ${message}`, "warning");
                }
            },
            onCancelConfirmation: (item) => confirm({
                title: "Cancel delegated agent?",
                message: `Cancel "${item.title || item.id}"? The agent will stop as soon as its current operation allows.`,
            }, ctx),
            onCancel: async (item) => {
                try {
                    const outcome = await prepareForegroundWorkspaceResult(
                        await lifecycle.manager.cancel(item.id),
                        ctx,
                        lifecycle.events,
                    );
                    if (outcome.details.workspaceResult) {
                        lifecycle.manager.setWorkspaceResultId(
                            outcome.details.runId,
                            outcome.details.workspaceResult.id,
                        );
                    }
                    lifecycle.notifyUserCanceled(outcome.details);
                    lifecycle.publishAgentStatus();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not cancel ${item.id}: ${message}`, "warning");
                }
            },
            onWorkspaceInspect: async (item) => inspectAgentWorkspaceResult(requireWorkspace(item.id)),
            onConfirmWorkspaceAction: (item, action) => confirm(
                workspaceActionConfirmation(action, item.slug),
                ctx,
            ),
            onLoadTranscript: (item) => loadAgentSessionTranscriptForItem(item),
            onModelChange: (agent, model) => {
                agentConfig.setModel(agent, model, ctx.cwd);
            },
            onToggleChange: (setting, enabled) => {
                if (setting === "advisorEnabled") {
                    agentConfig.setAdvisorEnabled(enabled, ctx.cwd);
                    lifecycle.refreshAgentPrompt(ctx);
                    return;
                }
                agentConfig.setNotifyBusyWorkerChanges(enabled, ctx.cwd);
            },
            onModelChangeError: (error) => {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not save agent settings: ${message}`, "warning");
            },
            onWorkspaceAction: async (item, action) => {
                const workspace = requireWorkspace(item.id);
                const replacement = await handleWorkspaceAction(
                    workspace,
                    action,
                    ctx,
                    lifecycle.manager,
                );
                if (replacement !== workspace) {
                    if (action === "discard") {
                        lifecycle.emitWorkspaceEvent(ctx, workspace.id, "removed", action);
                    } else {
                        lifecycle.emitWorkspaceEvent(ctx, workspace.id, "updated", action);
                        if (action === "apply" || action === "retain") {
                            lifecycle.emitWorkspaceEvent(ctx, workspace.id, "result_changed", action);
                        }
                        if (
                            action === "apply"
                            || action === "retain"
                            || action === "reset"
                            || action === "release"
                            || action === "recover"
                        ) {
                            lifecycle.emitWorkspaceEvent(ctx, workspace.id, "lease_changed", action);
                        }
                    }
                }
                if (!replacement) {
                    workspaceDomains.delete(workspace.id);
                    return replacement;
                }
                workspaceDomains.set(replacement.id, replacement);
                return workspaceBrowserItem(
                    replacement,
                    {
                        gitState: await inspectAgentWorkspaceGitState(replacement),
                        currentSessionId,
                    },
                );
            },
        }, ctx);
    };

    pi.registerCommand("agents", {
        description: "Browse delegated agents and isolated workspaces",
        handler: showAgentBrowser,
    });
}
