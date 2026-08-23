import fs from "node:fs/promises";
import path from "node:path";
import {
    SessionManager,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import { getAgentCwdSessionDir } from "./persistence";
import type { AgentRunSummary } from "./runtime";

export interface AgentSessionBrowserItem {
    kind: "current" | "past" | "empty";
    id: string;
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
    activity?: string;
    responsePreview?: string;
    mutating?: boolean;
}

function currentItem(run: AgentRunSummary): AgentSessionBrowserItem {
    return {
        kind: "current",
        id: run.runId,
        agent: run.agent,
        status: run.status,
        task: run.task,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        sessionFile: run.sessionFile,
        activity: run.activity,
        responsePreview: run.responsePreview,
        mutating: run.mutating,
    };
}

function pastItem(info: SessionInfo, parentSessionId: string): AgentSessionBrowserItem {
    return {
        kind: "past",
        id: info.id,
        agent: "delegated agent",
        status: "persisted transcript",
        task: info.firstMessage,
        updatedAt: info.modified.getTime(),
        sessionFile: info.path,
        parentSessionId,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        allMessagesText: info.allMessagesText.slice(-4_000),
    };
}

export function currentAgentSessionItems(runs: AgentRunSummary[]): AgentSessionBrowserItem[] {
    return runs.map(currentItem);
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
