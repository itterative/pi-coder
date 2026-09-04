import { type PersistedAgentRun } from "../../contracts/runs";
import { AgentRunCatalogRecord } from "../../contracts/workspaces";

function responsePreview(record: PersistedAgentRun): string | undefined {
    const text = (record.progress.output || record.progress.lastAssistantMessage || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return undefined;
    return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}

export function catalogRecord(record: PersistedAgentRun, parentCwd: string): AgentRunCatalogRecord {
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
