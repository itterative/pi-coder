import type { PersistedAgentRun } from "../contracts/runs";
import type { AgentRun } from "./run-state";

/**
 * In-memory ownership of logical runs and bounded terminal-result ordering.
 *
 * This deliberately has no persistence, child-handle, or callback knowledge. Lifecycle code
 * retains control of removal ordering, so it can write tombstones and release leases first.
 */
export class AgentRunRegistry {
    private readonly runs = new Map<string, AgentRun>();
    private readonly terminalOrder: string[] = [];
    private nextRunNumber = 1;

    /** Current number of registered runs, terminal or not. */
    get size(): number {
        return this.runs.size;
    }

    /** Look up a run by its public ID. */
    find(runId: string): AgentRun | undefined {
        return this.runs.get(runId);
    }

    /** Whether a public run ID is already claimed in this process. */
    has(runId: string): boolean {
        return this.runs.has(runId);
    }

    /** Iterate every registered run, in insertion order. */
    all(): IterableIterator<AgentRun> {
        return this.runs.values();
    }

    /** Claim a public run ID for a run, replacing any previous entry. */
    add(run: AgentRun): void {
        this.runs.set(run.id, run);
    }

    /** Drop a run from the active registry without touching terminal retention. */
    remove(runId: string): void {
        this.runs.delete(runId);
    }

    /**
     * Advance the run-number counter past every ID used by already-persisted records.
     *
     * Keeps newly allocated IDs from colliding with runs a parent session restored, which is what
     * makes a stable `runId` safe to reference across sessions.
     */
    observePersistedRecords(records: readonly PersistedAgentRun[]): void {
        for (const record of records) {
            const suffix = /-(\d+)$/.exec(record.runId)?.[1];
            if (!suffix) {
                continue;
            }
            this.nextRunNumber = Math.max(this.nextRunNumber, Number(suffix) + 1);
        }
    }

    /** Allocate the next `<agent>-<n>` ID, or honour a requested ID for a revision. */
    allocateRunId(agentName: string, requestedRunId?: string): string {
        return requestedRunId ?? `${agentName}-${this.nextRunNumber++}`;
    }

    /** Record a terminal background result as collectable, oldest first. */
    retainTerminal(runId: string): void {
        this.terminalOrder.push(runId);
    }

    /** Pop the oldest retained terminal ID once the retention budget is exceeded. */
    takeExcessTerminal(maxRetainedResults: number): string | undefined {
        if (this.terminalOrder.length <= maxRetainedResults) {
            return undefined;
        }
        return this.terminalOrder.shift();
    }

    /** Stop tracking a run as a retained result, without unregistering or evicting anything. */
    forgetTerminal(runId: string): void {
        const terminalIndex = this.terminalOrder.indexOf(runId);
        if (terminalIndex >= 0) {
            this.terminalOrder.splice(terminalIndex, 1);
        }
    }
}
