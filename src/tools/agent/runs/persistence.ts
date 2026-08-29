import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PI_CODER_AGENT_SESSIONS_DIR } from "../../../common/constants";
import { normalizeCwdForSessionDirectory } from "../../../common/paths";
import {
    AgentContinuationLeaseBusyError,
    isAgentTerminalStatus,
    type AgentContinuationLease,
    type AgentRunPersistence,
    type PersistedAgentRun,
} from "../contracts/runs";
import { ZERO_USAGE } from "./usage";
import { parseAgentDefinitionSnapshot } from "../definitions/types";
import type { AgentRunCatalogRecord } from "../contracts/workspaces";
import {
    openAgentMetadataDatabase,
    type AgentMetadataDatabase,
} from "../storage/metadata";
import { upsertAgentRunCatalogRecordInDatabase } from "../storage/run-catalog";
import {
    AGENT_RUN_SNAPSHOT_MARKER,
    collectAgentRunSnapshotMarkers,
    type AgentRunSnapshotMarker,
} from "../storage/run-markers";
import {
    listAgentRunStatesInDatabase,
    upsertAgentRunStateInDatabase,
} from "../storage/run-state";
import {
    insertAgentRunSnapshotInDatabase,
    listAgentRunSnapshotsInDatabase,
    type AgentRunSnapshotRow,
} from "../storage/run-snapshots";

const RUN_ID = /^[a-z][a-z0-9_-]{0,63}-\d+$/;
const RESTORABLE_STATUSES = new Set<PersistedAgentRun["status"]>([
    "starting",
    "running",
    "waiting_for_parent",
    "interrupted",
    "completed",
    "failed",
    "aborted",
    "canceled",
    "removed",
]);

export { normalizeCwdForSessionDirectory } from "../../../common/paths";

export interface AgentCwdSessionDirOptions {
    agentSessionsDir?: string;
}

/** Returns the extension-local session directory for one cwd. */
export function getAgentCwdSessionDir(
    cwd: string,
    { agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR }: AgentCwdSessionDirOptions = {},
): string {
    const sessionDir = path.join(
        path.resolve(agentSessionsDir),
        normalizeCwdForSessionDirectory(cwd),
    );
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.resolve(agentSessionsDir), 0o700);
    fs.chmodSync(sessionDir, 0o700);
    return sessionDir;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cloneUsage(value: unknown): PersistedAgentRun["usageSnapshot"] {
    if (!value || typeof value !== "object") return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
    const usage = value as Partial<PersistedAgentRun["usageSnapshot"]>;
    const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : ZERO_USAGE.cost;
    return {
        input: finite(usage.input) ? usage.input : 0,
        output: finite(usage.output) ? usage.output : 0,
        cacheRead: finite(usage.cacheRead) ? usage.cacheRead : 0,
        cacheWrite: finite(usage.cacheWrite) ? usage.cacheWrite : 0,
        ...(finite(usage.cacheWrite1h) ? { cacheWrite1h: usage.cacheWrite1h } : {}),
        ...(finite(usage.reasoning) ? { reasoning: usage.reasoning } : {}),
        totalTokens: finite(usage.totalTokens) ? usage.totalTokens : 0,
        cost: {
            input: finite(cost.input) ? cost.input : 0,
            output: finite(cost.output) ? cost.output : 0,
            cacheRead: finite(cost.cacheRead) ? cost.cacheRead : 0,
            cacheWrite: finite(cost.cacheWrite) ? cost.cacheWrite : 0,
            total: finite(cost.total) ? cost.total : 0,
        },
    };
}

function boundedString(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    return value.slice(0, max);
}

function boundedToolCounts(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const counts: Record<string, number> = {};
    for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
        if (name.length > 80 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
        counts[name] = count;
    }
    return Object.keys(counts).length ? counts : undefined;
}

