import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
    currentAgentSessionItems,
    listPastAgentSessions,
    loadAgentSessionTranscripts,
    removeCurrentAgentTranscripts,
    type AgentSessionBrowserItem,
} from "./presentation/sessions";
import type { AgentWorkspace } from "./contracts/workspaces";
import { inspectAgentWorkspaceGitState, listAgentWorkspaces } from "./workspaces/store";
import {
    inspectAgentWorkspaceDiff,
    reconcileNoChangeAgentWorkspaceLeases,
} from "./workspaces/results";
import {
    showAgentSessionBrowser,
    type AgentSessionBrowserData,
} from "../../tui/agent-session-browser";
import { emitAgentEvent } from "./observability/events";
import { handleWorkspaceAction } from "./workspaces/tui-actions";
import { prepareForegroundWorkspaceResult } from "./workspaces/finalization";
import type { AgentLifecycle } from "./lifecycle";

export function registerAgentBrowser(pi: ExtensionAPI, lifecycle: AgentLifecycle): void {
    const showAgentBrowser = async (_args: string, ctx: ExtensionCommandContext) => {
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
                    emitAgentEvent(lifecycle.events, ctx.cwd, {
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
            onWorkspaceInspect: async (workspace) => inspectAgentWorkspaceDiff(workspace),
            onWorkspaceAction: async (workspace, action) => {
                const replacement = await handleWorkspaceAction(
                    workspace,
                    action,
                    ctx,
                    lifecycle.manager,
                );
                if (replacement) {
                    initial.workspaceGitStates?.set(
                        replacement.id,
                        await inspectAgentWorkspaceGitState(replacement),
                    );
                }
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
                        ) {
                            lifecycle.emitWorkspaceEvent(ctx, workspace.id, "lease_changed", action);
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
}
