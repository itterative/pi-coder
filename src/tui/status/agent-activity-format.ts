import type { AgentRunSummary } from "../../tools/agent/contracts/runs";

const MAX_SUMMARY_CHARS = 40;

const TERMINAL_PRIORITY: Record<string, number> = {
    failed: 0,
    completed: 1,
    aborted: 2,
    canceled: 3,
};

function formatElapsed(startedAt: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function runLabel(run: AgentRunSummary): string {
    return run.agent === "workspace-setup" ? run.title : run.runId;
}

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function oneLinePreview(text: string, maxChars: number): string {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    return truncateText(firstLine.replace(/\s+/g, " ").trim(), maxChars);
}

function mostRecent(runs: readonly AgentRunSummary[]): AgentRunSummary | undefined {
    return runs.reduce<AgentRunSummary | undefined>(
        (latest, run) => (latest && latest.updatedAt >= run.updatedAt ? latest : run),
        undefined,
    );
}

function isWaiting(run: AgentRunSummary): boolean {
    return (
        run.status === "waiting_for_permission" ||
        run.status === "waiting_for_parent" ||
        run.status === "interrupted"
    );
}

function isRunning(run: AgentRunSummary): boolean {
    return run.status === "starting" || run.status === "running";
}

/** Whether any visible run is still active — running, starting, or waiting on a human or the parent. */
export function hasActiveAgentRuns(runs: readonly AgentRunSummary[]): boolean {
    return runs.some((run) => isWaiting(run) || isRunning(run));
}

function formatWaitingSummary(runs: readonly AgentRunSummary[]): string | undefined {
    const run = mostRecent(runs);
    if (!run) return undefined;

    if (run.status === "interrupted") {
        return `! ${runLabel(run)} · interrupted`;
    }
    if (run.status === "waiting_for_parent") {
        return `? ${runLabel(run)} · waiting for you`;
    }
    return `? ${runLabel(run)} · waiting for permission`;
}

function formatRunningSummary(
    runs: readonly AgentRunSummary[],
    spinnerFrame: string,
): string | undefined {
    const run = mostRecent(runs);
    if (!run) return undefined;

    if (run.status === "starting") {
        return `${spinnerFrame} ${runLabel(run)} · Starting`;
    }

    const detail = run.responsePreview
        ? oneLinePreview(run.responsePreview, MAX_SUMMARY_CHARS)
        : truncateText(run.phase ?? "Thinking", MAX_SUMMARY_CHARS);
    return `${spinnerFrame} ${runLabel(run)} · ${formatElapsed(run.startedAt)} · ${detail}`;
}

function formatTerminalSummary(runs: readonly AgentRunSummary[]): string | undefined {
    const run = runs.toSorted((left, right) => {
        const priority =
            (TERMINAL_PRIORITY[left.status] ?? 9) - (TERMINAL_PRIORITY[right.status] ?? 9);
        if (priority !== 0) return priority;
        return right.updatedAt - left.updatedAt;
    })[0];
    if (!run) return undefined;

    if (run.status === "completed") {
        return `✓ ${runLabel(run)} · ready`;
    }
    if (run.status === "failed") {
        return `! ${runLabel(run)} · failed`;
    }
    return `× ${runLabel(run)} · ${run.status}`;
}

/**
 * One compact line summarizing the visible agent runs: waiting runs first, then running, then
 * terminal results. Additional visible or hidden runs collapse into a trailing `+N` count.
 */
export function formatAgentSummary(
    runs: AgentRunSummary[],
    hiddenCount: number,
    spinnerFrame: string,
): string {
    const more = Math.max(0, runs.length - 1) + Math.max(0, hiddenCount);
    const suffix = more > 0 ? ` +${more}` : "";

    const waiting = formatWaitingSummary(runs.filter(isWaiting));
    if (waiting) return `${waiting}${suffix}`;

    const running = formatRunningSummary(runs.filter(isRunning), spinnerFrame);
    if (running) return `${running}${suffix}`;

    const terminal = formatTerminalSummary(
        runs.filter((run) => !isWaiting(run) && !isRunning(run)),
    );
    if (terminal) return `${terminal}${suffix}`;

    if (hiddenCount > 0) return `… ${hiddenCount} hidden`;
    return "";
}
