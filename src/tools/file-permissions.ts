import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    isReadToolResult,
    isWriteToolResult,
    type ExtensionAPI,
    type ExtensionContext,
    type ReadToolInput,
    type ToolCallEventResult,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import sandboxConfig, { type SandboxConfigCwdConfinement } from "../common/config";
import { getScratchpadPath } from "../modules/scratchpad";
import {
    createPermissionState,
    getPermissionState,
    type PermissionState,
} from "../modules/sandbox/permission-state";
import {
    ALLOWED_FILE_ENTRY_TYPE,
    type AllowedFileEntry,
} from "../common/audit";
import {
    getPathConfinementAssessment,
    getPathConfinementPermission,
    isPathWithinDirectory,
    isSafeHeuristic,
    UnsafeReason,
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

const approvedToolCalls = new WeakSet<object>();

export function isFileAccessApproved(event: object): boolean {
    return approvedToolCalls.has(event);
}

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

export function getApprovedFileFolder(
    filePath: string,
    cwd: string,
    operation: FileOperation,
    state: PermissionState,
    confinement = sandboxConfig.current?.heuristics?.cwdConfinement,
): string | undefined {

    for (const folder of state.fileFolders[operation]) {
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
    uiContext: ExtensionContext,
    signal: AbortSignal | undefined,
    events: ExtensionAPI["events"],
    promptTitle?: string | (() => string),
): Promise<SelectWithMessageResult<PromptChoice> | undefined> {
    if (!uiContext.hasUI) {
        return undefined;
    }

    const boldFolder = uiContext.ui.theme.bold(folder);
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
            title: promptTitle ?? `pi-${operation}-sandbox: allow ${operationLabel(operation)} path?`,
            contentLines: [filePath],
            items,
        },
        { ...uiContext, events },
        signal,
    );

    return result;
}

/**
 * Guard one of pi's built-in file tools. Paths inside cwd are granted by the
 * same confinement policy used by the bash heuristic. Other paths require an
 * explicit one-shot or session-scoped approval.
 */
export interface FilePermissionHookOptions {
    /** Permission state shared with the parent runtime for non-isolated children. */
    state?: PermissionState;
    /** Use the parent UI when this is a child extension. */
    promptContext?: ExtensionContext;
    /** Child hooks must not restore/reset their own transcript's folder entries. */
    restoreSession?: boolean;
    /** Child approvals update shared state but must not append to the child transcript. */
    persistSession?: boolean;
    /** Preserve child confinement by refusing sensitive/symlink paths without prompting. */
    childAccess?: boolean;
    /** Child hooks use their fixed confinement rather than parent config defaults. */
    confinement?: SandboxConfigCwdConfinement;
    /** Additional exact paths that are readable for this child runtime. */
    additionalReadRoots?: (ctx: ExtensionContext) => readonly string[];
    /** Worker hooks report dialogs through the child progress tracker. */
    permissionPending?: (pending: boolean, activity: string) => void;
    /** Optional run-labelled title for child permission dialogs. */
    promptTitle?: string | (() => string);
}

export default function registerFileToolHook(
    pi: ExtensionAPI,
    operation: FileOperation,
    options: FilePermissionHookOptions = {},
): void {
    const localState = createPermissionState();
    const stateFor = (ctx: ExtensionContext): PermissionState => {
        if (options.state) return options.state;
        if (ctx.sessionManager) return getPermissionState(ctx.sessionManager);
        return localState;
    };

    pi.on("session_start", (_event, ctx) => {
        if (options.restoreSession !== false) {
            restoreSessionFolders(ctx, operation, stateFor(ctx).fileFolders[operation]);
        }
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        let isReadLike = false;
        if (operation === "read") {
            isReadLike = event.toolName === "read"
                || event.toolName === "grep"
                || event.toolName === "find"
                || event.toolName === "ls";
        } else {
            isReadLike = event.toolName === "write" || event.toolName === "edit";
        }
        if (!isReadLike) return { block: false };

        const input = event.input as ReadToolInput | WriteToolInput;
        const filePath = input.path?.trim() || ".";
        const cwd = ctx.cwd ?? process.cwd();
        const state = stateFor(ctx);
        const confinement = options.confinement ?? sandboxConfig.current?.heuristics?.cwdConfinement;
        const scratchpadPath = getScratchpadPath(ctx.sessionManager);
        const scratchpadRoots = scratchpadPath ? [scratchpadPath] : [];
        const additionalRoots = [
            ...scratchpadRoots,
            ...(operation === "read" ? options.additionalReadRoots?.(ctx) ?? [] : []),
        ];

        if (isSafeHeuristic(getPathConfinementPermission(filePath, {
            cwd,
            config: confinement,
            access: operation,
            additionalRoots,
            sensitiveAdditionalRoots: scratchpadRoots,
        }))) {
            return { block: false };
        }

        if (options.childAccess) {
            const assessment = getPathConfinementAssessment(filePath, {
                cwd,
                config: confinement,
                access: operation,
                additionalRoots,
                sensitiveAdditionalRoots: scratchpadRoots,
            });
            if (assessment.reasons.length !== 1 || assessment.reasons[0] !== UnsafeReason.OUTSIDE_CWD) {
                return {
                    block: true,
                    reason: `Child ${operation} access blocked: path is outside the working directory or is sensitive.`,
                };
            }
        }

        const approvedFolder = getApprovedFileFolder(filePath, cwd, operation, state, confinement);
        if (approvedFolder !== undefined) {
            approvedToolCalls.add(event);
            return { block: false };
        }

        const folder = sessionFolderFor(filePath, cwd);
        options.permissionPending?.(true, `Waiting for permission to ${operation} ${filePath}`);
        let result: SelectWithMessageResult<PromptChoice> | undefined;
        try {
            result = await promptForFileAccess(
                operation,
                filePath,
                folder,
                options.promptContext ?? ctx,
                ctx.signal,
                pi.events,
                options.promptTitle,
            );
        } finally {
            options.permissionPending?.(false, "Working");
        }
        const choice = result?.value;

        if (result?.message) {
            (event.input as any)._userMessage = result.message;
        }

        if (choice?.kind === "remember") {
            approvedToolCalls.add(event);
            state.fileFolders[operation].add(choice.folder);
            if (options.persistSession !== false) {
                pi.appendEntry<AllowedFileEntry>(ALLOWED_FILE_ENTRY_TYPE, {
                    operation,
                    folder: choice.folder,
                });
            }
            (options.promptContext ?? ctx).ui.notify(
                `pi-${operation}-sandbox: session folder allowed: "${choice.folder}" (this session only)`,
                "info",
            );
            return { block: false };
        }

        if (choice?.kind === "yes") {
            approvedToolCalls.add(event);
            return { block: false };
        }

        const mode = ctx.hasUI ? "user" : "non-interactive mode";
        const baseReason = `File ${operation} blocked by ${mode}; path is outside the allowed working directory.`;
        return {
            block: true,
            reason: result?.message ? `${baseReason} User message: ${result.message}` : baseReason,
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
