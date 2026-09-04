import type { AgentDefinition } from "../definitions/types";
import type {
    AgentProgressCallback,
    AgentRunDetails,
    AgentRunStatus,
    ChildAgentFactoryContext,
    ChildProgress,
} from "../contracts/runs";
import type { AgentTraceData } from "../contracts/trace";
import { emptyProgress, type AgentRun, type AgentStartContext } from "./run-state";

export interface ChildSetupHooks {
    /** Directory where durable child transcripts live, when persistence is configured. */
    readonly childSessionDir: () => string | undefined;
    /** Project run state plus child progress into the parent-visible detail snapshot. */
    readonly details: (run: AgentRun, progress: ChildProgress) => AgentRunDetails;
    /** Publish a lifecycle status transition; skipped when the projected status is unchanged. */
    readonly emitStatusChanged: (
        run: AgentRun,
        previousStatus: AgentRunStatus,
        status: AgentRunStatus,
    ) => void;
    /** Publish progress to the event sink and the run's background callback. */
    readonly emitBackgroundUpdate: (run: AgentRun, details: AgentRunDetails) => void;
    /** Checkpoint the run without blocking the child; failures surface on the next awaited save. */
    readonly persist: (run: AgentRun) => void;
    /** Record a run-scoped lifecycle trace event. */
    readonly record: (run: AgentRun, type: string, data?: AgentTraceData) => void;
}

export interface ChildSetupInputs {
    definition: AgentDefinition;
    context: AgentStartContext;
    onProgress?: AgentProgressCallback;
    hooks: ChildSetupHooks;
}

/**
 * Build the child-factory context that bridges child callbacks into manager-owned run state.
 *
 * The child reports only raw progress, session identity, and file changes. Translating those into
 * durable checkpoints, status events, and parent-visible callbacks is lifecycle policy, so it lives
 * here instead of inside the child runtime. Each callback runs on the child's own timeline, which
 * is why none of them may await persistence: a blocked callback would stall child settlement.
 *
 * Ordering inside `onProgress` is load-bearing:
 *
 * 1. `updatedAt` advances first so retention and UI ordering see the activity.
 * 2. The exact transcript leaf is refreshed and checkpointed before any event is published, so a
 *    parent that reacts to the status change can restore from the leaf already on disk.
 * 3. `permissionPending` is projected from the incoming progress, and the status change is
 *    emitted using the previously observed status, so approval transitions are never duplicated
 *    or dropped.
 * 4. Background runs publish through the background callback; only foreground runs receive the
 *    caller's `onProgress`, which keeps a detached run from reporting into a finished tool call.
 */
export function createChildFactoryContext(
    run: AgentRun,
    { definition, context, onProgress, hooks }: ChildSetupInputs,
): ChildAgentFactoryContext {
    const currentProgress = (): ChildProgress => run.handle?.getProgress() ?? emptyProgress();

    return {
        ...context,
        definition,
        background: run.background,
        runId: run.id,
        runTitle: run.title,
        childSessionDir: hooks.childSessionDir(),
        childSessionFile: run.childSessionFile ?? context.childSessionFile,
        childSessionLeafId: run.childSessionLeafId ?? context.childSessionLeafId,
        repairInterrupted: context.repairInterrupted,
        initialProgress: context.initialProgress ?? run.restoredProgress,
        initialMutationReport: context.initialMutationReport ?? run.restoredMutationReport,
        onSessionCreated: (sessionFile, childSessionLeafId) => {
            run.childSessionFile = sessionFile;
            run.childSessionLeafId = childSessionLeafId;
            hooks.persist(run);
            context.onSessionCreated?.(sessionFile, childSessionLeafId);
        },
        onFileChanged: () => {
            run.updatedAt = Date.now();
            hooks.persist(run);
            hooks.emitBackgroundUpdate(run, hooks.details(run, currentProgress()));
        },
        onProgress: (progress) => {
            run.updatedAt = Date.now();
            updateTranscriptLeaf(run, hooks);
            const previousStatus = permissionStatus(run);
            run.permissionPending = progress.permissionPending === true;
            hooks.record(run, "child.progress", {
                outputChars: progress.output.length,
                activity: progress.recentActivity[progress.recentActivity.length - 1] ?? "",
            });
            const details = hooks.details(run, progress);
            if (previousStatus !== details.status) {
                hooks.emitStatusChanged(run, previousStatus, details.status);
            }
            hooks.emitBackgroundUpdate(run, details);
            if (!run.background) {
                onProgress?.(details);
            }
        },
        onTrace: (type, data) => hooks.record(run, `child.${type}`, data),
    };
}

/** Refresh the exact transcript leaf and checkpoint the run when it advanced. */
function updateTranscriptLeaf(run: AgentRun, hooks: ChildSetupHooks): void {
    const childSessionLeafId = run.handle?.getSessionLeafId?.() ?? run.childSessionLeafId;
    const childLeafChanged = childSessionLeafId !== run.childSessionLeafId;
    run.childSessionLeafId = childSessionLeafId;
    if (childLeafChanged) {
        hooks.persist(run);
    }
}

/** Status currently visible to the parent, which reports approval waits as a distinct state. */
function permissionStatus(run: AgentRun): AgentRunStatus {
    return run.permissionPending ? "waiting_for_permission" : run.status;
}
