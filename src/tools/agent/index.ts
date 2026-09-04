import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { executeAgentAction } from "./action-dispatch";
import { registerAgentBrowser } from "./browser";
import { createAgentChild } from "./child";
import { AgentLifecycle } from "./lifecycle";
import { formatAgentToolContent } from "./presentation/formatting";
import type { ChildAgentFactory } from "./runs/manager";
import {
    AgentTraceStore,
    isAgentTraceEnabled,
    registerAgentTraceCommand,
} from "./observability/trace";
import { registerAgentTool as registerAgentToolDefinition } from "./presentation/tool";

export { clearCompletedWorkspaceSetupRun } from "./presentation/status";

export interface AgentToolRegistrationOptions {
    /**
     * Use this trace store instead of the environment-gated default.
     *
     * An injection seam for tests and diagnostics: supplying a store always enables tracing for this
     * registration, whatever `PI_CODER_AGENT_TRACE` says, and leaves the caller holding the recorded
     * events so they can be asserted or printed without going through `/agent-trace`.
     */
    traceStore?: AgentTraceStore;
}

export default function registerAgentTool(
    pi: ExtensionAPI,
    factory: ChildAgentFactory = createAgentChild,
    options: AgentToolRegistrationOptions = {},
): void {
    const traceStore =
        options.traceStore ?? (isAgentTraceEnabled() ? new AgentTraceStore() : undefined);
    const lifecycle = new AgentLifecycle(pi, factory, traceStore);

    pi.registerShortcut?.("ctrl+alt+b", {
        description: "Move foreground delegated agent to background",
        handler: () => {
            lifecycle.manager.moveForegroundToBackground();
        },
    });

    if (traceStore) registerAgentTraceCommand(pi, traceStore);
    registerAgentBrowser(pi, lifecycle);
    lifecycle.register();

    registerAgentToolDefinition(pi, async (params, signal, progress, ctx) => {
        const outcome = await executeAgentAction(params, {
            signal,
            progress,
            ctx,
            lifecycle,
        });
        outcome.details = { ...outcome.details, response: outcome.content };
        outcome.content = formatAgentToolContent(params.action, outcome);
        lifecycle.publishAgentStatus();
        lifecycle.reconcileMailbox();
        return outcome;
    });
}
