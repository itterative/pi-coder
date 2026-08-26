import fs from "node:fs/promises";
import path from "node:path";
import {
    SessionManager,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import { PI_CODER_AGENT_SESSIONS_DIR } from "../../../common/constants";
import {
    getAgentCwdSessionDir,
    validateAgentRunSnapshot,
} from "../runs/persistence";
import { deriveAgentTitle } from "../runs/manager";
import type { AgentRunSummary, PersistedAgentRun } from "../contracts/runs";
import type { AgentRunCatalogRecord } from "../contracts/workspaces";
import { listAgentRunCatalog } from "../storage/run-catalog";
import { collectAgentRunSnapshotMarkers } from "../storage/run-markers";
import { listAgentRunSnapshotsInDatabase } from "../storage/run-snapshots";
import { openAgentMetadataDatabase } from "../storage/metadata";
import type { AgentSessionBrowserItem } from "./browser-models";
import { loadAgentSessionTranscriptViews } from "./transcript";

function currentItem(run: AgentRunSummary): AgentSessionBrowserItem {
    return {
        kind: "current",
        id: run.runId,
        title: run.title,
        agent: run.agent,
        status: run.status,
        task: run.task,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        sessionFile: run.sessionFile,
        childSessionLeafId: run.childSessionLeafId ?? run.sessionLeafId,
        readOnlyReason: run.readOnlyReason,
        activity: run.activity,
        responsePreview: run.responsePreview,
        mutating: run.mutating,
        usage: run.usage,
        changedFiles: run.mutationReport?.changedFiles,
        readFiles: run.mutationReport?.readFiles,
    };
}

function historicalStatus(status: string | undefined): string | undefined {
    // A past transcript has no live child handle in this runtime. Persisted
    // startup/running states therefore describe an interrupted run, not one
    // that is still executing.
    return status === "starting" || status === "running" || status === "waiting_for_permission"
        ? "interrupted"
        : status;
}

interface ActiveBranchChildCheckpoint {
    childSessionLeafId: string | null;
    record: PersistedAgentRun;
    readOnlyReason?: string;
}

function pastItem(
    info: SessionInfo,
    parentSessionId: string,
    metadata: AgentRunCatalogRecord | undefined,
    checkpoint?: ActiveBranchChildCheckpoint,
): AgentSessionBrowserItem {
    const catalogLeaf = metadata && (
        metadata.latestSnapshotId !== undefined
        || typeof metadata.childSessionLeafId === "string"
    )
        ? metadata.childSessionLeafId
        : undefined;
    const childSessionLeafId = checkpoint
        ? checkpoint.childSessionLeafId
        : catalogLeaf;
    const exactLeafSelected = childSessionLeafId !== undefined;
    const transcript = exactLeafSelected
        ? loadAgentSessionTranscriptViews(info.path, childSessionLeafId)
        : undefined;
    const record = checkpoint?.record;
    const displayMetadata = record ?? metadata;
    const unavailableTranscript = exactLeafSelected
        ? "Transcript unavailable for the selected child checkpoint."
        : "Transcript unavailable: no exact child transcript leaf is recorded.";
    const selectedTranscript = transcript?.detailed ?? unavailableTranscript;
    const selectedCollapsedTranscript = transcript?.collapsed ?? unavailableTranscript;
    const responsePreview = displayMetadata && "responsePreview" in displayMetadata
        ? displayMetadata.responsePreview
        : record?.progress.output || record?.progress.lastAssistantMessage;
    return {
        kind: "past",
        id: info.id,
        title: displayMetadata?.title ?? deriveAgentTitle(info.firstMessage),
        agent: displayMetadata?.agent ?? "delegated agent",
        status: historicalStatus(displayMetadata?.status) ?? "historical",
        task: displayMetadata?.task ?? info.firstMessage,
        startedAt: displayMetadata?.startedAt,
        updatedAt: displayMetadata?.updatedAt ?? info.modified.getTime(),
        sessionFile: info.path,
        ...(childSessionLeafId !== undefined ? { childSessionLeafId } : {}),
        parentSessionId,
        readOnlyReason: checkpoint?.readOnlyReason,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        transcript: selectedTranscript,
        transcriptCollapsed: selectedCollapsedTranscript,
        mutating: displayMetadata?.mutating,
        usage: displayMetadata && "usageSnapshot" in displayMetadata ? displayMetadata.usageSnapshot : undefined,
        responsePreview,
        changedFiles: displayMetadata && "mutationReport" in displayMetadata ? displayMetadata.mutationReport?.changedFiles : undefined,
        readFiles: displayMetadata && "mutationReport" in displayMetadata ? displayMetadata.mutationReport?.readFiles : undefined,
    };
}

export function currentAgentSessionItems(runs: AgentRunSummary[]): AgentSessionBrowserItem[] {
    return runs.map(currentItem);
}

/** Load complete human-readable transcripts for current runs whose files exist. */
export async function loadAgentSessionTranscripts(
    items: AgentSessionBrowserItem[],
): Promise<AgentSessionBrowserItem[]> {
    const directoryInfos = new Map<string, Promise<SessionInfo[]>>();
    const infosFor = (directory: string): Promise<SessionInfo[]> => {
        let promise = directoryInfos.get(directory);
        if (!promise) {
            promise = SessionManager.listAll(directory).catch(() => []);
            directoryInfos.set(directory, promise);
        }
        return promise;
    };

    return Promise.all(items.map(async (item) => {
        if (!item.sessionFile || item.transcript !== undefined) {
            return item;
        }
        const directory = path.dirname(item.sessionFile);
        const info = (await infosFor(directory)).find(
            (candidate) => path.resolve(candidate.path) === path.resolve(item.sessionFile!),
        );
        if (!info) {
            return item;
        }

        if (item.childSessionLeafId === undefined) {
            return {
                ...item,
                transcript: "Transcript unavailable: no exact child transcript leaf is recorded.",
                transcriptCollapsed: "Transcript unavailable: no exact child transcript leaf is recorded.",
            };
        }
        const transcript = loadAgentSessionTranscriptViews(info.path, item.childSessionLeafId);
        return transcript
            ? {
                ...item,
                transcript: transcript.detailed,
                transcriptCollapsed: transcript.collapsed,
            }
            : {
                ...item,
                transcript: "Transcript unavailable for the selected child checkpoint.",
                transcriptCollapsed: "Transcript unavailable for the selected child checkpoint.",
            };
    }));
}

export interface AgentSessionHistoryScope {
    parentSessionId?: string;
    parentSessionFile?: string;
    parentSessionLeafId?: string | null;
    activeBranchOnly?: boolean;
}

async function activeBranchChildCheckpoints(
    parentSessionFile: string | undefined,
    parentSessionLeafId: string | null | undefined,
    ownerSessionId: string | undefined,
    childSessionDir: string,
    workspacesDir: string,
): Promise<Map<string, ActiveBranchChildCheckpoint> | undefined> {
    if (!parentSessionFile) return undefined;
    try {
        const parent = SessionManager.open(parentSessionFile);
        const allMarkers = collectAgentRunSnapshotMarkers(parent.getEntries());
        const activeEntries = parentSessionLeafId === null
            ? []
            : parent.getBranch(parentSessionLeafId);
        const activeMarkers = collectAgentRunSnapshotMarkers(activeEntries);
        const database = await openAgentMetadataDatabase(workspacesDir);
        try {
            const snapshots = listAgentRunSnapshotsInDatabase(
                database,
                allMarkers.map((entry) => entry.marker.snapshotId),
            );
            const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
            const sessionHeads = new Map<string, string>();
            const recordsBySnapshotId = new Map<string, PersistedAgentRun>();
            for (const entry of allMarkers) {
                const snapshot = snapshotsById.get(entry.marker.snapshotId);
                const record = snapshot && ownerSessionId
                    ? validateAgentRunSnapshot(snapshot, entry.marker, ownerSessionId, childSessionDir)
                    : undefined;
                if (record) {
                    sessionHeads.set(entry.marker.runInstanceId, entry.marker.snapshotId);
                    recordsBySnapshotId.set(entry.marker.snapshotId, record);
                }
            }
            const checkpoints = new Map<string, ActiveBranchChildCheckpoint & { order: number }>();
            for (const entry of activeMarkers) {
                const snapshot = snapshotsById.get(entry.marker.snapshotId);
                const record = recordsBySnapshotId.get(entry.marker.snapshotId);
                if (!snapshot?.childSessionFile || !record) continue;
                const file = path.resolve(snapshot.childSessionFile);
                const previous = checkpoints.get(file);
                if (previous && previous.order > entry.order) continue;
                checkpoints.set(file, {
                    childSessionLeafId: record.childSessionLeafId ?? null,
                    record,
                    ...(sessionHeads.get(entry.marker.runInstanceId) !== entry.marker.snapshotId
                        ? { readOnlyReason: "continued on another branch" }
                        : {}),
                    order: entry.order,
                });
            }
            return new Map(
                [...checkpoints].map(([file, checkpoint]) => [file, {
                    childSessionLeafId: checkpoint.childSessionLeafId,
                    record: checkpoint.record,
                    readOnlyReason: checkpoint.readOnlyReason,
                }]),
            );
        } finally {
            database.close();
        }
    } catch {
        return new Map();
    }
}

export async function listPastAgentSessions(
    cwd: string,
    agentSessionsDir?: string,
    scope?: AgentSessionHistoryScope,
): Promise<AgentSessionBrowserItem[]> {
    const cwdSessionDir = getAgentCwdSessionDir(cwd, agentSessionsDir);
    const workspacesDir = path.join(
        path.dirname(path.resolve(agentSessionsDir ?? PI_CODER_AGENT_SESSIONS_DIR)),
        "workspaces",
    );
    const parentSessionId = scope?.parentSessionId;
    const childSessionDir = parentSessionId
        ? path.join(cwdSessionDir, parentSessionId)
        : cwdSessionDir;
    const scopedCheckpoints = scope?.activeBranchOnly
        ? await activeBranchChildCheckpoints(
            scope.parentSessionFile,
            scope.parentSessionLeafId,
            parentSessionId,
            childSessionDir,
            workspacesDir,
        )
        : undefined;
    const scopedFiles = scopedCheckpoints
        ? new Set(scopedCheckpoints.keys())
        : undefined;
    let entries;
    try {
        entries = await fs.readdir(cwdSessionDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const parentDirectories = entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !scope?.parentSessionId || entry.name === scope.parentSessionId)
        .map((entry) => entry.name)
        .sort();
    const sessions: AgentSessionBrowserItem[] = [];
    for (const parentSessionId of parentDirectories) {
        const directory = path.join(cwdSessionDir, parentSessionId);
        let infos: SessionInfo[];
        try {
            infos = await SessionManager.listAll(directory);
        } catch {
            continue;
        }
        const catalog = await listAgentRunCatalog(cwd, workspacesDir);
        const scopedInfos = scopedFiles
            ? infos.filter((info) => scopedFiles.has(path.resolve(info.path)))
            : infos;
        sessions.push(...scopedInfos.map((info) => {
            const metadata = catalog.find((record) => (
                record.ownerSessionId === parentSessionId
                && record.childSessionFile !== undefined
                && path.resolve(record.childSessionFile) === path.resolve(info.path)
            ));
            const checkpoint = scopedCheckpoints?.get(path.resolve(info.path));
            return pastItem(info, parentSessionId, metadata, checkpoint);
        }));
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
}

export function removeCurrentAgentTranscripts(
    past: AgentSessionBrowserItem[],
    current: AgentSessionBrowserItem[],
): AgentSessionBrowserItem[] {
    const currentFiles = new Set(
        current
            .map((item) => item.sessionFile && path.resolve(item.sessionFile))
            .filter((file): file is string => file !== undefined),
    );
    return past.filter((item) => !item.sessionFile || !currentFiles.has(path.resolve(item.sessionFile)));
}
