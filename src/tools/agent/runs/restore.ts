import { randomUUID } from "node:crypto";

import {
    agentCanEdit,
    isAgentDefinitionFingerprintCompatible,
    type AgentDefinition,
} from "../definitions/types";
import type {
    AgentBackgroundCallback,
    AgentRunPersistence,
    AgentRunStatus,
    PersistedAgentRun,
} from "../contracts/runs";
import { isAgentTerminalStatus } from "../contracts/runs";
import { getAgentWorkspace } from "../workspaces/store";
import { AgentRunRegistry } from "./registry";
import {
    type AgentRun,
    type AgentStartContext,
    AgentActionError,
    countActiveRuns,
    deriveAgentTitle,
    mutationRunsConflict,
    RUN_DEFAULT_FLAGS,
    type RestorePreparation,
} from "./run-state";
import { cloneUsage } from "./usage";

interface RestoreCoordinatorDependencies {
    readonly registry: AgentRunRegistry;
    readonly maxActiveRuns: number;
    readonly getPersistence: () => AgentRunPersistence | undefined;
    readonly replacePersistedRecords: (records: readonly PersistedAgentRun[]) => void;
    readonly isClosing: () => boolean;
    readonly restoreAbortSignal: AbortSignal;
    readonly emitRestored: (run: AgentRun) => void;
    readonly restoreTerminal: (run: AgentRun, record: PersistedAgentRun) => Promise<void>;
    readonly restoreActive: (
        run: AgentRun,
        record: PersistedAgentRun,
        definition: AgentDefinition,
        context: AgentStartContext,
        onBackgroundUpdate: AgentBackgroundCallback | undefined,
        diagnostics: string[],
    ) => Promise<void>;
}

/**
 * Decides which durable runs may rejoin a manager's live set, and in what order.
 *
 * Restoration must never replay child work: a run that was still executing when its parent session
 * ended comes back as interrupted so a user can decide what happens next. Eligibility is checked
 * per record, in `startedAt` order, so earlier runs claim workspace and mutation-capable slots
 * before later ones are compared against them. Every rejection either appends a diagnostic that
 * explains what the parent must do, or silently skips a record that belongs to somebody else.
 *
 * The coordinator owns no child, writes no checkpoint, and never imports the lifecycle manager; the
 * manager supplies the reopen and finalize steps through dependencies.
 */
export class AgentRunRestoreCoordinator {
    constructor(private readonly dependencies: RestoreCoordinatorDependencies) {}

    /**
     * Restore every eligible record and report how many runs the manager now holds.
     *
     * The returned count is the registry size rather than this call's admissions: unrelated active
     * runs are deliberately retained, so restoration is not a reconstruction from empty.
     */
    async restore(
        records: PersistedAgentRun[],
        definitions: AgentDefinition[],
        context: AgentStartContext,
        onBackgroundUpdate?: AgentBackgroundCallback,
    ): Promise<{ restored: number; diagnostics: string[] }> {
        const diagnostics: string[] = [];
        this.prepare(records);
        const definitionByName = new Map(
            definitions.map((definition) => [definition.name, definition]),
        );

        for (const record of records.sort((a, b) => a.startedAt - b.startedAt)) {
            if (this.dependencies.isClosing() || this.dependencies.restoreAbortSignal.aborted) {
                break;
            }
            await this.restoreRecord(
                record,
                definitionByName,
                context,
                onBackgroundUpdate,
                diagnostics,
            );
        }

        return { restored: this.dependencies.registry.size, diagnostics };
    }

    private prepare(records: readonly PersistedAgentRun[]): void {
        this.dependencies.replacePersistedRecords(records);
        this.dependencies.registry.observePersistedRecords(records);
    }