function inside(directory: string, candidate: string): boolean {
    const relative = path.relative(directory, candidate);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function responsePreview(record: PersistedAgentRun): string | undefined {
    const text = (record.progress.output || record.progress.lastAssistantMessage || "").replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}


export interface AgentRunStateWriter {
    save(record: PersistedAgentRun): { ok: true } | { ok: false; error: unknown };
    acquireContinuationLease?(runInstanceId: string, onLost?: () => void): AgentContinuationLease;
    flush(): Promise<void>;
    close(): void;
}

const CONTINUATION_LEASE_MS = 30_000;
// Pi and its child-agent runtime share one process, so a dead owner PID is a
// useful fast path for reclaiming a lease left by an abrupt process exit.
export const ENABLE_PID_LEASE_RECOVERY = true;
export const CONTINUATION_LEASE_RECOVERY_GRACE_MS = 250;

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but is not signalable. Unknown errors
        // fail closed and fall back to normal lease expiry.
        return error instanceof Error && (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

type ContinuationHead = {
    ownerSessionId: string;
    snapshotId: string;
    runId: string;
    updatedAt: number;
    createdSequence: number;
};

export function initializeAgentRunContinuationHeads(
    database: AgentMetadataDatabase,
    heads: ReadonlyMap<string, ContinuationHead>,
): void {
    if (heads.size === 0) return;
    database.exec("BEGIN IMMEDIATE");
    try {
        const insert = database.prepare(`
            INSERT INTO agent_run_continuation_heads (
                run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence, pending
            ) VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT (run_instance_id) DO UPDATE SET
                owner_session_id = excluded.owner_session_id,
                run_id = excluded.run_id,
                snapshot_id = excluded.snapshot_id,
                updated_at = excluded.updated_at,
                created_sequence = excluded.created_sequence,
                pending = 0
            WHERE excluded.created_sequence > agent_run_continuation_heads.created_sequence
               OR (
                   agent_run_continuation_heads.pending = 1
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_run_continuation_leases
                       WHERE run_instance_id = agent_run_continuation_heads.run_instance_id
                         AND lease_until > ?
                   )
               )
        `);
        for (const [runInstanceId, head] of heads) {
            insert.run(runInstanceId, head.ownerSessionId, head.runId, head.snapshotId, head.updatedAt, head.createdSequence, Date.now());
        }
        database.exec("COMMIT");
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Preserve the initialization error.
        }
        throw error;
    }
}

function catalogRecord(record: PersistedAgentRun, parentCwd: string): AgentRunCatalogRecord {
    return {
        ownerSessionId: record.ownerSessionId,
        ownerPid: record.ownerPid,
        runId: record.runId,
        runInstanceId: record.runInstanceId,
        parentCwd: record.parentCwd ?? parentCwd,
        executionCwd: record.cwd,
        title: record.title ?? "Delegated task",
        agent: record.agent,
        agentSource: record.agentSource,
        ...(record.definitionSnapshot ? { definitionSnapshot: record.definitionSnapshot } : {}),
        task: record.task,
        status: record.status,
        ...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}),
        background: record.background,
        mutating: record.mutating,
        workspaceId: record.workspaceId,
        workspaceResultId: record.workspaceResultId,
        childSessionFile: record.childSessionFile,
        childSessionLeafId: record.childSessionLeafId,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        usageSnapshot: record.usageSnapshot,
        responsePreview: responsePreview(record),
        mutationReport: record.mutationReport,
    };
}

export interface AgentRunStateWriterOptions {
    initialHeads?: ReadonlyMap<string, string>;
    requireMarker?: boolean;
}

