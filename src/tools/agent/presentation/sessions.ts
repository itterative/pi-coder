import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
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
import { formatAgentSessionTranscripts } from "./transcript";
import { openPersistedChildSession } from "../child/transcript";

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

const NO_LEAF_TRANSCRIPT = "Transcript unavailable: no exact child transcript leaf is recorded.";
const UNAVAILABLE_TRANSCRIPT = "Transcript unavailable for the selected child checkpoint.";

function transcriptLeafCandidates(item: AgentSessionBrowserItem): Array<string | null> {
    const leaves: Array<string | null> = [];
    if (item.childSessionLeafId !== undefined) leaves.push(item.childSessionLeafId);
    if (
        item.fallbackChildSessionLeafId !== undefined
        && item.fallbackChildSessionLeafId !== item.childSessionLeafId
    ) {
        leaves.push(item.fallbackChildSessionLeafId);
    }
    return leaves;
}

function loadTranscriptAtLeaf(item: AgentSessionBrowserItem, leaf: string | null) {
    const session = openPersistedChildSession(item.sessionFile!, leaf);
    const branch = session.getBranch();
    return {
        views: formatAgentSessionTranscripts(branch),
        messageCount: branch.filter((entry) => entry.type === "message").length,
    };
}

interface PastItemFields {
    agent: string;
    status: string;
    task: string;
    startedAt: number;
    updatedAt: number;
    mutating: boolean;
    usage: Usage;
    responsePreview?: string;
    changedFiles?: string[];
    readFiles?: string[];
}

function displayMetadataFields(
    displayMetadata: AgentRunCatalogRecord | PersistedAgentRun,
    checkpointRecord: PersistedAgentRun | undefined,
): PastItemFields {
    const mutationReport = displayMetadata.mutationReport;
    return {
        agent: displayMetadata.agent,
        status: displayMetadata.status,
        task: displayMetadata.task,
        startedAt: displayMetadata.startedAt,
        updatedAt: displayMetadata.updatedAt,
        mutating: displayMetadata.mutating,
        usage: displayMetadata.usageSnapshot,
        responsePreview: "responsePreview" in displayMetadata
            ? displayMetadata.responsePreview
            : checkpointRecord?.progress.output || checkpointRecord?.progress.lastAssistantMessage,
        changedFiles: mutationReport?.changedFiles,
        readFiles: mutationReport?.readFiles,
    };
}

interface PastItemSource {
    id: string;
    file: string;
    parentSessionId: string;
    title: string;
    agent: string;
    status?: string;
    task: string;
    startedAt?: number;
    updatedAt: number;
    childSessionLeafId?: string | null;
    fallbackChildSessionLeafId?: string | null;
    readOnlyReason?: string;
    firstMessage?: string;
    messageCount?: number;
    mutating?: boolean;
    usage?: Usage;
    responsePreview?: string;
    changedFiles?: string[];
    readFiles?: string[];
}

/**
 * Past items are displayed without transcript text: the full transcript is
 * loaded when the detail view is opened (loadAgentSessionTranscriptForItem).
 * Only the no-leaf case is known statically.
 */
function buildPastItem(source: PastItemSource): AgentSessionBrowserItem {
    return {
        kind: "past",
        id: source.id,
        title: source.title,
        agent: source.agent,
        status: historicalStatus(source.status) ?? "historical",
        task: source.task,
        startedAt: source.startedAt,
        updatedAt: source.updatedAt,
        sessionFile: source.file,
        ...(source.childSessionLeafId !== undefined ? { childSessionLeafId: source.childSessionLeafId } : {}),
        ...(source.fallbackChildSessionLeafId !== undefined
            ? { fallbackChildSessionLeafId: source.fallbackChildSessionLeafId }
            : {}),
        parentSessionId: source.parentSessionId,
        readOnlyReason: source.readOnlyReason,
        firstMessage: source.firstMessage,
        messageCount: source.messageCount,
        ...(source.childSessionLeafId === undefined
            ? { transcript: NO_LEAF_TRANSCRIPT, transcriptCollapsed: NO_LEAF_TRANSCRIPT }
            : {}),
        mutating: source.mutating,
        usage: source.usage,
        responsePreview: source.responsePreview,
        changedFiles: source.changedFiles,
        readFiles: source.readFiles,
    };
}