    /**
     * Admit one record, or explain why it stays out of the live set.
     *
     * Checks run in diagnostic-precedence order: ownership and workspace availability, then whether
     * the branch was continued elsewhere, then definition compatibility, then capability and budget
     * safety. A record that passes is registered before it is reopened, so a failure during the
     * manager's reopen step can drop exactly the run it added.
     */
    private async restoreRecord(
        record: PersistedAgentRun,
        definitionByName: ReadonlyMap<string, AgentDefinition>,
        context: AgentStartContext,
        onBackgroundUpdate: AgentBackgroundCallback | undefined,
        diagnostics: string[],
    ): Promise<void> {
        const persistence = this.dependencies.getPersistence();
        if (record.status === "removed" || record.ownerSessionId !== persistence?.ownerSessionId) {
            return;
        }
        if (!(await this.validateWorkspace(record, diagnostics))) {
            return;
        }
        if (record.resumable === false) {
            diagnostics.push(
                `Could not restore ${record.runId}: this checkpoint is historical and was continued on another parent branch.`,
            );
            return;
        }

        const preparation = this.prepareDefinition(record, definitionByName, diagnostics);
        if (!preparation || !this.canRestore(record, preparation, diagnostics)) {
            return;
        }

        const run = this.createRun(record, context, preparation);
        this.dependencies.registry.add(run);
        this.dependencies.emitRestored(run);

        if (preparation.persistedTerminal) {
            await this.dependencies.restoreTerminal(run, record);
            return;
        }

        await this.dependencies.restoreActive(
            run,
            record,
            preparation.definition!,
            context,
            onBackgroundUpdate,
            diagnostics,
        );
    }

    /** Require that an isolated run's workspace is still leased to this run in this session. */
    private async validateWorkspace(
        record: PersistedAgentRun,
        diagnostics: string[],
    ): Promise<boolean> {
        if (!record.workspaceId) {
            return true;
        }

        const workspace = await getAgentWorkspace(record.workspaceId);
        const ownsOriginalWorkspace =
            workspace?.leaseOwnerSessionId === record.ownerSessionId &&
            workspace.leaseRunId === record.runId &&
            workspace.leaseRunInstanceId === record.runInstanceId &&
            workspace.leaseKind === "task" &&
            workspace.status !== "recycling";
        if (ownsOriginalWorkspace) {
            return true;
        }

        diagnostics.push(
            `Could not restore ${record.runId}: its original workspace is parked or occupied; continue it explicitly after reclaiming that workspace.`,
        );
        return false;
    }

    /**
     * Resolve which definition a restored run may use.
     *
     * Only the persisted definition snapshot is trusted for a non-terminal run: the current
     * definition on disk may have gained or lost capabilities since the child was created, and drift
     * is reported instead of applied. Terminal results need no definition at all, because nothing is
     * reopened for them.
     */
    private prepareDefinition(
        record: PersistedAgentRun,
        definitionByName: ReadonlyMap<string, AgentDefinition>,
        diagnostics: string[],
    ): RestorePreparation | undefined {
        const persistedTerminal = isAgentTerminalStatus(record.status);
        const currentDefinition = definitionByName.get(record.agent);
        const definition = record.definitionSnapshot;
        if (!persistedTerminal && !definition) {
            diagnostics.push(
                `Could not restore ${record.runId}: its persisted agent definition snapshot is unavailable; start a new run.`,
            );
            return undefined;
        }

        this.addDefinitionDriftDiagnostic(
            record,
            currentDefinition,
            persistedTerminal,
            diagnostics,
        );

        const snapshotMutating = definition !== undefined && agentCanEdit(definition);
        return {
            definition,
            currentDefinition,
            persistedTerminal,
            snapshotMutating,
        };
    }

    /** Report definition drift as informational context; it never blocks a restore. */
    private addDefinitionDriftDiagnostic(
        record: PersistedAgentRun,
        currentDefinition: AgentDefinition | undefined,
        persistedTerminal: boolean,
        diagnostics: string[],
    ): void {
        if (persistedTerminal) {
            return;
        }
        if (
            currentDefinition &&
            !isAgentDefinitionFingerprintCompatible(currentDefinition, record.definitionFingerprint)
        ) {
            diagnostics.push(
                `Restored ${record.runId} using its persisted agent definition snapshot; the current definition has changed.`,
            );
            return;
        }
        if (!currentDefinition) {
            diagnostics.push(
                `Restored ${record.runId} using its persisted agent definition snapshot; the current definition is unavailable.`,
            );
        }
    }

