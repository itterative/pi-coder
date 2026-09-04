import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PI_CODER_AGENT_SESSIONS_DIR } from "../../../../common/constants";
import {
    type AgentDroppedProgressWriteListener,
    type AgentRunCheckpointIntent,
    type AgentRunPersistence,
    type AgentRefusedWriteListener,
    type AgentContinuationLease,
    type PersistedAgentRun,
} from "../../contracts/runs";
import { openAgentMetadataDatabase, type AgentMetadataDatabase } from "../../storage/metadata";
import {
    AGENT_RUN_SNAPSHOT_MARKER,
    type AgentRunSnapshotMarker,
    collectAgentRunSnapshotMarkers,
} from "../../storage/run-markers";
import {
    listAgentRunStatesInDatabase,
    upsertAgentRunStateInDatabase,
} from "../../storage/run-state";
import {
    listAgentRunSnapshotsInDatabase,
    listRunInstanceIdsWithSnapshotsInDatabase,
    type AgentRunSnapshotRow,
} from "../../storage/run-snapshots";
import {
    isAgentRunWorkingStatus,
    readAgentRunWorkingStateInDatabase,
} from "../../storage/run-working-state";
import { type ContinuationHead, initializeAgentRunContinuationHeads } from "./journal-heads";
import { type LeaseRow, heldLeaseUntil } from "./lease-ledger";
import { getAgentCwdSessionDir, inside } from "./session-paths";
import { type AgentRunStateWriter, createAgentRunStateWriter } from "./state-writer";
import {
    ENABLE_WORKING_STATE_OVERLAY,
    applyWorkingStateOverlay,
    parseRecord,
    validateAgentRunSnapshot,
} from "./stored-record";

/** One parent-session checkpoint marker, as collected from the parent transcript. */
type MarkerEntry = ReturnType<typeof collectAgentRunSnapshotMarkers>[number];

/** Snapshot rows keyed by the id its marker names. */
type SnapshotRows = ReadonlyMap<string, AgentRunSnapshotRow>;

export interface LoadedAgentRunPersistence {
    persistence: AgentRunPersistence;
    records: PersistedAgentRun[];
    catalog: AgentRunStateWriter;
    diagnostics?: string[];
}

export interface AgentRunPersistenceOptions {
    /**
     * Called for every checkpoint write the durable layer refuses.
     *
     * `save` keeps its boolean contract, so without this the reason is only visible in the one-shot
     * user warning inside `RefusedWriteReporter` and is lost entirely for every later refusal.
     */
    onRefusedWrite?: AgentRefusedWriteListener;
    /**
     * Called for every progress write this process chose not to store.
     *
     * A dropped frame carries no authority, so it must never spend the one-shot user warning that a refused
     * checkpoint uses; this is the unbudgeted observability channel for it.
     */
    onDroppedProgress?: AgentDroppedProgressWriteListener;
}

async function withDatabaseFailureCleanup<T>(
    database: AgentMetadataDatabase,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        try {
            await database.close();
        } catch {
            // Preserve the original load failure; the connection is best-effort cleanup.
        }
        throw error;
    }
}

/** Where one parent session's child transcripts and metadata database live. */
interface SessionLayout {
    ownerSessionId: string;
    childSessionDir: string;
    workspacesDir: string;
    /**
     * Real SDK sessions expose an entry index. A session manager without one is a test or ephemeral
     * facade, so markers carry no authority and the pre-V2 state rows are read instead.
     */
    hasEntryIndex: boolean;
}

