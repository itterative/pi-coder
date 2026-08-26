import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const AGENT_RUN_SNAPSHOT_MARKER = "pi-coder:agent-run-snapshot-v2";

export interface AgentRunSnapshotMarker {
    version: 2;
    snapshotId: string;
    runInstanceId: string;
    runId: string;
}

export function parseAgentRunSnapshotMarker(entry: SessionEntry): AgentRunSnapshotMarker | undefined {
    if (entry.type !== "custom" || entry.customType !== AGENT_RUN_SNAPSHOT_MARKER) return undefined;
    const data = entry.data;
    if (!data || typeof data !== "object") return undefined;
    const marker = data as Partial<AgentRunSnapshotMarker>;
    if (
        marker.version !== 2
        || typeof marker.snapshotId !== "string"
        || marker.snapshotId.length === 0
        || typeof marker.runInstanceId !== "string"
        || marker.runInstanceId.length === 0
        || typeof marker.runId !== "string"
        || marker.runId.length === 0
    ) return undefined;
    return {
        version: 2,
        snapshotId: marker.snapshotId,
        runInstanceId: marker.runInstanceId,
        runId: marker.runId,
    };
}

export function collectAgentRunSnapshotMarkers(entries: SessionEntry[]): Array<{
    marker: AgentRunSnapshotMarker;
    entryId: string;
    order: number;
}> {
    return entries.flatMap((entry, order) => {
        const marker = parseAgentRunSnapshotMarker(entry);
        return marker ? [{ marker, entryId: entry.id, order }] : [];
    });
}
