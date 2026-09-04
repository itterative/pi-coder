import fs from "node:fs";
import path from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function materializePersistentSession(
    sessionManager: SessionManager,
    sessionDir: string,
    cwd: string,
): SessionManager {
    const sessionFile = sessionManager.getSessionFile();
    const header = sessionManager.getHeader();
    if (!sessionFile || !header || fs.existsSync(sessionFile)) return sessionManager;

    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
    });
    return SessionManager.open(path.resolve(sessionFile), sessionDir, cwd);
}

/** Select an exact persisted leaf before any context or model work occurs. */
export function openPersistedChildSession(
    sessionFile: string,
    leafId?: string | null,
): SessionManager {
    const sessionManager = SessionManager.open(sessionFile);
    if (leafId !== undefined) {
        selectChildSessionLeaf(sessionManager, leafId);
    }
    return sessionManager;
}

export function selectChildSessionLeaf(
    sessionManager: SessionManager,
    leafId: string | null | undefined,
): void {
    if (leafId === null) {
        sessionManager.resetLeaf();
        return;
    }
    if (leafId === undefined) {
        throw new Error("Persisted child transcript leaf is missing.");
    }
    if (!sessionManager.getEntry(leafId)) {
        throw new Error(`Persisted child transcript leaf ${leafId} is missing.`);
    }
    sessionManager.branch(leafId);
    if (sessionManager.getLeafId() !== leafId) {
        throw new Error(`Persisted child transcript leaf ${leafId} could not be selected.`);
    }
}

/** The transcript fields a child factory supplies, as a subset of its context. */
interface ChildSessionRequest {
    cwd: string;
    childSessionFile?: string;
    childSessionDir?: string;
    childSessionLeafId?: string | null;
}

/**
 * Open, materialize, or create the transcript a child runs on, already positioned on its leaf.
 *
 * The arms are ordered by how much durable state already exists. A known file is reopened because
 * the run continues that transcript. A directory without one is materialized so a first run's writes
 * land somewhere durable before its first message instead of only in memory. Only a child with
 * neither - a workspace setup child, for instance - gets an in-memory transcript.
 *
 * Leaf selection belongs here rather than at the call site because nothing may read the session
 * context before it: `SessionManager.open()` positions on the newest physical leaf, and for a
 * restored run that is the wrong place to continue from. An explicit `null` means resume at the root;
 * an absent id leaves the default alone, which is what a pre-V2 checkpoint that never stored a leaf
 * needs. Unlike `openPersistedChildSession`, this one also supplies the session directory and cwd,
 * because a child writes to its transcript while the session browser only reads one.
 */
export function bootstrapChildSession(request: ChildSessionRequest): SessionManager {
    const { cwd, childSessionFile, childSessionDir, childSessionLeafId } = request;

    if (childSessionFile) {
        const sessionManager = SessionManager.open(childSessionFile, childSessionDir, cwd);
        if (childSessionLeafId !== undefined) {
            selectChildSessionLeaf(sessionManager, childSessionLeafId);
        }
        return sessionManager;
    }
    if (childSessionDir) {
        return materializePersistentSession(
            SessionManager.create(cwd, childSessionDir),
            childSessionDir,
            cwd,
        );
    }
    return SessionManager.inMemory(cwd);
}

export function repairInterruptedToolCalls(sessionManager: SessionManager): number {
    const pending = new Map<string, string>();
    for (const message of sessionManager.buildSessionContext().messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall") pending.set(block.id, block.name);
            }
        } else if (message.role === "toolResult") {
            pending.delete(message.toolCallId);
        }
    }
    for (const [toolCallId, toolName] of pending) {
        const result: ToolResultMessage = {
            role: "toolResult",
            toolCallId,
            toolName,
            content: [
                {
                    type: "text",
                    text: "This tool execution was interrupted before its result was durably recorded. Its outcome is uncertain; inspect current state before deciding whether to retry.",
                },
            ],
            isError: true,
            timestamp: Date.now(),
        };
        sessionManager.appendMessage(result);
    }
    return pending.size;
}
