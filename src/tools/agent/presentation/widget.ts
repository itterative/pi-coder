import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { Spinner } from "../../../tui/spinner";
import type { AgentRunDetails, AgentRunSummary } from "../contracts/runs";

export const AGENT_WIDGET_ID = "pi-coder-agent-activity";

const MAX_PREVIEW_CHARS = 72;
const MAX_ACTIVITY_CHARS = 100;

interface AgentWidgetState {
    runs: AgentRunSummary[];
    hiddenCount: number;
    component?: AgentActivityWidget;
}

const widgetStates = new WeakMap<object, AgentWidgetState>();

function widgetOwner(ctx: ExtensionContext, events?: EventBus): object {
    return (events ?? ctx.ui) as object;
}

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

export function firstLinePreview(text: string, maxChars = 180): string {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    return oneLinePreview(firstLine, maxChars);
}

function formatElapsed(startedAt: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

const TOOL_GROUPS: Array<{ names: string[]; singular: string; plural: string }> = [
    { names: ["read"], singular: "read", plural: "reads" },
    { names: ["grep", "find"], singular: "search", plural: "searches" },
    { names: ["ls"], singular: "listing", plural: "listings" },
    { names: ["bash"], singular: "command", plural: "commands" },
    { names: ["edit"], singular: "edit", plural: "edits" },
    { names: ["write"], singular: "write", plural: "writes" },
    { names: ["ask_parent", "ask_user"], singular: "question", plural: "questions" },
];

export function formatToolCounts(toolCounts: Record<string, number> | undefined): string {
    if (!toolCounts) return "";

    const parts: string[] = [];
    for (const group of TOOL_GROUPS) {
        const count = group.names.reduce((total, name) => total + (toolCounts[name] ?? 0), 0);
        if (!count) continue;
        parts.push(`${count} ${count === 1 ? group.singular : group.plural}`);
    }

    return parts.join(" · ");
}

function isActive(run: AgentRunSummary): boolean {
    return run.status === "starting"
        || run.status === "running"
        || run.status === "waiting_for_permission"
        || run.status === "waiting_for_parent"
        || run.status === "interrupted";
}

function renderRunningRun(run: AgentRunSummary, spinnerFrame: string): string[] {
    const label = run.agent === "workspace-setup" ? run.title : run.runId;
    const status = run.responsePreview
        ? firstLinePreview(run.responsePreview, MAX_PREVIEW_CHARS)
        : run.phase ?? "Thinking";
    const firstLine = `${spinnerFrame} ${label} · ${formatElapsed(run.startedAt)} · ${status}`;
    const action = run.activity && run.activity !== "Thinking"
        ? run.activity
        : run.lastToolActivity;
    const details = [
        formatToolCounts(run.toolCounts),
        action ? oneLinePreview(action, MAX_ACTIVITY_CHARS) : "",
    ].filter(Boolean).join(" · ");

    return details ? [firstLine, `  ${details}`] : [firstLine];
}

function renderRun(run: AgentRunSummary, spinnerFrame: string): string[] {
    const label = run.agent === "workspace-setup" ? run.title : run.runId;
    if (run.status === "running") return renderRunningRun(run, spinnerFrame);
    if (run.status === "starting") {
        return [`● ${label} · ${formatElapsed(run.startedAt)} · Starting: ${oneLinePreview(run.task, 90)}`];
    }

    const response = run.responsePreview
        ? ` · “${firstLinePreview(run.responsePreview, MAX_PREVIEW_CHARS)}”`
        : "";
    if (run.status === "waiting_for_permission") {
        return [`? ${label} — ${run.activity ?? "Waiting for mutation permission"}${response}`];
    }
    if (run.status === "waiting_for_parent") {
        return [`? ${label} — Waiting: ${oneLinePreview(run.question ?? "parent guidance", MAX_ACTIVITY_CHARS)}${response}`];
    }
    if (run.status === "interrupted") {
        return [`! ${label} — Interrupted; resume with explicit guidance${response}`];
    }
    if (run.status === "completed") {
        return [run.agent === "workspace-setup"
            ? `✓ ${label} — Setup complete${response}`
            : `✓ ${label} — Ready to collect${response}`];
    }
    if (run.status === "failed") {
        return [run.agent === "workspace-setup"
            ? `! ${label} — Setup failed${response}`
            : `! ${label} — Failed; result ready to collect${response}`];
    }
    return [`× ${label} — ${run.status}`];
}

export class AgentActivityWidget implements Component {
    private readonly tui: TUI;
    private readonly spinner: Spinner;
    private runs: AgentRunSummary[];
    private hiddenCount: number;

    constructor(
        tui: TUI,
        runs: AgentRunSummary[] = [],
        hiddenCount = 0,
        events?: EventBus,
    ) {
        this.tui = tui;
        this.spinner = new Spinner(tui, { events });
        this.runs = runs;
        this.hiddenCount = hiddenCount;
        this.updateSpinner();
    }

    setRuns(runs: AgentRunSummary[], hiddenCount = 0): void {
        this.runs = runs;
        this.hiddenCount = hiddenCount;
        this.updateSpinner();
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const lines = this.runs.flatMap((run) => renderRun(run, this.spinner.getFrame()));
        if (this.hiddenCount > 0) {
            lines.push(`… ${this.hiddenCount} older result(s) hidden`);
        }
        if (width <= 2) {
            return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
        }

        const contentWidth = width - 2;
        return lines.map((line) => ` ${truncateToWidth(line, contentWidth)} `);
    }

    invalidate(): void {
        // The widget reads current run state during each render.
    }

    dispose(): void {
        this.spinner.dispose();
    }

    private updateSpinner(): void {
        this.spinner.setActive(this.runs.some((run) => run.status === "running"));
    }
}

function visibleRuns(
    manager: { listRuns(): AgentRunSummary[] },
    extraRuns: AgentRunSummary[],
): { runs: AgentRunSummary[]; hiddenCount: number } {
    const runs = [...manager.listRuns(), ...extraRuns];
    const activeRuns = runs.filter(isActive);
    const terminalRuns = runs.filter((run) => !activeRuns.includes(run)).slice(-3);
    const visible = [...activeRuns, ...terminalRuns];
    return { runs: visible, hiddenCount: runs.length - visible.length };
}

export function updateAgentUi(
    ctx: ExtensionContext,
    manager: { listRuns(): AgentRunSummary[] },
    extraRuns: AgentRunSummary[] = [],
    events?: EventBus,
): void {
    const visible = visibleRuns(manager, extraRuns);
    const owner = widgetOwner(ctx, events);
    const state = widgetStates.get(owner);
    if (!visible.runs.length) {
        clearAgentUi(ctx, events);
        return;
    }

    if (state) {
        state.runs = visible.runs;
        state.hiddenCount = visible.hiddenCount;
        state.component?.setRuns(visible.runs, visible.hiddenCount);
        return;
    }

    const nextState: AgentWidgetState = {
        runs: visible.runs,
        hiddenCount: visible.hiddenCount,
    };
    widgetStates.set(owner, nextState);
    ctx.ui.setWidget(
        AGENT_WIDGET_ID,
        (tui) => {
            const component = new AgentActivityWidget(tui, nextState.runs, nextState.hiddenCount, events);
            nextState.component = component;
            return component;
        },
        { placement: "aboveEditor" },
    );
}

export function clearAgentUi(ctx: ExtensionContext, events?: EventBus): void {
    ctx.ui.setWidget(AGENT_WIDGET_ID, undefined);
    widgetStates.delete(widgetOwner(ctx, events));
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
