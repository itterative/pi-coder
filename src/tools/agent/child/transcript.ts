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
            content: [{
                type: "text",
                text: "This tool execution was interrupted before its result was durably recorded. Its outcome is uncertain; inspect current state before deciding whether to retry.",
            }],
            isError: true,
            timestamp: Date.now(),
        };
        sessionManager.appendMessage(result);
    }
    return pending.size;
}
