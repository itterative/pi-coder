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

export { clearCompletedWorkspaceSetupRun } from "../../tui/agents";

export default function registerAgentTool(
    pi: ExtensionAPI,
    factory: ChildAgentFactory = createAgentChild,
): void {
    const traceStore = isAgentTraceEnabled() ? new AgentTraceStore() : undefined;
    const lifecycle = new AgentLifecycle(pi, factory, traceStore);

    if (traceStore) registerAgentTraceCommand(pi, traceStore);
    registerAgentBrowser(pi, lifecycle);
    lifecycle.register();

    registerAgentToolDefinition(pi, async (params, signal, progress, ctx) => {
        const outcome = await executeAgentAction(
            params,
            signal,
            progress,
            ctx,
            lifecycle,
        );
        outcome.details = { ...outcome.details, response: outcome.content };
        outcome.content = formatAgentToolContent(params.action, outcome);
        lifecycle.refreshAgentUi(ctx);
        lifecycle.reconcileMailbox();
        return outcome;
    });
}
