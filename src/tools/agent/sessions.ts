import fs from "node:fs/promises";
import path from "node:path";
import {
    SessionManager,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import { getAgentCwdSessionDir, readAgentSessionMetadata } from "./persistence";
import { deriveAgentTitle, type AgentRunSummary } from "./runtime";

export interface AgentSessionBrowserItem {
    kind: "current" | "past" | "empty";
    id: string;
    title: string;
    agent: string;
    status: string;
    task: string;
    startedAt?: number;
    updatedAt: number;
    sessionFile?: string;
    parentSessionId?: string;
    messageCount?: number;
    firstMessage?: string;
    allMessagesText?: string;
    transcript?: string;
    activity?: string;
    responsePreview?: string;
    mutating?: boolean;
    usage?: AgentRunSummary["usage"];
    changedFiles?: string[];
    readFiles?: string[];
}

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

function pastItem(info: SessionInfo, parentSessionId: string): AgentSessionBrowserItem {
    const candidate = readAgentSessionMetadata(info.path);
    const metadata = candidate?.ownerSessionId === parentSessionId ? candidate : undefined;
    return {
        kind: "past",
        id: info.id,
        title: metadata?.title ?? deriveAgentTitle(info.firstMessage),
        agent: metadata?.agent ?? "delegated agent",
        status: metadata?.status ?? "historical",
        task: metadata?.task ?? info.firstMessage,
        startedAt: metadata?.startedAt,
        updatedAt: metadata?.updatedAt ?? info.modified.getTime(),
        sessionFile: info.path,
        parentSessionId,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        allMessagesText: info.allMessagesText.slice(-4_000),
        transcript: info.allMessagesText,
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
        if (!item.sessionFile || item.transcript !== undefined) return item;
        const directory = path.dirname(item.sessionFile);
        const info = (await infosFor(directory)).find(
            (candidate) => path.resolve(candidate.path) === path.resolve(item.sessionFile!),
        );
        return info ? { ...item, transcript: info.allMessagesText } : item;
    }));
}

export async function listPastAgentSessions(
    cwd: string,
    agentSessionsDir?: string,
): Promise<AgentSessionBrowserItem[]> {
    const cwdSessionDir = getAgentCwdSessionDir(cwd, agentSessionsDir);
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
        sessions.push(...infos.map((info) => pastItem(info, parentSessionId)));
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