    /**
     * Apply the capability, budget, and single-flight checks that protect the parent checkout.
     *
     * Terminal records are summaries and therefore exempt: they hold no child, claim no active-run
     * slot, and cannot mutate anything.
     */
    private canRestore(
        record: PersistedAgentRun,
        preparation: RestorePreparation,
        diagnostics: string[],
    ): boolean {
        if (
            !preparation.persistedTerminal &&
            this.hasInvalidMutationCapability(record, preparation)
        ) {
            diagnostics.push(
                `Could not restore ${record.runId}: persisted metadata cannot alter mutation capability.`,
            );
            return false;
        }
        if (!preparation.persistedTerminal && this.activeCount >= this.dependencies.maxActiveRuns) {
            diagnostics.push(
                `Could not restore ${record.runId}: the active-run limit is ${this.dependencies.maxActiveRuns}.`,
            );
            return false;
        }
        if (!preparation.persistedTerminal && this.hasConflictingMutationRun(record)) {
            diagnostics.push(
                `Could not restore ${record.runId}: another conflicting mutation-capable worker was restored first.`,
            );
            return false;
        }
        return true;
    }

    private get activeCount(): number {
        return countActiveRuns(this.dependencies.registry.all());
    }

    /**
     * Reject any record whose mutation capability does not match a trusted worker snapshot.
     *
     * Persisted metadata is untrusted input: a checkpoint cannot grant edit capability. A mutating
     * restore therefore requires the snapshot, the current definition, and the builtin `worker` role
     * from the builtin source to agree, so a crafted or stale record can never open an edit-capable
     * child.
     */
    private hasInvalidMutationCapability(
        record: PersistedAgentRun,
        preparation: RestorePreparation,
    ): boolean {
        if (record.mutating !== preparation.snapshotMutating) {
            return true;
        }
        if (!preparation.snapshotMutating) {
            return false;
        }
        const currentDefinition = preparation.currentDefinition;
        return (
            currentDefinition === undefined ||
            !agentCanEdit(currentDefinition) ||
            currentDefinition.name !== "worker" ||
            currentDefinition.source !== "builtin"
        );
    }

    /** Require that no already-restored mutation-capable run shares this record's checkout. */
    private hasConflictingMutationRun(record: PersistedAgentRun): boolean {
        return [...this.dependencies.registry.all()].some(
            (run) =>
                run.mutating &&
                !isAgentTerminalStatus(run.status) &&
                mutationRunsConflict(record.workspaceId, run.workspaceId),
        );
    }

    /**
     * Rebuild the in-memory run from a record, without reopening its child.
     *
     * A `starting` or `running` record becomes `interrupted`, since the work may have stopped at any
     * point; in-process flags come from `RUN_DEFAULT_FLAGS`, never from the record. Restored terminal
     * runs are marked disposed because there is no live child left to dispose later.
     */
    private createRun(
        record: PersistedAgentRun,
        context: AgentStartContext,
        preparation: RestorePreparation,
    ): AgentRun {
        if (record.status === "removed") {
            throw new AgentActionError(`Cannot restore removed agent run ${record.runId}.`);
        }
        const restoredStatus: AgentRunStatus =
            record.status === "starting" || record.status === "running"
                ? "interrupted"
                : record.status;
        return {
            id: record.runId,
            runInstanceId: record.runInstanceId ?? randomUUID(),
            title: deriveAgentTitle(record.task, record.title),
            agent: record.agent,
            agentSource: preparation.persistedTerminal
                ? record.agentSource
                : preparation.definition!.source,
            agentFilePath: preparation.persistedTerminal
                ? record.agentFilePath
                : preparation.definition!.filePath,
            definition: preparation.definition,
            definitionFingerprint: record.definitionFingerprint,
            task: record.task,
            status: restoredStatus,
            background: record.background,
            question: restoredStatus === "waiting_for_parent" ? record.question : undefined,
            usageCheckpoint: cloneUsage(record.usageCheckpoint),
            usageSnapshot: cloneUsage(record.usageSnapshot),
            startedAt: record.startedAt,
            updatedAt: record.updatedAt,
            cwd: record.cwd ?? context.cwd,
            parentCwd: record.parentCwd ?? context.parentCwd ?? context.cwd,
            ...RUN_DEFAULT_FLAGS,
            // A retained terminal result never owns a live child, so it starts already disposed.
            disposed: preparation.persistedTerminal,
            mutating: preparation.persistedTerminal
                ? record.mutating
                : preparation.snapshotMutating,
            setupFailed: record.setupFailed,
            workspaceId: record.workspaceId,
            workspaceResultId: record.workspaceResultId,
            childSessionFile: record.childSessionFile,
            childSessionLeafId: record.childSessionLeafId,
            resumable: record.resumable,
            readOnlyReason: record.readOnlyReason,
            restoredProgress: record.progress,
            restoredMutationReport: record.mutationReport,
        };
    }
}