function sessionLayout(ctx: ExtensionContext, agentSessionsDir: string): SessionLayout | undefined {
    if (!ctx.sessionManager.getSessionFile()) return undefined;

    const ownerSessionId = ctx.sessionManager.getSessionId();
    const childSessionDir = path.join(
        getAgentCwdSessionDir(ctx.cwd, { agentSessionsDir }),
        ownerSessionId,
    );
    fs.mkdirSync(childSessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(childSessionDir, 0o700);

    const sessionManager = ctx.sessionManager as unknown as { getEntries?: unknown };
    return {
        ownerSessionId,
        childSessionDir,
        workspacesDir: path.join(path.dirname(path.resolve(agentSessionsDir)), "workspaces"),
        hasEntryIndex: typeof sessionManager.getEntries === "function",
    };
}

/** All markers the parent transcript holds, and the subset reachable from the active branch. */
interface ParentMarkers {
    all: MarkerEntry[];
    active: MarkerEntry[];
}

function collectParentMarkers(ctx: ExtensionContext, hasEntryIndex: boolean): ParentMarkers {
    const allParentEntries = hasEntryIndex ? ctx.sessionManager.getEntries() : [];
    const activeBranchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    const all = collectAgentRunSnapshotMarkers(allParentEntries);
    return { all, active: all.filter((entry) => activeBranchIds.has(entry.entryId)) };
}

/**
 * Resolves marker rows into restorable records and accumulates why a checkpoint was skipped.
 *
 * A missing row and an identity mismatch are separate diagnostics because they need different fixes:
 * the first means the database was wiped or never written, the second means the parent transcript and
 * the database disagree about which run a marker belongs to. A missing row is not a diagnostic at all when
 * the same physical run still has surviving rows: that is the signature of a checkpoint the snapshot GC
 * reclaimed, and the branch resolves to the next-older surviving checkpoint instead.
 */
class SnapshotValidator {
    readonly diagnostics: string[] = [];

    constructor(
        private readonly rows: SnapshotRows,
        private readonly ownerSessionId: string,
        private readonly childSessionDir: string,
        private readonly reclaimedInstances: ReadonlySet<string> = new Set(),
    ) {}

    rowFor(snapshotId: string): AgentRunSnapshotRow | undefined {
        return this.rows.get(snapshotId);
    }

    /** The record a marker names, or undefined after recording why it cannot be restored. */
    recordFor(entry: MarkerEntry): PersistedAgentRun | undefined {
        const snapshot = this.rows.get(entry.marker.snapshotId);
        if (!snapshot) {
            if (!this.reclaimedInstances.has(entry.marker.runInstanceId)) {
                this.diagnostics.push(
                    `Could not restore ${entry.marker.runId}: parent marker references a missing SQLite snapshot.`,
                );
            }
            return undefined;
        }
        const parsed = this.validate(snapshot, entry.marker);
        if (!parsed) {
            this.diagnostics.push(
                `Could not restore ${entry.marker.runId}: parent marker and SQLite snapshot identity do not match.`,
            );
        }
        return parsed;
    }

    /** Validates a row the caller already holds, recording nothing. */
    validate(
        snapshot: AgentRunSnapshotRow,
        marker: AgentRunSnapshotMarker,
    ): PersistedAgentRun | undefined {
        return validateAgentRunSnapshot(
            snapshot,
            marker,
            this.ownerSessionId,
            this.childSessionDir,
        );
    }
}

/**
 * The head each physical run reached anywhere in this parent session, used to seed the writer's
 * compare-and-set expectations. A run whose row is gone is skipped silently: it is not resumable here
 * either, and the active-branch pass reports it with its own diagnostic.
 */
function collectSessionHeads(
    validator: SnapshotValidator,
    entries: MarkerEntry[],
    ownerSessionId: string,
): Map<string, ContinuationHead> {
    const heads = new Map<string, ContinuationHead>();
    for (const entry of entries) {
        const snapshot = validator.rowFor(entry.marker.snapshotId);
        if (!snapshot || !validator.recordFor(entry)) continue;

        heads.set(entry.marker.runInstanceId, {
            ownerSessionId,
            snapshotId: entry.marker.snapshotId,
            runId: entry.marker.runId,
            updatedAt: snapshot.updatedAt,
            createdSequence: snapshot.createdSequence,
        });
    }
    return heads;
}

/** The newest reachable marker per physical run on the active branch. */
function collectBranchHeads(
    validator: SnapshotValidator,
    entries: MarkerEntry[],
): Map<string, { snapshotId: string; order: number }> {
    const heads = new Map<string, { snapshotId: string; order: number }>();
    for (const entry of entries) {
        if (!validator.recordFor(entry)) continue;

        const previous = heads.get(entry.marker.runInstanceId);
        if (!previous || previous.order <= entry.order) {
            heads.set(entry.marker.runInstanceId, {
                snapshotId: entry.marker.snapshotId,
                order: entry.order,
            });
        }
    }
    return heads;
}

/**
 * Sharpen where a crashed child actually stopped, using each run's working row.
 *
 * Only a run this branch may resume, whose last checkpoint is still unclean, and whose record already names
 * a child transcript can be moved: every other record keeps exactly what its marker describes, because
 * markers stay the authority for which checkpoint a branch restores. Each candidate is read per run rather
 * than batched, because the candidate set is the interrupted runs of one parent session — a handful.
 */
async function overlayWorkingState(
    database: AgentMetadataDatabase,
    records: Map<string, PersistedAgentRun>,
): Promise<void> {
    if (!ENABLE_WORKING_STATE_OVERLAY) {
        return;
    }

    for (const [key, record] of records) {
        const runInstanceId = record.runInstanceId;
        const childSessionFile = record.childSessionFile;
        if (
            record.resumable !== true ||
            !isAgentRunWorkingStatus(record.status) ||
            typeof runInstanceId !== "string" ||
            typeof childSessionFile !== "string"
        ) {
            continue;
        }

        const working = await readAgentRunWorkingStateInDatabase(database, runInstanceId);
        if (!working) {
            continue;
        }

        const lease = (await database.get(
            `
            SELECT process_token, owner_pid, lease_until
            FROM agent_run_continuation_leases
            WHERE run_instance_id = ?
        `,
            runInstanceId,
        )) as LeaseRow | undefined;
        records.set(
            key,
            applyWorkingStateOverlay(record, working, {
                leaseIsHeld: heldLeaseUntil(lease, Date.now()) !== undefined,
                leafExists: (leafId) => childTranscriptHasLeaf(childSessionFile, leafId),
            }),
        );
    }
}

/** Whether the child transcript still holds this entry; a stale hint must never break a restore. */
function childTranscriptHasLeaf(childSessionFile: string, leafId: string): boolean {
    try {
        return Boolean(SessionManager.open(childSessionFile).getEntry(leafId));
    } catch {
        return false;
    }
}

/**
 * Pre-V2 run state, kept read-only for session facades without an entry index. Real SDK sessions
 * always expose one, so these rows never become restore authority in production.
 */
async function collectLegacyRecords(
    ctx: ExtensionContext,
    database: AgentMetadataDatabase,
    layout: SessionLayout,
): Promise<Map<string, PersistedAgentRun>> {
    const records = new Map<string, PersistedAgentRun>();
    if (layout.hasEntryIndex) return records;

    const legacy = await withDatabaseFailureCleanup(database, async () => {
        const legacyIds = ["root", ...ctx.sessionManager.getBranch().map((entry) => entry.id)];
        return listAgentRunStatesInDatabase(database, layout.ownerSessionId, legacyIds);
    });

    for (const stored of legacy) {
        const parsed = parseRecord(stored.state, layout.ownerSessionId, layout.childSessionDir);
        if (parsed) {
            records.set(parsed.runId, parsed);
        }
    }
    return records;
}

/**
 * The active-branch record for each physical run, marked resumable only when the session head still
 * points at the same snapshot. A run continued on another branch stays browsable but read-only.
 */
function resolveActiveRecords(
    validator: SnapshotValidator,
    branchHeads: ReadonlyMap<string, { snapshotId: string; order: number }>,
    sessionHeads: ReadonlyMap<string, ContinuationHead>,
    allMarkers: MarkerEntry[],
): Map<string, PersistedAgentRun> {
    const records = new Map<string, PersistedAgentRun>();
    for (const [runInstanceId, branchHead] of branchHeads) {
        const snapshot = validator.rowFor(branchHead.snapshotId);
        if (!snapshot) {
            validator.diagnostics.push(
                `Could not restore ${runInstanceId}: parent marker references a missing SQLite snapshot.`,
            );
            continue;
        }
        const marker = allMarkers.find(
            (entry) => entry.marker.snapshotId === branchHead.snapshotId,
        )?.marker;
        const parsed = marker ? validator.validate(snapshot, marker) : undefined;
        if (!parsed) {
            validator.diagnostics.push(
                `Could not restore ${snapshot.runId}: its SQLite snapshot is invalid.`,
            );
            continue;
        }

        parsed.runInstanceId = runInstanceId;
        if (sessionHeads.get(runInstanceId)?.snapshotId !== branchHead.snapshotId) {
            parsed.resumable = false;
            parsed.readOnlyReason = "continued on another branch";
        } else {
            parsed.resumable = true;
        }
        records.set(runInstanceId, parsed);
    }
    return records;
}

/**
 * Reports durable writes the authoritative snapshot path refused.
 *
 * The listener is called for every refusal so none goes unseen, while the user warning is budgeted to
 * one per session; a failing disk must not spam the UI. A lost catalog row never reaches here, because
 * the catalog is a lossy projection.
 */
class RefusedWriteReporter {
    private warned = false;

    constructor(
        private readonly ui: ExtensionContext["ui"],
        private readonly onRefusedWrite?: AgentRefusedWriteListener,
    ) {}

    report(record: PersistedAgentRun, message: string): void {
        this.onRefusedWrite?.({
            runId: record.runId,
            ...(record.runInstanceId ? { runInstanceId: record.runInstanceId } : {}),
            message,
        });
        if (this.warned) return;

        this.warned = true;
        this.ui.notify(
            `pi-coder agents: could not persist delegated run state: ${message}`,
            "warning",
        );
    }
}

/**
 * The persistence facade the manager holds, backed by the one metadata connection this load opened.
 *
 * Keeping that connection alive avoids recreating the `-wal`/`-shm` sidecars between ordinary
 * persistence calls; the writer closes it during session shutdown or tree switching.
 */
class AgentRunPersistenceFacade implements AgentRunPersistence {
    readonly ownerSessionId: string;
    readonly usesSnapshotMarkers: boolean;
    readonly childSessionDir: string;

    constructor(
        private readonly ctx: ExtensionContext,
        private readonly database: AgentMetadataDatabase,
        private readonly writer: AgentRunStateWriter,
        private readonly layout: SessionLayout,
        private readonly reporter: RefusedWriteReporter,
    ) {
        this.ownerSessionId = layout.ownerSessionId;
        this.usesSnapshotMarkers = layout.hasEntryIndex;
        this.childSessionDir = layout.childSessionDir;
    }

    async save(
        record: PersistedAgentRun,
        intent: AgentRunCheckpointIntent = "checkpoint",
    ): Promise<boolean> {
        const durableRecord = record.runInstanceId
            ? record
            : { ...record, runInstanceId: `legacy-${record.ownerSessionId}-${record.runId}` };
        const result = await this.writer.save(durableRecord, intent);
        if (!result.ok) {
            this.reporter.report(
                record,
                result.error instanceof Error ? result.error.message : String(result.error),
            );
            return false;
        }
        if (!this.layout.hasEntryIndex) {
            // A session facade without an entry index has no marker journal to stay out of, and the
            // pre-V2 state row is a single in-place upsert per branch entry, so a progress frame keeps
            // refreshing it exactly as it always did.
            await upsertAgentRunStateInDatabase(
                this.database,
                durableRecord,
                this.ctx.sessionManager.getLeafId() ?? "root",
            );
        }
        return true;
    }

    flush(): Promise<void> {
        return this.writer.flush();
    }

    close(): Promise<void> {
        return this.writer.close();
    }

    async acquireContinuationLease(
        runInstanceId: string,
        onLost?: () => void,
    ): Promise<AgentContinuationLease> {
        if (!this.writer.acquireContinuationLease) {
            return { release: () => {} };
        }
        return this.writer.acquireContinuationLease(runInstanceId, onLost);
    }

    deleteChildSession(sessionFile: string): void {
        const resolved = path.resolve(sessionFile);
        if (!inside(this.layout.childSessionDir, resolved)) return;

        try {
            fs.rmSync(resolved, { force: true });
        } catch {
            // Cleanup is best effort; state tombstones remain authoritative.
        }
    }
}

/** Appends the authoritative marker to the parent session, which is the commit point of a save. */
function appendMarker(ctx: ExtensionContext) {
    return (marker: {
        version: 2;
        snapshotId: string;
        runInstanceId: string;
        runId: string;
    }): string | undefined => {
        const sessionManager = ctx.sessionManager as unknown as {
            appendCustomEntry?: (type: string, data: unknown) => string;
        };
        return sessionManager.appendCustomEntry?.(AGENT_RUN_SNAPSHOT_MARKER, marker);
    };
}

/** Loads durable run state and retains the metadata connection for the writer's lifetime. */
export async function loadAgentRunPersistence(
    ctx: ExtensionContext,
    agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR,
    options: AgentRunPersistenceOptions = {},
): Promise<LoadedAgentRunPersistence | undefined> {
    const layout = sessionLayout(ctx, agentSessionsDir);
    if (!layout) return undefined;

    const markers = collectParentMarkers(ctx, layout.hasEntryIndex);
    const database = await openAgentMetadataDatabase(layout.workspacesDir);
    const snapshotIds = [...new Set(markers.all.map((entry) => entry.marker.snapshotId))];
    const snapshots = await withDatabaseFailureCleanup(database, () =>
        listAgentRunSnapshotsInDatabase(database, snapshotIds),
    );
    const rowsById = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
    // One extra query, only when a marker named a row this load could not fetch: it is what lets the
    // validator tell a reclaimed checkpoint from a wiped database. Returns without touching the database
    // when the list is empty, which is every healthy session.
    const reclaimedInstances = await withDatabaseFailureCleanup(database, () =>
        listRunInstanceIdsWithSnapshotsInDatabase(
            database,
            markers.all
                .filter((entry) => !rowsById.has(entry.marker.snapshotId))
                .map((entry) => entry.marker.runInstanceId),
        ),
    );
    const validator = new SnapshotValidator(
        rowsById,
        layout.ownerSessionId,
        layout.childSessionDir,
        reclaimedInstances,
    );

    const sessionHeads = collectSessionHeads(validator, markers.all, layout.ownerSessionId);
    await withDatabaseFailureCleanup(database, () =>
        initializeAgentRunContinuationHeads(database, sessionHeads),
    );

    const branchHeads = collectBranchHeads(validator, markers.active);
    const latest = await collectLegacyRecords(ctx, database, layout);
    for (const [runInstanceId, record] of resolveActiveRecords(
        validator,
        branchHeads,
        sessionHeads,
        markers.all,
    )) {
        latest.set(runInstanceId, record);
    }
    await withDatabaseFailureCleanup(database, () => overlayWorkingState(database, latest));

    const catalog = await withDatabaseFailureCleanup(database, async () =>
        createAgentRunStateWriter(ctx.cwd, database, appendMarker(ctx), {
            initialHeads: new Map(
                [...sessionHeads].map(([runInstanceId, head]) => [runInstanceId, head.snapshotId]),
            ),
            requireMarker: layout.hasEntryIndex,
            onDroppedProgress: options.onDroppedProgress,
        }),
    );
    const reporter = new RefusedWriteReporter(ctx.ui, options.onRefusedWrite);
    const persistence = new AgentRunPersistenceFacade(ctx, database, catalog, layout, reporter);
    return {
        persistence,
        records: [...latest.values()],
        catalog,
        diagnostics: validator.diagnostics,
    };
}
