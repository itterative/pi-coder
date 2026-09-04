import type { Usage } from "@earendil-works/pi-ai";

import type {
    AgentRunDetails,
    AgentRunOutcome,
    AgentRunSummary,
    ChildProgress,
    ParentQuestion,
} from "../contracts/runs";
import type { WorkerMutationReport } from "../contracts/mutations";
import { cloneUsage, subtractUsage } from "./usage";
import { isAgentTerminalStatus } from "../contracts/runs";
import {
    BACKGROUND_AGENT_WAIT_GUIDANCE,
    MAX_OUTPUT_CHARS,
    type AgentRun,
    truncate,
} from "./run-state";

/** Read the current cumulative usage without exposing mutable usage state. */
export function readUsage(run: AgentRun): Usage {
    if (run.handle) run.usageSnapshot = cloneUsage(run.handle.getUsage());
    return cloneUsage(run.usageSnapshot);
}

/** Capture progress for a run, cloning restored nested fields for safe projections. */
export function progressSnapshot(run: AgentRun): ChildProgress {
    if (run.handle) return run.handle.getProgress();
    if (run.restoredProgress) {
        return {
            ...run.restoredProgress,
            recentActivity: [...run.restoredProgress.recentActivity],
            ...(run.restoredProgress.toolCounts
                ? { toolCounts: { ...run.restoredProgress.toolCounts } }
                : {}),
            ...(run.restoredProgress.todo ? { todo: { ...run.restoredProgress.todo } } : {}),
        };
    }
    return {
        output: run.terminalOutcome?.details.output ?? "",
        recentActivity: run.terminalOutcome?.details.recentActivity ?? [],
    };
}

/** Combine mutation information restored from a checkpoint with current child state. */
export function mutationReport(run: AgentRun): WorkerMutationReport {
    const current = run.handle?.getMutationReport?.();
    const changedFiles = new Set([
        ...(run.restoredMutationReport?.changedFiles ?? []),
        ...(current?.changedFiles ?? []),
    ]);
    const readFiles = new Set([
        ...(run.restoredMutationReport?.readFiles ?? []),
        ...(current?.readFiles ?? []),
    ]);
    const interrupted =
        run.restoredMutationReport?.interrupted === true || current?.interrupted === true;
    return {
        changedFiles: [...changedFiles].sort(),
        ...(readFiles.size ? { readFiles: [...readFiles].sort() } : {}),
        bashApproved:
            run.restoredMutationReport?.bashApproved === true || current?.bashApproved === true,
        ...(interrupted ? { interrupted: true } : {}),
    };
}

/** Capture the exact transcript leaf selected by the child handle. */
export function captureChildSessionLeaf(run: AgentRun): boolean {
    const childSessionLeafId = run.handle?.getSessionLeafId?.();
    if (childSessionLeafId === undefined || childSessionLeafId === run.childSessionLeafId) {
        return false;
    }
    run.childSessionLeafId = childSessionLeafId;
    return true;
}

/**
 * Render the parent-facing message that asks for guidance on a waiting run.
 *
 * Sections are ordered so the parent sees what is being asked before the child's reasoning: the
 * question, its context, partial output, the offered options, and any recommendation. Every section
 * is individually bounded so one verbose child cannot crowd out the continuation instructions, and
 * the closing line states the exact action that resumes the run.
 */
export function waitingContent(
    run: AgentRun,
    question: ParentQuestion,
    progress: ChildProgress,
): string {
    const sections = [
        `Agent ${run.id} is waiting for parent guidance.`,
        `Question: ${truncate(question.question, 4_000)}`,
    ];
    if (question.context) sections.push(`Context:\n${truncate(question.context, 12_000)}`);
    if (progress.output.trim()) {
        sections.push(`Partial child output:\n${truncate(progress.output.trim(), 12_000)}`);
    }
    if (question.options?.length) {
        sections.push(
            `Options:\n${question.options.map((option) => `- ${truncate(option, 1_000)}`).join("\n")}`,
        );
    }
    if (question.recommendation) {
        sections.push(`Recommendation: ${truncate(question.recommendation, 4_000)}`);
    }
    sections.push(`Continue with agent(action="continue", runId="${run.id}", guidance="...").`);
    return sections.join("\n\n");
}

/**
 * Render the message for `agent(action="status")`.
 *
 * Each branch tells the parent what the run is doing now and the single action that moves it
 * forward, so these strings stay together next to the other parent-facing builders instead of
 * spreading across lifecycle code. A still-active run summarizes progress without claiming the
 * result is finished; terminal and interrupted runs name the recovery action explicitly, because an
 * interrupted run must never look like a completed one.
 */
