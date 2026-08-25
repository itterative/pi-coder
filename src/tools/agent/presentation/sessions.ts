import fs from "node:fs/promises";
import path from "node:path";
import {
    SessionManager,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import { PI_CODER_AGENT_SESSIONS_DIR } from "../../../common/constants";
import { getAgentCwdSessionDir } from "../runs/persistence";
import { deriveAgentTitle } from "../runs/manager";
import type { AgentRunSummary } from "../contracts/runs";
import type { AgentRunCatalogRecord } from "../contracts/workspaces";
import { listAgentRunCatalog } from "../storage/run-catalog";
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

function pastItem(
    info: SessionInfo,
    parentSessionId: string,
    metadata: AgentRunCatalogRecord | undefined,
): AgentSessionBrowserItem {
    const transcript = loadAgentSessionTranscriptViews(info.path);
    return {
        kind: "past",
        id: info.id,
        title: metadata?.title ?? deriveAgentTitle(info.firstMessage),
        agent: metadata?.agent ?? "delegated agent",
        status: historicalStatus(metadata?.status) ?? "historical",
        task: metadata?.task ?? info.firstMessage,
        startedAt: metadata?.startedAt,
        updatedAt: metadata?.updatedAt ?? info.modified.getTime(),
        sessionFile: info.path,
        parentSessionId,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        allMessagesText: info.allMessagesText.slice(-4_000),
        transcript: transcript?.detailed ?? info.allMessagesText,
        transcriptCollapsed: transcript?.collapsed,
        mutating: metadata?.mutating,
        usage: metadata?.usageSnapshot,
        responsePreview: metadata?.responsePreview,
        changedFiles: metadata?.mutationReport?.changedFiles,
        readFiles: metadata?.mutationReport?.readFiles,
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

        const transcript = loadAgentSessionTranscriptViews(info.path);
        return transcript
            ? { ...item, transcript: transcript.detailed, transcriptCollapsed: transcript.collapsed }
            : { ...item, transcript: info.allMessagesText };
    }));
}

export async function listPastAgentSessions(
    cwd: string,
    agentSessionsDir?: string,
): Promise<AgentSessionBrowserItem[]> {
    const cwdSessionDir = getAgentCwdSessionDir(cwd, agentSessionsDir);
    const workspacesDir = path.join(
        path.dirname(path.resolve(agentSessionsDir ?? PI_CODER_AGENT_SESSIONS_DIR)),
        "workspaces",
    );
    let entries;
    try {
        entries = await fs.readdir(cwdSessionDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const parentDirectories = entries
        .filter((entry) => entry.isDirectory())
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
        sessions.push(...infos.map((info) => {
            const metadata = catalog.find((record) => (
                record.ownerSessionId === parentSessionId
                && record.childSessionFile !== undefined
                && path.resolve(record.childSessionFile) === path.resolve(info.path)
            ));
            return pastItem(info, parentSessionId, metadata);
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