export function createAgentRunStateWriter(
    parentCwd: string,
    database: AgentMetadataDatabase,
    appendMarker: (marker: { version: 2; snapshotId: string; runInstanceId: string; runId: string }) => string | undefined,
    {
        initialHeads = new Map(),
        requireMarker = true,
    }: AgentRunStateWriterOptions = {},
): AgentRunStateWriter {
    let closed = false;
    const processToken = randomUUID();
    const expectedHeads = new Map<string, string | undefined>(initialHeads);
    const knownHeads = new Set(initialHeads.keys());
    const activeLeases = new Map<string, { token: string; timer: ReturnType<typeof setInterval>; onLost?: () => void }>();
    const lostLeases = new Set<string>();

    const markLeaseLost = (runInstanceId: string, token: string): void => {
        const active = activeLeases.get(runInstanceId);
        if (!active || active.token !== token) return;
        clearInterval(active.timer);
        activeLeases.delete(runInstanceId);
        lostLeases.add(runInstanceId);
        active.onLost?.();
    };

    const renewLease = (runInstanceId: string, token: string): void => {
        let lost = false;
        try {
            database.exec("BEGIN IMMEDIATE");
            const result = database.prepare(`
                UPDATE agent_run_continuation_leases
                SET lease_until = ?
                WHERE run_instance_id = ? AND process_token = ?
            `).run(Date.now() + CONTINUATION_LEASE_MS, runInstanceId, token);
            database.exec("COMMIT");
            lost = result.changes === 0;
        } catch {
            try {
                database.exec("ROLLBACK");
            } catch {
                // Treat an unavailable database as a lost lease.
            }
            lost = true;
        }
        if (!lost) return;
        markLeaseLost(runInstanceId, token);
    };

    const releaseLease = (runInstanceId: string, token: string): void => {
        const active = activeLeases.get(runInstanceId);
        if (!active || active.token !== token) return;
        clearInterval(active.timer);
        try {
            database.exec("BEGIN IMMEDIATE");
            database.prepare(`
                DELETE FROM agent_run_continuation_leases
                WHERE run_instance_id = ? AND process_token = ?
            `).run(runInstanceId, token);
            database.exec("COMMIT");
        } catch {
            try {
                database.exec("ROLLBACK");
            } catch {
                // Lease expiry remains the recovery path after a release failure.
            }
        } finally {
            activeLeases.delete(runInstanceId);
        }
    };

    const acquireContinuationLease = (runInstanceId: string, onLost?: () => void): AgentContinuationLease => {
        if (closed) throw new Error("Agent run state storage is closed.");
        if (lostLeases.has(runInstanceId)) {
            throw new Error("Delegated run continuation lease was lost; reload the parent session before retrying.");
        }
        const now = Date.now();
        const leaseToken = `${processToken}:${randomUUID()}`;
        database.exec("BEGIN IMMEDIATE");
        try {
            const current = database.prepare(`
                SELECT snapshot_id, owner_session_id
                FROM agent_run_continuation_heads
                WHERE run_instance_id = ?
            `).get(runInstanceId) as { snapshot_id?: string; owner_session_id?: string } | undefined;
            if (!knownHeads.has(runInstanceId)) {
                expectedHeads.set(runInstanceId, typeof current?.snapshot_id === "string" ? current.snapshot_id : undefined);
                knownHeads.add(runInstanceId);
            }
            const expected = expectedHeads.get(runInstanceId);
            const actual = typeof current?.snapshot_id === "string" ? current.snapshot_id : undefined;
            if (actual !== expected) {
                throw new Error("Delegated run continuation is stale; another process has already continued it.");
            }
            const existingLease = database.prepare(`
                SELECT process_token, owner_pid, lease_until
                FROM agent_run_continuation_leases
                WHERE run_instance_id = ?
            `).get(runInstanceId) as {
                process_token?: string;
                owner_pid?: number;
                lease_until?: number;
            } | undefined;
            const activeLease = typeof existingLease?.lease_until === "number"
                && existingLease.lease_until > now;
            const ownerIsDead = ENABLE_PID_LEASE_RECOVERY
                && activeLease
                && typeof existingLease?.owner_pid === "number"
                && !isProcessAlive(existingLease.owner_pid);
            if (activeLease && !ownerIsDead) {
                throw new AgentContinuationLeaseBusyError(existingLease.lease_until!);
            }
            database.prepare(`
                INSERT INTO agent_run_continuation_leases (
                    run_instance_id, owner_session_id, process_token, owner_pid, lease_until
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (run_instance_id) DO UPDATE SET
                    owner_session_id = excluded.owner_session_id,
                    process_token = excluded.process_token,
                    owner_pid = excluded.owner_pid,
                    lease_until = excluded.lease_until
            `).run(
                runInstanceId,
                typeof current?.owner_session_id === "string" ? current.owner_session_id : "",
                leaseToken,
                process.pid,
                now + CONTINUATION_LEASE_MS,
            );
            database.exec("COMMIT");
        } catch (error) {
            try {
                database.exec("ROLLBACK");
            } catch {
                // Preserve the stale/ownership error.
            }
            throw error;
        }
        const timer = setInterval(() => renewLease(runInstanceId, leaseToken), CONTINUATION_LEASE_MS / 3);
        timer.unref?.();
        activeLeases.set(runInstanceId, { token: leaseToken, timer, onLost });
        return { release: () => releaseLease(runInstanceId, leaseToken) };
    };

    return {
        save(record) {
            if (closed) {
                return { ok: false, error: new Error("Agent run state storage is closed.") };
            }
            if (!record.runInstanceId) {
                return { ok: false, error: new Error("Delegated run is missing its physical run identity.") };
            }
            const runInstanceId = record.runInstanceId;
            let automaticLease: AgentContinuationLease | undefined;
            if (!activeLeases.has(runInstanceId)) {
                try {
                    automaticLease = acquireContinuationLease(runInstanceId);
                } catch (error) {
                    return { ok: false, error };
                }
            }
            const finishSave = <T extends { ok: boolean }>(result: T): T => {
                automaticLease?.release();
                return result;
            };
            let snapshot: ReturnType<typeof insertAgentRunSnapshotInDatabase>;
            try {
                database.exec("BEGIN IMMEDIATE");
                const current = database.prepare(`
                    SELECT snapshot_id
                    FROM agent_run_continuation_heads
                    WHERE run_instance_id = ?
                `).get(runInstanceId) as { snapshot_id?: string } | undefined;
                if (!knownHeads.has(runInstanceId)) {
                    expectedHeads.set(runInstanceId, typeof current?.snapshot_id === "string" ? current.snapshot_id : undefined);
                    knownHeads.add(runInstanceId);
                }
                const expected = expectedHeads.get(runInstanceId);
                const actual = typeof current?.snapshot_id === "string" ? current.snapshot_id : undefined;
                if (actual !== expected) {
                    database.exec("ROLLBACK");
                    return finishSave({
                        ok: false,
                        error: new Error("Delegated run continuation is stale; another process has already continued it."),
                    });
                }
                const lease = database.prepare(`
                    SELECT process_token, lease_until
                    FROM agent_run_continuation_leases
                    WHERE run_instance_id = ?
                `).get(runInstanceId) as { process_token?: string; lease_until?: number } | undefined;
                const activeLease = activeLeases.get(runInstanceId);
                if (typeof lease?.lease_until === "number" && lease.lease_until > Date.now()) {
                    if (!activeLease || lease.process_token !== activeLease.token) {
                        database.exec("ROLLBACK");
                        return finishSave({
                            ok: false,
                            error: new Error("Delegated run continuation is already owned by another process."),
                        });
                    }
                } else if (activeLease) {
                    database.exec("ROLLBACK");
                    markLeaseLost(runInstanceId, activeLease.token);
                    return finishSave({
                        ok: false,
                        error: new Error("Delegated run continuation lease expired or was lost."),
                    });
                } else if (typeof lease?.process_token === "string") {
                    database.prepare(`
                        DELETE FROM agent_run_continuation_leases
                        WHERE run_instance_id = ? AND process_token = ?
                    `).run(runInstanceId, lease.process_token);
                }
                snapshot = insertAgentRunSnapshotInDatabase(database, record);
                database.prepare(`
                    INSERT INTO agent_run_continuation_heads (
                        run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence, pending
                    ) VALUES (?, ?, ?, ?, ?, ?, 1)
                    ON CONFLICT (run_instance_id) DO UPDATE SET
                        owner_session_id = excluded.owner_session_id,
                        run_id = excluded.run_id,
                        snapshot_id = excluded.snapshot_id,
                        updated_at = excluded.updated_at,
                        created_sequence = excluded.created_sequence,
                        pending = 1
                `).run(
                    runInstanceId,
                    record.ownerSessionId,
                    record.runId,
                    snapshot.snapshotId,
                    record.updatedAt,
                    snapshot.createdSequence,
                );
                database.exec("COMMIT");
            } catch (error) {
                try {
                    database.exec("ROLLBACK");
                } catch {
                    // Preserve the original write failure.
                }
                return finishSave({ ok: false, error });
            }

            // Hold the SQLite write lock while renewing ownership, appending the
            // external marker, and updating the head. A competing process cannot
            // acquire the expired lease between those operations.
            let markerAppended = false;
            try {
                database.exec("BEGIN IMMEDIATE");
                const activeLease = activeLeases.get(runInstanceId);
                if (!activeLease) {
                    database.exec("ROLLBACK");
                    return finishSave({
                        ok: false,
                        error: new Error("Delegated run continuation lease was lost."),
                    });
                }
                const renewed = database.prepare(`
                    UPDATE agent_run_continuation_leases
                    SET lease_until = ?
                    WHERE run_instance_id = ? AND process_token = ?
                `).run(Date.now() + CONTINUATION_LEASE_MS, runInstanceId, activeLease.token);
                if (renewed.changes === 0) {
                    database.exec("ROLLBACK");
                    markLeaseLost(runInstanceId, activeLease.token);
                    return finishSave({
                        ok: false,
                        error: new Error("Delegated run continuation lease expired or was lost."),
                    });
                }
                const current = database.prepare(`
                    SELECT snapshot_id, pending
                    FROM agent_run_continuation_heads
                    WHERE run_instance_id = ?
                `).get(runInstanceId) as { snapshot_id?: string; pending?: number } | undefined;
                if (current?.snapshot_id !== snapshot.snapshotId || current.pending !== 1) {
                    database.exec("ROLLBACK");
                    return finishSave({
                        ok: false,
                        error: new Error("Delegated run continuation reservation was lost before its marker was committed."),
                    });
                }
                const markerEntryId = appendMarker({
                    version: 2,
                    snapshotId: snapshot.snapshotId,
                    runInstanceId,
                    runId: record.runId,
                });
                if (requireMarker && typeof markerEntryId !== "string") {
                    throw new Error("Parent session marker could not be appended.");
                }
                markerAppended = true;
                database.prepare(`
                    INSERT INTO agent_run_continuation_heads (
                        run_instance_id, owner_session_id, run_id, snapshot_id, updated_at, created_sequence, pending
                    ) VALUES (?, ?, ?, ?, ?, ?, 0)
                    ON CONFLICT (run_instance_id) DO UPDATE SET
                        owner_session_id = excluded.owner_session_id,
                        run_id = excluded.run_id,
                        snapshot_id = excluded.snapshot_id,
                        updated_at = excluded.updated_at,
                        created_sequence = excluded.created_sequence,
                        pending = 0
                `).run(
                    runInstanceId,
                    record.ownerSessionId,
                    record.runId,
                    snapshot.snapshotId,
                    record.updatedAt,
                    snapshot.createdSequence,
                );
                try {
                    upsertAgentRunCatalogRecordInDatabase(database, {
                        ...catalogRecord(record, parentCwd),
                        latestSnapshotId: snapshot.snapshotId,
                    });
                } catch {
                    // Catalog is a lossy projection. The marker/snapshot remains authoritative.
                }
                database.exec("COMMIT");
                expectedHeads.set(runInstanceId, snapshot.snapshotId);
                return finishSave({ ok: true });
            } catch (error) {
                try {
                    database.exec("ROLLBACK");
                } catch {
                    // Preserve the marker as the authoritative recovery record.
                }
                if (markerAppended) {
                    expectedHeads.set(runInstanceId, snapshot.snapshotId);
                    return finishSave({ ok: true });
                }
                return finishSave({ ok: false, error });
            }
        },
        acquireContinuationLease,
        async flush() {},
        close() {
            if (closed) return;
            for (const [runInstanceId, active] of activeLeases) {
                releaseLease(runInstanceId, active.token);
            }
            closed = true;
            database.close();
        },
    };
}