function pastItem(
    info: SessionInfo,
    parentSessionId: string,
    metadata: AgentRunCatalogRecord | undefined,
    checkpoint?: ActiveBranchChildCheckpoint,
): AgentSessionBrowserItem {
    const record = checkpoint?.record;
    const displayMetadata = record ?? metadata;
    const fields = displayMetadata ? displayMetadataFields(displayMetadata, record) : undefined;
    const catalogLeaf = metadata && (
        metadata.latestSnapshotId !== undefined
        || typeof metadata.childSessionLeafId === "string"
    )
        ? metadata.childSessionLeafId
        : undefined;
    return buildPastItem({
        id: info.id,
        file: info.path,
        parentSessionId,
        title: displayMetadata?.title ?? deriveAgentTitle(info.firstMessage),
        agent: fields?.agent ?? "delegated agent",
        status: fields?.status,
        task: fields?.task ?? info.firstMessage,
        startedAt: fields?.startedAt,
        updatedAt: fields?.updatedAt ?? info.modified.getTime(),
        childSessionLeafId: checkpoint ? checkpoint.childSessionLeafId : catalogLeaf,
        fallbackChildSessionLeafId: checkpoint ? catalogLeaf : undefined,
        readOnlyReason: checkpoint?.readOnlyReason,
        firstMessage: info.firstMessage,
        messageCount: info.messageCount,
        mutating: fields?.mutating,
        usage: fields?.usage,
        responsePreview: fields?.responsePreview,
        changedFiles: fields?.changedFiles,
        readFiles: fields?.readFiles,
    });
}

function pastItemFromCatalog(
    record: AgentRunCatalogRecord,
    checkpoint?: ActiveBranchChildCheckpoint,
): AgentSessionBrowserItem {
    const displayRecord = checkpoint?.record ?? record;
    const fields = displayMetadataFields(displayRecord, checkpoint?.record);
    const catalogLeaf = record.latestSnapshotId !== undefined || typeof record.childSessionLeafId === "string"
        ? record.childSessionLeafId
        : undefined;
    return buildPastItem({
        id: record.runId,
        file: path.resolve(record.childSessionFile!),
        parentSessionId: record.ownerSessionId,
        title: displayRecord.title ?? record.title,
        agent: fields.agent,
        status: fields.status,
        task: fields.task,
        startedAt: fields.startedAt,
        updatedAt: fields.updatedAt,
        childSessionLeafId: checkpoint ? checkpoint.childSessionLeafId : catalogLeaf,
        fallbackChildSessionLeafId: checkpoint ? catalogLeaf : undefined,
        readOnlyReason: checkpoint?.readOnlyReason,
        mutating: fields.mutating,
        usage: fields.usage,
        responsePreview: fields.responsePreview,
        changedFiles: fields.changedFiles,
        readFiles: fields.readFiles,
    });
}

export function currentAgentSessionItems(runs: AgentRunSummary[]): AgentSessionBrowserItem[] {
    return runs.map(currentItem);
}

/** Load complete human-readable transcripts for current runs whose files exist. */
export async function loadAgentSessionTranscripts(
    items: AgentSessionBrowserItem[],
): Promise<AgentSessionBrowserItem[]> {
    return Promise.all(items.map(async (item) => {
        if (!item.sessionFile || item.transcript !== undefined) {
            return item;
        }
        let sessionExists = true;
        try {
            await fs.access(item.sessionFile);
        } catch {
            sessionExists = false;
        }
        if (!sessionExists) {
            return item;
        }

        const leaves = transcriptLeafCandidates(item);
        if (leaves.length === 0) {
            return {
                ...item,
                transcript: NO_LEAF_TRANSCRIPT,
                transcriptCollapsed: NO_LEAF_TRANSCRIPT,
            };
        }
        // A plain existence check plus the transcript parse below is enough; the
        // directory scan SessionManager.listAll would perform re-reads every
        // sibling transcript in the same directory for no additional data.
        for (const leaf of leaves) {
            try {
                const transcript = loadTranscriptAtLeaf(item, leaf).views;
                return {
                    ...item,
                    transcript: transcript.detailed,
                    transcriptCollapsed: transcript.collapsed,
                    transcriptParts: transcript.detailedParts,
                    transcriptCollapsedParts: transcript.collapsedParts,
                };
            } catch {
                // A historical checkpoint may no longer contain its exact leaf;
                // try the latest catalog leaf for visual browsing.
            }
        }
        return {
            ...item,
            transcript: UNAVAILABLE_TRANSCRIPT,
            transcriptCollapsed: UNAVAILABLE_TRANSCRIPT,
        };
    }));
}

