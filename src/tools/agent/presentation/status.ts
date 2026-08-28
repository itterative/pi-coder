import type { AgentRunDetails, AgentRunSummary } from "../contracts/runs";

function isActive(run: AgentRunSummary): boolean {
    return run.status === "starting"
        || run.status === "running"
        || run.status === "waiting_for_permission"
        || run.status === "waiting_for_parent"
        || run.status === "interrupted";
}

export function visibleAgentRuns(
    manager: { listRuns(): AgentRunSummary[] },
    extraRuns: AgentRunSummary[],
): { runs: AgentRunSummary[]; hiddenCount: number } {
    const runs = [...manager.listRuns(), ...extraRuns];
    const activeRuns = runs.filter(isActive);
    const terminalRuns = runs.filter((run) => !activeRuns.includes(run)).slice(-3);
    const visible = [...activeRuns, ...terminalRuns];
    return { runs: visible, hiddenCount: runs.length - visible.length };
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