function safeExistingChildFile(childSessionDir: string, candidate: string): string | undefined {
    try {
        const resolved = path.resolve(candidate);
        const stat = fs.lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
        const real = fs.realpathSync(resolved);
        return inside(childSessionDir, real) ? real : undefined;
    } catch {
        return undefined;
    }
}

function parseRecord(value: unknown, ownerSessionId: string, childSessionDir: string): PersistedAgentRun | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Partial<PersistedAgentRun>;
    if (
        record.version !== 1
        || record.ownerSessionId !== ownerSessionId
        || typeof record.runId !== "string"
        || !RUN_ID.test(record.runId)
        || typeof record.agent !== "string"
        || !record.runId.startsWith(`${record.agent}-`)
        || typeof record.agentSource !== "string"
        || typeof record.definitionFingerprint !== "string"
        || !/^[a-f0-9]{64}$/.test(record.definitionFingerprint)
        || typeof record.status !== "string"
        || !RESTORABLE_STATUSES.has(record.status as PersistedAgentRun["status"])
        || typeof record.background !== "boolean"
        || typeof record.mutating !== "boolean"
        || !finite(record.startedAt)
        || !finite(record.updatedAt)
    ) return undefined;

    const progressValue = record.progress && typeof record.progress === "object" ? record.progress : undefined;
    const activity = Array.isArray(progressValue?.recentActivity)
        ? progressValue.recentActivity.filter((item): item is string => typeof item === "string").slice(-8).map((item) => item.slice(0, 500))
        : [];
    const phase = boundedString(progressValue?.phase, 120);
    const lastAssistantMessage = boundedString(progressValue?.lastAssistantMessage, 32_000);
    const lastToolActivity = boundedString(progressValue?.lastToolActivity, 500);
    const failedToolCalls = finite(progressValue?.failedToolCalls)
        && Number.isSafeInteger(progressValue?.failedToolCalls)
        && progressValue.failedToolCalls >= 0
        ? progressValue.failedToolCalls
        : undefined;
    const toolCounts = boundedToolCounts(progressValue?.toolCounts);
    const childSessionFile = boundedString(record.childSessionFile, 4_096);
    const resolvedChildFile = childSessionFile
        ? safeExistingChildFile(childSessionDir, childSessionFile)
        : undefined;
    const questionValue = record.question && typeof record.question === "object" ? record.question : undefined;
    const mutationValue = record.mutationReport && typeof record.mutationReport === "object" ? record.mutationReport : undefined;
    const definitionSnapshot = parseAgentDefinitionSnapshot(record.definitionSnapshot);

    return {
        version: 1,
        ownerSessionId,
        ownerPid: typeof record.ownerPid === "number" && Number.isSafeInteger(record.ownerPid) ? record.ownerPid : undefined,
        runId: record.runId,
        ...(typeof record.runInstanceId === "string" ? { runInstanceId: record.runInstanceId } : {}),
        title: boundedString(record.title, 80),
        agent: record.agent.slice(0, 64),
        agentSource: record.agentSource.slice(0, 32),
        agentFilePath: boundedString(record.agentFilePath, 4_096),
        definitionFingerprint: record.definitionFingerprint,
        ...(definitionSnapshot ? { definitionSnapshot } : {}),
        task: boundedString(record.task, 16_000) ?? "Restored delegated task",
        status: record.status as PersistedAgentRun["status"],
        ...(isAgentTerminalStatus(record.terminalStatus)
            ? { terminalStatus: record.terminalStatus }
            : {}),
        background: record.background,
        mutating: record.mutating,
        workspaceId: boundedString(record.workspaceId, 200),
        workspaceResultId: boundedString(record.workspaceResultId, 200),
        question: typeof questionValue?.question === "string" ? {
            question: questionValue.question.slice(0, 4_000),
            context: boundedString(questionValue.context, 12_000),
            options: Array.isArray(questionValue.options)
                ? questionValue.options.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 1_000))
                : undefined,
            recommendation: boundedString(questionValue.recommendation, 4_000),
        } : undefined,
        progress: {
            output: boundedString(progressValue?.output, 32_000) ?? "",
            recentActivity: activity,
            ...(phase ? { phase } : {}),
            ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
            ...(lastToolActivity ? { lastToolActivity } : {}),
            ...(toolCounts ? { toolCounts } : {}),
            ...(failedToolCalls !== undefined ? { failedToolCalls } : {}),
        },
        usageCheckpoint: cloneUsage(record.usageCheckpoint),
        usageSnapshot: cloneUsage(record.usageSnapshot),
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        parentCwd: boundedString(record.parentCwd, 4_096),
        cwd: boundedString(record.cwd, 4_096),
        childSessionFile: resolvedChildFile,
        ...(record.childSessionLeafId === null || typeof record.childSessionLeafId === "string"
            ? { childSessionLeafId: record.childSessionLeafId }
            : {}),
        ...(record.resumable === false ? { resumable: false } : {}),
        ...(typeof record.readOnlyReason === "string" ? { readOnlyReason: record.readOnlyReason.slice(0, 500) } : {}),
        terminalContent: boundedString(record.terminalContent, 48_000),
        terminalError: boundedString(record.terminalError, 4_000),
        terminalIsError: typeof record.terminalIsError === "boolean" ? record.terminalIsError : undefined,
        setupFailed: record.setupFailed === true ? true : undefined,
        mutationReport: mutationValue ? {
            changedFiles: Array.isArray(mutationValue.changedFiles)
                ? mutationValue.changedFiles.filter((item): item is string => typeof item === "string").slice(0, 1_000).map((item) => item.slice(0, 4_096))
                : [],
            ...(Array.isArray(mutationValue.readFiles) && mutationValue.readFiles.length
                ? {
                    readFiles: mutationValue.readFiles
                        .filter((item): item is string => typeof item === "string")
                        .slice(0, 1_000)
                        .map((item) => item.slice(0, 4_096)),
                }
                : {}),
            bashApproved: mutationValue.bashApproved === true,
            interrupted: mutationValue.interrupted === true,
        } : undefined,
    };
}

