import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Spinner } from "../spinner";
import type { AgentRunSummary } from "../../tools/agent/contracts/runs";
import { formatTodoProgress } from "./format";
import { firstLinePreview, formatToolCounts, oneLinePreview } from "./agent-activity-format";

const MAX_PREVIEW_CHARS = 72;
const MAX_ACTIVITY_CHARS = 100;

function formatElapsed(startedAt: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function renderRunningRun(run: AgentRunSummary, spinnerFrame: string): string[] {
    const label = run.agent === "workspace-setup" ? run.title : run.runId;
    const status = run.responsePreview
        ? firstLinePreview(run.responsePreview, MAX_PREVIEW_CHARS)
        : (run.phase ?? "Thinking");
    const firstLine = `${spinnerFrame} ${label} · ${formatElapsed(run.startedAt)} · ${status}`;
    const action =
        run.activity && run.activity !== "Thinking" ? run.activity : run.lastToolActivity;
    const details = [
        formatToolCounts(run.toolCounts),
        action ? oneLinePreview(action, MAX_ACTIVITY_CHARS) : "",
        formatTodoProgress(run.todo),
    ]
        .filter(Boolean)
        .join(" · ");
    return details ? [firstLine, `  ${details}`] : [firstLine];
}

function renderRun(run: AgentRunSummary, spinnerFrame: string): string[] {
    const label = run.agent === "workspace-setup" ? run.title : run.runId;
    if (run.status === "running") return renderRunningRun(run, spinnerFrame);
    if (run.status === "starting")
        return [
            `● ${label} · ${formatElapsed(run.startedAt)} · Starting: ${oneLinePreview(run.task, 90)}`,
        ];
    const response = run.responsePreview
        ? ` · “${firstLinePreview(run.responsePreview, MAX_PREVIEW_CHARS)}”`
        : "";
    const todo = formatTodoProgress(run.todo);
    const todoSuffix = todo ? ` · ${todo}` : "";
    if (run.status === "waiting_for_permission")
        return [
            `? ${label} — ${run.activity ?? "Waiting for mutation permission"}${todoSuffix}${response}`,
        ];
    if (run.status === "waiting_for_parent")
        return [
            `? ${label} — Waiting: ${oneLinePreview(run.question ?? "parent guidance", MAX_ACTIVITY_CHARS)}${todoSuffix}${response}`,
        ];
    if (run.status === "interrupted")
        return [`! ${label} — Interrupted; resume with explicit guidance${todoSuffix}${response}`];
    if (run.status === "completed")
        return [
            run.agent === "workspace-setup"
                ? `✓ ${label} — Setup complete${todoSuffix}${response}`
                : `✓ ${label} — Ready to collect${todoSuffix}${response}`,
        ];
    if (run.status === "failed")
        return [
            run.agent === "workspace-setup"
                ? `! ${label} — Setup failed${todoSuffix}${response}`
                : `! ${label} — Failed; result ready to collect${todoSuffix}${response}`,
        ];
    return [`× ${label} — ${run.status}`];
}

/** Activity widget composed with the reusable spinner. */
export class AgentActivityWidget implements Component {
    private readonly spinner: Spinner;
    private runs: AgentRunSummary[];
    private hiddenCount: number;

    constructor(
        private readonly tui: TUI,
        runs: AgentRunSummary[] = [],
        hiddenCount = 0,
        events?: EventBus,
    ) {
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
        if (this.hiddenCount > 0) lines.push(`… ${this.hiddenCount} older result(s) hidden`);
        if (width <= 2) return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
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
