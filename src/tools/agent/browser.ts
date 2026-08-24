import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentWorkspace } from "./contracts/workspaces";
import { emitAgentEvent } from "./observability/events";
import {
    type AgentSessionBrowserItem,
    workspaceBrowserItem,
} from "./presentation/browser-models";
import {
    currentAgentSessionItems,
    listPastAgentSessions,
    loadAgentSessionTranscripts,
    removeCurrentAgentTranscripts,
} from "./presentation/sessions";
import {
    showAgentSessionBrowser,
    type AgentSessionBrowserData,
} from "../../tui/agent-session-browser";
import type { AgentLifecycle } from "./lifecycle";
import { prepareForegroundWorkspaceResult } from "./workspaces/finalization";
import { inspectAgentWorkspaceDiff, reconcileNoChangeAgentWorkspaceLeases } from "./workspaces/results";
import { inspectAgentWorkspaceGitState, listAgentWorkspaces } from "./workspaces/store";
import { handleWorkspaceAction } from "./workspaces/tui-actions";

export function registerAgentBrowser(pi: ExtensionAPI, lifecycle: AgentLifecycle): void {
    const showAgentBrowser = async (_args: string, ctx: ExtensionCommandContext) => {
        const currentSessionId = ctx.sessionManager.getSessionId();
        let workspaceDomains = new Map<string, AgentWorkspace>();
        const requireWorkspace = (workspaceId: string): AgentWorkspace => {
            const workspace = workspaceDomains.get(workspaceId);
            if (!workspace) throw new Error(`Workspace ${workspaceId} is no longer available.`);
            return workspace;
        };
        const loadBrowserData = async (): Promise<AgentSessionBrowserData> => {
            await lifecycle.manager.flushPersistence();
            const current = await loadAgentSessionTranscripts(
                currentAgentSessionItems([
                    ...lifecycle.manager.listRuns(),
                    ...lifecycle.setupRunSummaries,
                ]),
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
            let workspaceRecords: AgentWorkspace[];
            try {
                // Reconcile only verified no-change results. Changed or otherwise
                // uncertain leases remain protected until an explicit action.
                const released = await reconcileNoChangeAgentWorkspaceLeases(ctx.cwd);
                if (released > 0) {
                    ctx.ui.notify(
                        `Released ${released} verified no-change workspace lease${released === 1 ? "" : "s"}.`,
                        "info",
                    );
                    emitAgentEvent(lifecycle.events, ctx.cwd, {
                        type: "runtime",
                        action: "reconciled",
                        released,
                    });
                }
                workspaceRecords = await listAgentWorkspaces(ctx.cwd);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not browse agent workspaces: ${message}`, "warning");
                workspaceRecords = [];
            }
            workspaceDomains = new Map(workspaceRecords.map((workspace) => [workspace.id, workspace]));
            const workspaces = await Promise.all(workspaceRecords.map(async (workspace) => workspaceBrowserItem(
                workspace,
                await inspectAgentWorkspaceGitState(workspace),
                currentSessionId,
            )));
            return { current, past, workspaces };
        };

        const initial = await loadBrowserData();
        await showAgentSessionBrowser({
            ...initial,
            cwd: ctx.cwd,
            eventBus: pi.events,
            onRefresh: loadBrowserData,
            onResume: async (item) => {
                try {
                    const outcome = await prepareForegroundWorkspaceResult(
                        await lifecycle.manager.resume(
                            item.id,
                            undefined,
                            undefined,
                            lifecycle.backgroundUpdate(ctx),
                        ),
                        ctx,
                        lifecycle.events,
                    );
                    lifecycle.clearCompletedWorkspaceSetup(ctx, outcome.details);
                    lifecycle.refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not resume ${item.id}: ${message}`, "warning");
                }
            },
            onCancel: async (item) => {
                try {
                    const outcome = await prepareForegroundWorkspaceResult(
                        await lifecycle.manager.cancel(item.id),
                        ctx,
                        lifecycle.events,
                    );
                    lifecycle.notifyUserCanceled(outcome.details);
                    lifecycle.refreshAgentUi(ctx);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Could not cancel ${item.id}: ${message}`, "warning");
                }
            },
            onWorkspaceInspect: async (item) => inspectAgentWorkspaceDiff(requireWorkspace(item.id)),
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
                    await inspectAgentWorkspaceGitState(replacement),
                    currentSessionId,
                );
            },
        }, ctx);
    };

    pi.registerCommand("agents", {
        description: "Browse delegated agents and isolated workspaces",
        handler: showAgentBrowser,
    });
}
