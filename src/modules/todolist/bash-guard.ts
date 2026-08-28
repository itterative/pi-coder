import { createHash, randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    readFile,
    realpath,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
    isBashToolResult,
    isToolCallEventType,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolResultEvent,
    type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { getScratchpadPath } from "../scratchpad";
import { parseTodoList } from "./parser";

const MAX_SNAPSHOT_BYTES = 256_000;
const MAX_OUTSTANDING_SNAPSHOTS = 32;

const EMPTY_TODO_DOCUMENT = "---\nversion: 1\ntodos: []\n---\n";

const RESTORED_WARNING =
    "The TODO guard detected that Bash changed TODO.md to invalid frontmatter. The previous valid TODO.md was restored. The Bash command itself was not treated as failed; other Bash side effects may still have completed. Use write or edit to update TODO.md.";
const REMOVED_WARNING =
    "The TODO guard detected that Bash created TODO.md with invalid frontmatter. The invalid TODO.md was removed. The Bash command itself was not treated as failed; other Bash side effects may still have completed. Use write or edit to create TODO.md.";
const UNSAFE_ROLLBACK_WARNING =
    "The TODO guard detected that Bash changed TODO.md to invalid frontmatter, but the previous valid TODO.md could not be safely restored. The file was left unchanged. The Bash command itself was not treated as failed; other Bash side effects may still have completed. Use write or edit to update TODO.md.";

interface TodoFileState {
    exists: boolean;
    content?: string;
    hash?: string;
    mode?: number;
    valid: boolean;
}

interface TodoSnapshot {
    path: string;
    before: TodoFileState;
}

function hashContent(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

function isNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readTodoFileState(filePath: string): Promise<TodoFileState> {
    let file;
    try {
        file = await lstat(filePath);
    } catch (error) {
        if (isNotFound(error)) return { exists: false, valid: false };
        return { exists: true, valid: false };
    }

    const mode = file.mode & 0o7777;
    if (!file.isFile() || file.size > MAX_SNAPSHOT_BYTES) {
        return { exists: true, mode, valid: false };
    }

    try {
        const bytes = await readFile(filePath);
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
            return { exists: true, mode, valid: false };
        }
        const content = bytes.toString("utf8");
        let valid = false;
        try {
            parseTodoList(content, filePath);
            valid = true;
        } catch {
            // The post-command path is validated below; malformed snapshots
            // are retained only as evidence and are never used for rollback.
        }
        return {
            exists: true,
            content,
            hash: hashContent(bytes),
            mode,
            valid,
        };
    } catch {
        return { exists: true, mode, valid: false };
    }
}

function sameFileState(left: TodoFileState, right: TodoFileState): boolean {
    if (left.exists !== right.exists) return false;
    if (!left.exists) return true;
    return left.hash !== undefined && left.hash === right.hash;
}

function changedSince(before: TodoFileState, after: TodoFileState): boolean {
    return !sameFileState(before, after);
}

async function atomicallyRestore(snapshot: TodoSnapshot): Promise<void> {
    const content = snapshot.before.content;
    if (content === undefined || snapshot.before.mode === undefined) {
        throw new Error("the previous TODO.md snapshot was not restorable");
    }

    const temporaryPath = path.join(
        path.dirname(snapshot.path),
        `.TODO.md.pi-coder-restore-${process.pid}-${randomUUID()}`,
    );
    try {
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await chmod(temporaryPath, snapshot.before.mode);
        await rename(temporaryPath, snapshot.path);
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}

type RollbackResult = "restored" | "removed" | "cleared" | "concurrent";

async function restoreIfSafe(
    snapshot: TodoSnapshot,
    postState: TodoFileState,
    hasCompetingMutation: boolean,
): Promise<RollbackResult | undefined> {
    if (hasCompetingMutation || (snapshot.before.exists && !snapshot.before.valid)) return undefined;

    const currentState = await readTodoFileState(snapshot.path);
    if (!sameFileState(currentState, postState)) return undefined;

    if (!snapshot.before.exists) {
        if (!currentState.exists) return "removed";
        await unlink(snapshot.path);
        return "removed";
    }

    if (!currentState.exists) {
        try {
            await writeFile(snapshot.path, EMPTY_TODO_DOCUMENT, {
                encoding: "utf8",
                flag: "wx",
                mode: snapshot.before.mode,
            });
            return "cleared";
        } catch (error) {
            if (isNotFound(error)) throw error;
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return "concurrent";
            throw error;
        }
    }

    await atomicallyRestore(snapshot);
    return "restored";
}

type BashResultEvent = Extract<ToolResultEvent, { toolName: "bash" }>;
interface ToolResultUpdate {
    content: BashResultEvent["content"];
}

function prependWarning(event: BashResultEvent, warning: string): ToolResultUpdate {
    return {
        content: [
            {
                type: "text",
                text: [
                    "<todo-guard-warning>",
                    warning,
                    "The actual Bash output follows after this message.",
                    "</todo-guard-warning>",
                ].join("\n"),
            },
            ...event.content,
        ],
    };
}

/** Register the defensive before/after Bash TODO guard for one runtime. */
export function registerTodoBashGuard(pi: ExtensionAPI): void {
    const snapshots = new Map<string, TodoSnapshot>();
    const pendingTodoMutations = new Set<string>();

    const capture = async (toolCallId: string, ctx: ExtensionContext): Promise<void> => {
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        if (!scratchpadPath) return;

        const todoPath = path.join(scratchpadPath, "TODO.md");
        const before = await readTodoFileState(todoPath);
        if (snapshots.size >= MAX_OUTSTANDING_SNAPSHOTS && !snapshots.has(toolCallId)) {
            const oldest = snapshots.keys().next().value;
            if (oldest !== undefined) snapshots.delete(oldest);
        }
        snapshots.set(toolCallId, { path: todoPath, before });
    };

    pi.on("tool_execution_start", async (event, ctx) => {
        if (event.toolName !== "bash") return;
        await capture(event.toolCallId, ctx);
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        if (isToolCallEventType("bash", event)) {
            if (!snapshots.has(event.toolCallId)) await capture(event.toolCallId, ctx);
            return { block: false };
        }
        if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) {
            return { block: false };
        }

        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        if (!scratchpadPath) return { block: false };
        const expectedPath = path.resolve(scratchpadPath, "TODO.md");
        const inputPath = path.resolve(ctx.cwd, event.input.path.trim());
        if (inputPath === expectedPath) pendingTodoMutations.add(event.toolCallId);
        return { block: false };
    });

    pi.on("tool_result", async (event) => {
        if (isBashToolResult(event)) {
            const snapshot = snapshots.get(event.toolCallId);
            if (!snapshot) return;
            snapshots.delete(event.toolCallId);

            const after = await readTodoFileState(snapshot.path);
            if (!changedSince(snapshot.before, after)) return;
            if (after.valid) return;

            const hasCompetingMutation = snapshots.size > 0 || pendingTodoMutations.size > 0;
            try {
                const rollback = await restoreIfSafe(snapshot, after, hasCompetingMutation);
                if (rollback === "restored") return prependWarning(event, RESTORED_WARNING);
                if (rollback === "removed") return prependWarning(event, REMOVED_WARNING);
                if (rollback === "cleared" || rollback === "concurrent") return;
                return prependWarning(event, UNSAFE_ROLLBACK_WARNING);
            } catch {
                return prependWarning(event, UNSAFE_ROLLBACK_WARNING);
            }
        }

        if (event.toolName === "write" || event.toolName === "edit") {
            pendingTodoMutations.delete(event.toolCallId);
        }
    });

    pi.on("tool_execution_end", (event) => {
        snapshots.delete(event.toolCallId);
        pendingTodoMutations.delete(event.toolCallId);
    });

    pi.on("session_shutdown", () => {
        snapshots.clear();
        pendingTodoMutations.clear();
    });
}
