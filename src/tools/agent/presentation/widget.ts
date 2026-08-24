import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    type AgentRunDetails,
    type AgentRunSummary,
} from "../runtime";

export const AGENT_WIDGET_ID = "pi-coder-agent-activity";

export function diagnosticText(diagnostic: { message: string; paths: string[] }): string {
    const paths = diagnostic.paths.length ? ` [${diagnostic.paths.join(", ")}]` : "";
    return `${diagnostic.message}${paths}`;
}

export function oneLinePreview(text: string, maxChars = 180): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function updateAgentUi(
    ctx: ExtensionContext,
    manager: { listRuns(): AgentRunSummary[] },
    extraRuns: AgentRunSummary[] = [],
): void {
    const runs = [...manager.listRuns(), ...extraRuns];
    if (!runs.length) {
        ctx.ui.setWidget(AGENT_WIDGET_ID, undefined);
        return;
    }

    const activeRuns = runs.filter((run) => (
        run.status === "starting" || run.status === "running" || run.status === "waiting_for_permission" || run.status === "waiting_for_parent" || run.status === "interrupted"
    ));
    const terminalRuns = runs.filter((run) => !activeRuns.includes(run)).slice(-3);
    const visibleRuns = [...activeRuns, ...terminalRuns];
    const activityLines = visibleRuns.map((run) => {
        const response = run.responsePreview
            ? ` · “${oneLinePreview(run.responsePreview, 72)}”`
            : "";
        const label = run.agent === "workspace-setup" ? run.title : run.runId;
        if (run.status === "starting") {
            return `● ${label} — Starting: ${oneLinePreview(run.task, 90)}`;
        }
        if (run.status === "running") {
            return `● ${label} — ${run.activity ?? "Working"}${response}`;
        }
        if (run.status === "waiting_for_permission") {
            return `? ${label} — ${run.activity ?? "Waiting for mutation permission"}${response}`;
        }
        if (run.status === "waiting_for_parent") {
            return `? ${label} — Waiting: ${oneLinePreview(run.question ?? "parent guidance", 100)}${response}`;
        }
        if (run.status === "interrupted") {
            return `! ${label} — Interrupted; resume with explicit guidance${response}`;
        }
        if (run.status === "completed") {
            return run.agent === "workspace-setup"
                ? `✓ ${label} — Setup complete${response}`
                : `✓ ${label} — Ready to collect${response}`;
        }
        if (run.status === "failed") {
            return run.agent === "workspace-setup"
                ? `! ${label} — Setup failed${response}`
                : `! ${label} — Failed; result ready to collect${response}`;
        }
        return `× ${label} — ${run.status}`;
    });
    if (runs.length > visibleRuns.length) {
        activityLines.push(`… ${runs.length - visibleRuns.length} older result(s) hidden`);
    }
    ctx.ui.setWidget(AGENT_WIDGET_ID, activityLines, { placement: "aboveEditor" });
}

export function clearCompletedWorkspaceSetupRun(
    setupRuns: Map<string, AgentRunSummary>,
    details: Pick<AgentRunDetails, "agent" | "status" | "workspaceId">,
): boolean {
    if (details.status !== "completed" || !details.workspaceId || details.agent === "workspace-setup") return false;
    let removed = false;
    for (const [setupRunId, setupRun] of setupRuns) {
        if (setupRun.workspaceId !== details.workspaceId) continue;
        setupRuns.delete(setupRunId);
        removed = true;
    }
    return removed;
}