/**
 * Loads the transcript views for one session on demand, used when its detail
 * view is opened. Past rows are enumerated from the run catalog and carry no
 * transcript text until this runs; the message count is computed here as well
 * so enumeration stays a single indexed catalog query.
 */
export async function loadAgentSessionTranscriptForItem(
    item: AgentSessionBrowserItem,
): Promise<AgentSessionBrowserItem | undefined> {
    if (item.transcript !== undefined || !item.sessionFile) {
        return item;
    }
    const leaves = transcriptLeafCandidates(item);
    if (leaves.length === 0) {
        return {
            ...item,
            transcript: NO_LEAF_TRANSCRIPT,
            transcriptCollapsed: NO_LEAF_TRANSCRIPT,
        };
    }
    for (const leaf of leaves) {
        try {
            const { views, messageCount } = loadTranscriptAtLeaf(item, leaf);
            return {
                ...item,
                transcript: views.detailed,
                transcriptCollapsed: views.collapsed,
                transcriptParts: views.detailedParts,
                transcriptCollapsedParts: views.collapsedParts,
                messageCount,
            };
        } catch {
            // A historical checkpoint may no longer contain its exact leaf;
            // try the latest catalog leaf for visual browsing.
        }
    }
    return {
        ...item,
        transcript: UNAVAILABLE_TRANSCRIPT,
        transcriptCollapsed: UNAVAILABLE_TRANSCRIPT,
    };
}

export interface AgentSessionHistoryScope {
    parentSessionId?: string;
    parentSessionFile?: string;
    parentSessionLeafId?: string | null;
    activeBranchOnly?: boolean;
}

export interface AgentPastSessionListsOptions {
    agentSessionsDir?: string;
    activeBranch?: AgentPastSessionActiveBranch;
}

export interface AgentPastSessionOptions extends AgentSessionHistoryScope {
    agentSessionsDir?: string;
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

export interface AgentPastSessionLists {
    /** Every enumerated past session, newest first. */
    all: AgentSessionBrowserItem[];
    /** Checkpoint-resolved items for the active parent branch, newest first. */
    activeBranch: AgentSessionBrowserItem[];
}

export interface AgentPastSessionActiveBranch {
    parentSessionId: string;
    parentSessionFile?: string;
    parentSessionLeafId?: string | null;
}

/**
 * Enumerates persisted child sessions from the run catalog: one indexed
 * catalog query plus one active-branch checkpoint resolution. Transcripts
 * that predate the catalog are only discovered by a directory scan when a
 * parent-session directory actually contains files the catalog does not know
 * about. Callers derive session-scoped and active-branch views from the
 * returned lists instead of re-listing.
 */
export async function listAgentPastSessionLists(
    cwd: string,
    {
        agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR,
        activeBranch,
    }: AgentPastSessionListsOptions = {},
): Promise<AgentPastSessionLists> {
    const cwdSessionDir = getAgentCwdSessionDir(cwd, { agentSessionsDir });
    const workspacesDir = path.join(
        path.dirname(path.resolve(agentSessionsDir ?? PI_CODER_AGENT_SESSIONS_DIR)),
        "workspaces",
    );
    const checkpoints = activeBranch
        ? await activeBranchChildCheckpoints(
            activeBranch.parentSessionFile,
            activeBranch.parentSessionLeafId,
            activeBranch.parentSessionId,
            path.join(cwdSessionDir, activeBranch.parentSessionId),
            workspacesDir,
        )
        : undefined;
    const catalog = await listAgentRunCatalog(cwd, workspacesDir);

    const all: AgentSessionBrowserItem[] = [];
    const activeBranchFiles = new Set<string>();
    const catalogFiles = new Set<string>();
    // The catalog is sorted newest first, so the first record per file is kept.
    for (const record of catalog) {
        if (!record.childSessionFile) {
            continue;
        }
        const file = path.resolve(record.childSessionFile);
        if (catalogFiles.has(file)) {
            continue;
        }
        catalogFiles.add(file);
        const checkpoint = record.ownerSessionId === activeBranch?.parentSessionId
            ? checkpoints?.get(file)
            : undefined;
        all.push(pastItemFromCatalog(record, checkpoint));
        if (checkpoint) {
            activeBranchFiles.add(file);
        }
    }

    const orphans = await listOrphanPastSessions(
        cwdSessionDir,
        catalogFiles,
        activeBranch,
        checkpoints,
    );
    for (const file of orphans.checkpointedFiles) {
        activeBranchFiles.add(file);
    }
    all.push(...orphans.items);

    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
        all,
        activeBranch: all.filter((item) =>
            item.sessionFile !== undefined && activeBranchFiles.has(path.resolve(item.sessionFile)),
        ),
    };
}