export function validateAgentRunSnapshot(
    snapshot: AgentRunSnapshotRow,
    marker: AgentRunSnapshotMarker,
    ownerSessionId: string,
    childSessionDir: string,
): PersistedAgentRun | undefined {
    if (
        snapshot.ownerSessionId !== ownerSessionId
        || snapshot.payloadVersion !== 2
        || snapshot.runInstanceId !== marker.runInstanceId
        || snapshot.runId !== marker.runId
    ) return undefined;
    const parsed = parseRecord(snapshot.payload, ownerSessionId, childSessionDir);
    if (!parsed || parsed.runInstanceId !== marker.runInstanceId || parsed.runId !== marker.runId) return undefined;
    if (snapshot.childSessionFile !== undefined && parsed.childSessionLeafId === undefined) return undefined;
    if ((parsed.childSessionLeafId ?? null) !== snapshot.childSessionLeafId) return undefined;
    if ((snapshot.childSessionFile ? path.resolve(snapshot.childSessionFile) : undefined) !== parsed.childSessionFile) return undefined;
    if (snapshot.status !== parsed.status || snapshot.updatedAt !== parsed.updatedAt) return undefined;
    return parsed;
}

export interface LoadedAgentRunPersistence {
    persistence: AgentRunPersistence;
    records: PersistedAgentRun[];
    catalog: AgentRunStateWriter;
    diagnostics?: string[];
}