export function statusContent(run: AgentRun, progress: ChildProgress): string {
    if (run.status === "waiting_for_parent" && run.question) {
        return waitingContent(run, run.question, progress);
    }
    if (run.status === "completed") {
        return `Agent ${run.id} completed. Retrieve its result with agent(action="collect", runId="${run.id}").`;
    }
    if (isAgentTerminalStatus(run.status)) {
        const detail = truncate(run.terminalOutcome?.content ?? "", 2_000);
        return `Agent ${run.id} ${run.status}: ${detail}\n\nRetrieve the retained result with agent(action="collect", runId="${run.id}").`;
    }
    if (run.status === "interrupted") {
        return `Agent ${run.id} was interrupted before it reached a safe terminal state. Resume it only with explicit, grounded guidance; interrupted tool outcomes may be uncertain.`;
    }

    const sections = [`Agent ${run.id} is ${run.status} in the background.`];
    if (progress.output.trim()) {
        sections.push(`Partial output:\n${truncate(progress.output.trim(), 4_000)}`);
    }
    if (progress.recentActivity.length) {
        sections.push(`Recent activity:\n- ${progress.recentActivity.slice(-8).join("\n- ")}`);
    }
    sections.push(BACKGROUND_AGENT_WAIT_GUIDANCE);
    return sections.join("\n\n");
}

/**
 * Snapshot everything the parent may show about a run at this moment.
 *
 * Pure projection: it reads run state and child progress but changes neither, except that reading
 * cumulative usage refreshes the run's usage snapshot. `permissionPending` is reported as a distinct
 * status, because an approval wait looks identical to progress from the child's side. Recent
 * activity is trimmed to the last eight entries and output to the display bound; full transcripts
 * stay in the child session file.
 */
export function runDetails(
    run: AgentRun,
    progress: ChildProgress,
    maxTaskChars: number,
    error?: string,
    usage?: Usage,
): AgentRunDetails {
    const cumulative = usage ?? readUsage(run);
    return {
        runId: run.id,
        runInstanceId: run.runInstanceId,
        title: run.title,
        agent: run.agent,
        agentSource: run.agentSource,
        agentFilePath: run.agentFilePath,
        status: run.permissionPending ? "waiting_for_permission" : run.status,
        background: run.background,
        task: truncate(run.task, maxTaskChars),
        workspaceId: run.workspaceId,
        childSessionLeafId: run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId,
        output: progress.output ? truncate(progress.output, MAX_OUTPUT_CHARS) : undefined,
        question: run.question,
        recentActivity: progress.recentActivity.slice(-8),
        phase: progress.phase,
        lastAssistantMessage: progress.lastAssistantMessage,
        lastToolActivity: progress.lastToolActivity,
        toolCounts: progress.toolCounts ? { ...progress.toolCounts } : undefined,
        failedToolCalls: progress.failedToolCalls,
        ...(progress.todo ? { todo: { ...progress.todo } } : {}),
        usage: cloneUsage(cumulative),
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        error,
        setupFailed: run.setupFailed,
        mutating: run.mutating,
        mutationReport: mutationReport(run),
    };
}

/**
 * Wrap a projection in the outcome shape returned to the parent by an action.
 *
 * The top-level `usage` is the delta since `run.usageCheckpoint`, which is what a parent tool result
 * should be charged; `details.usage` stays cumulative for display and restoration.
 */
export function runOutcome(
    run: AgentRun,
    content: string,
    isError: boolean,
    progress: ChildProgress,
    maxTaskChars: number,
    error?: string,
    hasResponse = false,
): AgentRunOutcome {
    const cumulative = readUsage(run);
    const usage = subtractUsage(cumulative, run.usageCheckpoint);
    const details = runDetails(run, progress, maxTaskChars, error, cumulative);
    return {
        content,
        details,
        usage,
        ...(hasResponse ? { hasResponse: true as const } : {}),
        isError,
    };
}

/**
 * Compact run listing for `agent(action="list")`, the activity widget, and the `/agents` browser.
 *
 * Every field is trimmed to what fits a single list row; the full task, output, and mutation detail
 * come from a status or collect call instead.
 */
export function runSummary(run: AgentRun): AgentRunSummary {
    const progress = progressSnapshot(run);
    const activity = progress.recentActivity[progress.recentActivity.length - 1];
    const response = progress.output.trim() || progress.lastAssistantMessage?.trim() || "";
    return {
        runId: run.id,
        runInstanceId: run.runInstanceId,
        title: run.title,
        agent: run.agent,
        status: run.permissionPending ? "waiting_for_permission" : run.status,
        background: run.background,
        task: truncate(run.task.replace(/\s+/g, " ").trim(), 120),
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        sessionFile: run.childSessionFile,
        childSessionLeafId: run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId,
        sessionLeafId: run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId,
        readOnlyReason: run.readOnlyReason,
        activity: activity ? truncate(activity, 120) : undefined,
        phase: progress.phase,
        lastAssistantMessage: progress.lastAssistantMessage,
        lastToolActivity: progress.lastToolActivity
            ? truncate(progress.lastToolActivity, 120)
            : undefined,
        toolCounts: progress.toolCounts ? { ...progress.toolCounts } : undefined,
        failedToolCalls: progress.failedToolCalls,
        ...(progress.todo ? { todo: { ...progress.todo } } : {}),
        responsePreview: response ? truncate(response, 120) : undefined,
        question: run.question ? truncate(run.question.question, 500) : undefined,
        usage: readUsage(run),
        mutationReport: mutationReport(run),
        mutating: run.mutating,
        workspaceId: run.workspaceId,
        workspaceResultId: run.workspaceResultId,
    };
}