/**
 * Legacy fallback for transcripts written before the run catalog existed:
 * scans parent-session directories, but only the ones that contain JSONL
 * files the catalog does not reference, so the common case costs directory
 * listings only.
 */
async function listOrphanPastSessions(
    cwdSessionDir: string,
    catalogFiles: ReadonlySet<string>,
    activeBranch: AgentPastSessionActiveBranch | undefined,
    checkpoints: Map<string, ActiveBranchChildCheckpoint> | undefined,
): Promise<{ items: AgentSessionBrowserItem[]; checkpointedFiles: string[] }> {
    const items: AgentSessionBrowserItem[] = [];
    const checkpointedFiles: string[] = [];
    let entries: Dirent[];
    try {
        entries = await fs.readdir(cwdSessionDir, { withFileTypes: true });
    } catch {
        return { items, checkpointedFiles };
    }
    for (const entry of entries
        .filter((value) => value.isDirectory())
        .map((value) => value.name)
        .sort()) {
        const directory = path.join(cwdSessionDir, entry);
        let names: string[];
        try {
            names = (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl"));
        } catch {
            continue;
        }
        const hasUntracked = names.some(
            (name) => !catalogFiles.has(path.resolve(path.join(directory, name))),
        );
        if (!hasUntracked) {
            continue;
        }
        let infos: SessionInfo[];
        try {
            infos = await SessionManager.listAll(directory);
        } catch {
            continue;
        }
        for (const info of infos) {
            const file = path.resolve(info.path);
            if (catalogFiles.has(file)) {
                continue;
            }
            const checkpoint = entry === activeBranch?.parentSessionId
                ? checkpoints?.get(file)
                : undefined;
            items.push(pastItem(info, entry, undefined, checkpoint));
            if (checkpoint) {
                checkpointedFiles.push(file);
            }
        }
    }
    return { items, checkpointedFiles };
}

export async function listPastAgentSessions(
    cwd: string,
    options: AgentPastSessionOptions = {},
): Promise<AgentSessionBrowserItem[]> {
    const {
        agentSessionsDir,
        parentSessionId,
        parentSessionFile,
        parentSessionLeafId,
        activeBranchOnly,
    } = options;
    const activeBranch = activeBranchOnly && parentSessionId
        ? {
            parentSessionId,
            parentSessionFile,
            parentSessionLeafId,
        }
        : undefined;
    const lists = await listAgentPastSessionLists(cwd, { agentSessionsDir, activeBranch });
    if (activeBranchOnly) {
        return lists.activeBranch;
    }
    if (parentSessionId) {
        return lists.all.filter((item) => item.parentSessionId === parentSessionId);
    }
    return lists.all;
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
