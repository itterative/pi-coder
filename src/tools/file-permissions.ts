import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    isReadToolResult,
    isToolCallEventType,
    isWriteToolResult,
    type ExtensionAPI,
    type ExtensionContext,
    type ReadToolInput,
    type ToolCallEventResult,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import sandboxConfig from "../common/config";
import {
    ALLOWED_FILE_ENTRY_TYPE,
    type AllowedFileEntry,
} from "../common/audit";
import {
    getPathConfinementPermission,
    isPathWithinDirectory,
    isSafeHeuristic,
} from "../modules/sandbox/heuristics";
import {
    selectWithMessage,
    type SelectMessageItem,
    type SelectWithMessageResult,
} from "../tui/select-with-message";

type FileOperation = "read" | "write";
type PromptChoice =
    | { kind: "remember"; folder: string }
    | { kind: "yes" }
    | { kind: "no" };

function operationLabel(operation: FileOperation): string {
    return operation === "read" ? "read from" : "write to";
}

function isAllowedFileEntry(data: unknown): data is AllowedFileEntry {
    if (!data || typeof data !== "object") {
        return false;
    }

    const entry = data as Partial<AllowedFileEntry>;
    return (
        (entry.operation === "read" || entry.operation === "write") &&
        typeof entry.folder === "string" &&
        entry.folder.length > 0 &&
        path.isAbsolute(entry.folder)
    );
}

function restoreSessionFolders(
    ctx: ExtensionContext,
    operation: FileOperation,
    sessionFolders: Set<string>,
): void {
    sessionFolders.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ALLOWED_FILE_ENTRY_TYPE) {
            continue;
        }

        if (isAllowedFileEntry(entry.data) && entry.data.operation === operation) {
            sessionFolders.add(entry.data.folder);
        }
    }
}

function getApprovedFolder(
    filePath: string,
    cwd: string,
    operation: FileOperation,
    sessionFolders: Set<string>,
): string | undefined {
    const confinement = sandboxConfig.current?.heuristics?.cwdConfinement;

    for (const folder of sessionFolders) {
        if (isPathWithinDirectory(filePath, folder, cwd, confinement)) {
            return folder;
        }
    }

    return undefined;
}

function sessionFolderFor(filePath: string, cwd: string): string {
    // File tools operate on files, so the containing directory is the narrowest
    // useful scope for the "always allow" choice.
    const expanded = filePath === "~" || filePath.startsWith("~/")
        ? os.homedir() + filePath.slice(1)
        : filePath;
    const resolved = path.resolve(cwd, expanded);

    try {
        if (fs.statSync(resolved).isDirectory()) {
            return resolved;
        }
    } catch {
        // A write target, or a missing read target, uses its parent folder.
    }

    return path.dirname(resolved);
}

async function promptForFileAccess(
    operation: FileOperation,
    filePath: string,
    folder: string,
    ctx: ExtensionContext,
): Promise<SelectWithMessageResult<PromptChoice> | undefined> {
    if (!ctx.hasUI) {
        return undefined;
    }

    const boldFolder = ctx.ui.theme.bold(folder);
    const items: SelectMessageItem<PromptChoice>[] = [
        {
            value: { kind: "yes" },
            label: "Yes",
            description: "allow once",
        },
        {
            value: { kind: "remember", folder },
            label: `Yes, and always allow ${boldFolder}`,
            description: "for this session",
        },
        {
            value: { kind: "no" },
            label: "No",
            placeholder: "e.g., do not access that folder",
        },
    ];

    const result = await selectWithMessage(
        {
            title: `pi-${operation}-sandbox: allow ${operationLabel(operation)} path?`,
            contentLines: [filePath],
            items,
        },
        ctx,
        ctx.signal,
    );

    return result;
}

/**
 * Guard one of pi's built-in file tools. Paths inside cwd are granted by the
 * same confinement policy used by the bash heuristic. Other paths require an
 * explicit one-shot or session-scoped approval.
 */
export default function registerFileToolHook(
    pi: ExtensionAPI,
    operation: FileOperation,
): void {
    // Each registration belongs to one parent runtime and one operation. Keep
    // remembered read/write approvals isolated from reloads and child runtimes.
    const sessionFolders = new Set<string>();

    pi.on("session_start", (_event, ctx) => {
        restoreSessionFolders(ctx, operation, sessionFolders);
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        if (operation === "read") {
            if (!isToolCallEventType<"read", ReadToolInput>("read", event)) {
                return { block: false };
            }
        } else if (!isToolCallEventType<"write", WriteToolInput>("write", event)) {
            return { block: false };
        }

        const input = event.input as ReadToolInput | WriteToolInput;
        const filePath = input.path;
        const cwd = ctx.cwd ?? process.cwd();
        const confinement = sandboxConfig.current?.heuristics?.cwdConfinement;

        if (isSafeHeuristic(getPathConfinementPermission(filePath, cwd, confinement, operation))) {
            return { block: false };
        }

        const approvedFolder = getApprovedFolder(filePath, cwd, operation, sessionFolders);
        if (approvedFolder !== undefined) {
            return { block: false };
        }

        const folder = sessionFolderFor(filePath, cwd);
        const result = await promptForFileAccess(operation, filePath, folder, ctx);
        const choice = result?.value;

        if (result?.message) {
            (event.input as any)._userMessage = result.message;
        }

        if (choice?.kind === "remember") {
            sessionFolders.add(choice.folder);
            pi.appendEntry<AllowedFileEntry>(ALLOWED_FILE_ENTRY_TYPE, {
                operation,
                folder: choice.folder,
            });
            ctx.ui.notify(
                `pi-${operation}-sandbox: session folder allowed: "${choice.folder}" (this session only)`,
                "info",
            );
            return { block: false };
        }

        if (choice?.kind === "yes") {
            return { block: false };
        }

        const mode = ctx.hasUI ? "user" : "non-interactive mode";
        return {
            block: true,
            reason: `File ${operation} blocked by ${mode}; path is outside the allowed working directory.`,
        };
    });

    // Preserve an optional note from the permission dialog in the tool result,
    // matching the bash hook's behavior.
    pi.on("tool_result", async (event) => {
        const isMatchingTool = operation === "read"
            ? isReadToolResult(event)
            : isWriteToolResult(event);
        if (!isMatchingTool) return;

        const userMessage = (event.input as any)._userMessage;
        if (!userMessage) return;

        const trimmed = userMessage.trim();
        const note = trimmed.includes("\n")
            ? `<user_note>\nThe user has made a note: ${trimmed}\n</user_note>\n`
            : `<user_note>The user has made a note: ${trimmed}</user_note>\n`;
        return {
            content: [
                { type: "text", text: note },
                ...event.content,
            ],
        };
    });
}

export type { FileOperation };
