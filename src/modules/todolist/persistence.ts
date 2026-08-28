import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { parseTodoList } from "./parser";

export const TODO_SNAPSHOT_TYPE = "pi-coder:todo-snapshot";

export interface TodoSnapshot {
    version: 1;
    content: string;
}

type TodoSnapshotEntry = Extract<SessionEntry, { type: "custom" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTodoSnapshotEntry(entry: SessionEntry): entry is TodoSnapshotEntry {
    return entry.type === "custom" && entry.customType === TODO_SNAPSHOT_TYPE;
}

function parseSnapshot(data: unknown): TodoSnapshot | undefined {
    if (!isRecord(data) || data.version !== 1 || typeof data.content !== "string") return undefined;

    try {
        parseTodoList(data.content);
        return { version: 1, content: data.content };
    } catch {
        return undefined;
    }
}

/** Return the latest valid TODO snapshot in a session-entry branch. */
export function getTodoSnapshotFromEntries(
    entries: readonly SessionEntry[],
): TodoSnapshot | undefined {
    for (const entry of [...entries].reverse()) {
        if (!isTodoSnapshotEntry(entry)) continue;
        const snapshot = parseSnapshot(entry.data);
        if (snapshot) return snapshot;
    }
    return undefined;
}

/** Return the latest TODO snapshot reachable from the active session branch. */
export function getTodoSnapshot(ctx: ExtensionContext): TodoSnapshot | undefined {
    return getTodoSnapshotFromEntries(ctx.sessionManager?.getBranch?.() ?? []);
}

/** Persist the editable TODO document without recording its ephemeral path. */
export function appendTodoSnapshot(pi: ExtensionAPI, content: string): void {
    pi.appendEntry<TodoSnapshot>(TODO_SNAPSHOT_TYPE, {
        version: 1,
        content,
    });
}