export async function loadAgentRunPersistence(
    ctx: ExtensionContext,
    agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR,
): Promise<LoadedAgentRunPersistence | undefined> {
    if (!ctx.sessionManager.getSessionFile()) return undefined;
    const ownerSessionId = ctx.sessionManager.getSessionId();
    const cwdSessionDir = getAgentCwdSessionDir(ctx.cwd, { agentSessionsDir });
    const childSessionDir = path.join(cwdSessionDir, ownerSessionId);
    fs.mkdirSync(childSessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(childSessionDir, 0o700);

    const hasEntryIndex = typeof (ctx.sessionManager as unknown as { getEntries?: unknown }).getEntries === "function";
    const allParentEntries = hasEntryIndex ? ctx.sessionManager.getEntries() : [];
    const activeBranchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    const allMarkers = collectAgentRunSnapshotMarkers(allParentEntries);
    const activeMarkers = allMarkers.filter((entry) => activeBranchIds.has(entry.entryId));
    const workspacesDir = path.join(path.dirname(path.resolve(agentSessionsDir)), "workspaces");
    const database = await openAgentMetadataDatabase(workspacesDir);
    const snapshotIds = [...new Set(allMarkers.map((entry) => entry.marker.snapshotId))];
    const snapshots = listAgentRunSnapshotsInDatabase(database, snapshotIds);
    const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
    const diagnostics: string[] = [];
    const validSnapshot = (
        entry: ReturnType<typeof collectAgentRunSnapshotMarkers>[number],
        snapshot: typeof snapshots[number] | undefined,
    ): PersistedAgentRun | undefined => {
        if (!snapshot) {
            diagnostics.push(`Could not restore ${entry.marker.runId}: parent marker references a missing SQLite snapshot.`);
            return undefined;
        }
        const parsed = validateAgentRunSnapshot(snapshot, entry.marker, ownerSessionId, childSessionDir);
        if (!parsed) {
            diagnostics.push(`Could not restore ${entry.marker.runId}: parent marker and SQLite snapshot identity do not match.`);
            return undefined;
        }
        return parsed;
    };
    const sessionHeads = new Map<string, ContinuationHead>();
    for (const entry of allMarkers) {
        const snapshot = snapshotsById.get(entry.marker.snapshotId);
        if (!snapshot || !validSnapshot(entry, snapshot)) continue;
        sessionHeads.set(entry.marker.runInstanceId, {
            ownerSessionId,
            snapshotId: entry.marker.snapshotId,
            runId: entry.marker.runId,
            updatedAt: snapshot.updatedAt,
            createdSequence: snapshot.createdSequence,
        });
    }
    initializeAgentRunContinuationHeads(database, sessionHeads);
    const branchHeads = new Map<string, { snapshotId: string; order: number }>();
    for (const entry of activeMarkers) {
        const snapshot = snapshotsById.get(entry.marker.snapshotId);
        if (!validSnapshot(entry, snapshot)) continue;
        const previous = branchHeads.get(entry.marker.runInstanceId);
        if (!previous || previous.order <= entry.order) {
            branchHeads.set(entry.marker.runInstanceId, {
                snapshotId: entry.marker.snapshotId,
                order: entry.order,
            });
        }
    }
    const latest = new Map<string, PersistedAgentRun>();
    // Read-only compatibility for the pre-V2 test/session facade. Real SDK
    // sessions always expose getEntries(), so legacy rows never become restore
    // authority in production.
    if (!hasEntryIndex) {
        const legacyIds = ["root", ...ctx.sessionManager.getBranch().map((entry) => entry.id)];
        const legacy = listAgentRunStatesInDatabase(database, ownerSessionId, legacyIds);
        for (const stored of legacy) {
            const parsed = parseRecord(stored.state, ownerSessionId, childSessionDir);
            if (parsed) latest.set(parsed.runId, parsed);
        }
    }
    for (const [runInstanceId, branchHead] of branchHeads) {
        const snapshot = snapshotsById.get(branchHead.snapshotId);
        if (!snapshot) {
            diagnostics.push(`Could not restore ${runInstanceId}: parent marker references a missing SQLite snapshot.`);
            continue;
        }
        const marker = allMarkers.find((entry) => entry.marker.snapshotId === branchHead.snapshotId)?.marker;
        const parsed = marker ? validateAgentRunSnapshot(snapshot, marker, ownerSessionId, childSessionDir) : undefined;
        if (!parsed) {
            diagnostics.push(`Could not restore ${snapshot.runId}: its SQLite snapshot is invalid.`);
            continue;
        }
        parsed.runInstanceId = runInstanceId;
        if (sessionHeads.get(runInstanceId)?.snapshotId !== branchHead.snapshotId) {
            parsed.resumable = false;
            parsed.readOnlyReason = "continued on another branch";
        } else {
            parsed.resumable = true;
        }
        latest.set(runInstanceId, parsed);
    }

    const catalog = createAgentRunStateWriter(
        ctx.cwd,
        database,
        (marker) => {
            const sessionManager = ctx.sessionManager as unknown as {
                appendCustomEntry?: (type: string, data: unknown) => string;
            };
            return sessionManager.appendCustomEntry?.(AGENT_RUN_SNAPSHOT_MARKER, marker);
        },
        {
            initialHeads: new Map([...sessionHeads].map(([runInstanceId, head]) => [runInstanceId, head.snapshotId])),
            requireMarker: hasEntryIndex,
        },
    );

    let persistenceWarningShown = false;
    const persistence: AgentRunPersistence = {
        ownerSessionId,
        usesSnapshotMarkers: hasEntryIndex,
        childSessionDir,
        save(record) {
            const durableRecord = record.runInstanceId
                ? record
                : { ...record, runInstanceId: `legacy-${record.ownerSessionId}-${record.runId}` };
            const result = catalog.save(durableRecord);
            if (result.ok && !hasEntryIndex) {
                upsertAgentRunStateInDatabase(
                    database,
                    durableRecord,
                    ctx.sessionManager.getLeafId() ?? "root",
                );
            }
            if (result.ok) return true;
            if (!persistenceWarningShown) {
                persistenceWarningShown = true;
                const message = result.error instanceof Error ? result.error.message : String(result.error);
                ctx.ui.notify(`pi-coder agents: could not persist delegated run state: ${message}`, "warning");
            }
            return false;
        },
        flush: () => catalog.flush(),
        close: () => catalog.close(),
        acquireContinuationLease: (runInstanceId, onLost) => {
            if (!catalog.acquireContinuationLease) {
                return { release: () => {} };
            }
            return catalog.acquireContinuationLease(runInstanceId, onLost);
        },
        deleteChildSession(sessionFile) {
            const resolved = path.resolve(sessionFile);
            if (!inside(childSessionDir, resolved)) return;
            try {
                fs.rmSync(resolved, { force: true });
            } catch {
                // Cleanup is best effort; state tombstones remain authoritative.
            }
        },
    };
    return {
        persistence,
        records: [...latest.values()],
        catalog,
        diagnostics,
    };
}
