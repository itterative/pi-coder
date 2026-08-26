import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PI_CODER_AGENT_SESSIONS_DIR } from "../../../common/constants";
import { normalizeCwdForSessionDirectory } from "../../../common/paths";
import type { AgentRunPersistence, PersistedAgentRun } from "../contracts/runs";
import { ZERO_USAGE } from "./usage";
import type { AgentRunCatalogRecord } from "../contracts/workspaces";
import {
    openAgentMetadataDatabase,
    type AgentMetadataDatabase,
} from "../storage/metadata";
import { upsertAgentRunCatalogRecordInDatabase } from "../storage/run-catalog";
import {
    AGENT_RUN_SNAPSHOT_MARKER,
    collectAgentRunSnapshotMarkers,
} from "../storage/run-markers";
import {
    listAgentRunStatesInDatabase,
    upsertAgentRunStateInDatabase,
} from "../storage/run-state";
import {
    insertAgentRunSnapshotInDatabase,
    listAgentRunSnapshotsInDatabase,
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

/** Returns the extension-local session directory for one cwd. */
export function getAgentCwdSessionDir(
    cwd: string,
    agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR,
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
    flush(): Promise<void>;
    close(): void;
}

function catalogRecord(record: PersistedAgentRun, parentCwd: string): AgentRunCatalogRecord {
    return {
        ownerSessionId: record.ownerSessionId,
        runId: record.runId,
        runInstanceId: record.runInstanceId,
        parentCwd: record.parentCwd ?? parentCwd,
        executionCwd: record.cwd,
        title: record.title ?? "Delegated task",
        agent: record.agent,
        agentSource: record.agentSource,
        task: record.task,
        status: record.status,
        background: record.background,
        mutating: record.mutating,
        workspaceId: record.workspaceId,
        childSessionFile: record.childSessionFile,
        childSessionLeafId: record.childSessionLeafId,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        usageSnapshot: record.usageSnapshot,
        responsePreview: responsePreview(record),
        mutationReport: record.mutationReport,
    };
}

export function createAgentRunStateWriter(
    parentCwd: string,
    database: AgentMetadataDatabase,
    appendMarker: (marker: { version: 2; snapshotId: string; runInstanceId: string; runId: string }) => void,
): AgentRunStateWriter {
    let closed = false;
    return {
        save(record) {
            if (closed) {
                return { ok: false, error: new Error("Agent run state storage is closed.") };
            }
            if (!record.runInstanceId) {
                return { ok: false, error: new Error("Delegated run is missing its physical run identity.") };
            }
            let snapshotId: string;
            try {
                database.exec("BEGIN IMMEDIATE");
                try {
                    const snapshot = insertAgentRunSnapshotInDatabase(database, record);
                    snapshotId = snapshot.snapshotId;
                    database.exec("COMMIT");
                } catch (error) {
                    try {
                        database.exec("ROLLBACK");
                    } catch {
                        // Preserve the original write failure.
                    }
                    return { ok: false, error };
                }
                // The parent marker is the branch commit point. A failed append
                // leaves an unreachable immutable snapshot, never a bad marker.
                appendMarker({
                    version: 2,
                    snapshotId,
                    runInstanceId: record.runInstanceId,
                    runId: record.runId,
                });
                try {
                    upsertAgentRunCatalogRecordInDatabase(database, {
                        ...catalogRecord(record, parentCwd),
                        latestSnapshotId: snapshotId,
                    });
                } catch {
                    // Catalog is a lossy projection. The marker/snapshot remains
                    // authoritative even when this best-effort update fails.
                }
                return { ok: true };
            } catch (error) {
                return { ok: false, error };
            }
        },
        async flush() {},
        close() {
            if (closed) return;
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
    const toolCounts = boundedToolCounts(progressValue?.toolCounts);
    const childSessionFile = boundedString(record.childSessionFile, 4_096);
    const resolvedChildFile = childSessionFile
        ? safeExistingChildFile(childSessionDir, childSessionFile)
        : undefined;
    const questionValue = record.question && typeof record.question === "object" ? record.question : undefined;
    const mutationValue = record.mutationReport && typeof record.mutationReport === "object" ? record.mutationReport : undefined;

    return {
        version: 1,
        ownerSessionId,
        runId: record.runId,
        ...(typeof record.runInstanceId === "string" ? { runInstanceId: record.runInstanceId } : {}),
        title: boundedString(record.title, 80),
        agent: record.agent.slice(0, 64),
        agentSource: record.agentSource.slice(0, 32),
        agentFilePath: boundedString(record.agentFilePath, 4_096),
        definitionFingerprint: record.definitionFingerprint,
        task: boundedString(record.task, 16_000) ?? "Restored delegated task",
        status: record.status as PersistedAgentRun["status"],
        background: record.background,
        mutating: record.mutating,
        workspaceId: boundedString(record.workspaceId, 200),
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
    const cwdSessionDir = getAgentCwdSessionDir(ctx.cwd, agentSessionsDir);
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
    ): boolean => {
        if (!snapshot) {
            diagnostics.push(`Could not restore ${entry.marker.runId}: parent marker references a missing SQLite snapshot.`);
            return false;
        }
        if (
            snapshot.ownerSessionId !== ownerSessionId
            || snapshot.payloadVersion !== 2
            || snapshot.runInstanceId !== entry.marker.runInstanceId
            || snapshot.runId !== entry.marker.runId
        ) {
            diagnostics.push(`Could not restore ${entry.marker.runId}: parent marker and SQLite snapshot identity do not match.`);
            return false;
        }
        return true;
    };
    const sessionHeads = new Map<string, string>();
    for (const entry of allMarkers) {
        const snapshot = snapshotsById.get(entry.marker.snapshotId);
        if (!validSnapshot(entry, snapshot)) continue;
        sessionHeads.set(entry.marker.runInstanceId, entry.marker.snapshotId);
    }
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
        const parsed = parseRecord(snapshot.payload, ownerSessionId, childSessionDir);
        if (!parsed) {
            diagnostics.push(`Could not restore ${snapshot.runId}: its SQLite snapshot is invalid.`);
            continue;
        }
        parsed.runInstanceId = runInstanceId;
        if (sessionHeads.get(runInstanceId) !== branchHead.snapshotId) {
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
            sessionManager.appendCustomEntry?.(AGENT_RUN_SNAPSHOT_MARKER, marker);
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
