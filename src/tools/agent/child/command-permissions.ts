import path from "node:path";

import {
    isToolCallEventType,
    type EventBus,
    type BashToolInput,
    type EditToolInput,
    type ExtensionAPI,
    type ExtensionContext,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { lookpath } from "lookpath";

import sandboxConfig from "../../../common/config";
import { getScratchpadPath } from "../../../modules/scratchpad";
import { PERMISSION_PROMPT_CONFIRMATION_DELAY_MS } from "../../../common/constants";
import sandbox from "../../../modules/sandbox/bubblewrap";
import {
    getPathConfinementAssessment,
    getPathConfinementPermission,
    Heuristic,
    isPathWithinDirectory,
    isSafeHeuristic,
    UnsafeReason,
} from "../../../modules/sandbox/heuristics";
import type { Permission } from "../../../modules/sandbox/permissions";
import { suggestRule } from "../../../modules/sandbox/suggestions";
import {
    createPermissionState,
    type PermissionState,
} from "../../../modules/sandbox/permission-state";
import { resolvePermissionDetails } from "../../../modules/sandbox/resolve";
import {
    selectWithMessage,
    type SelectMessageItem,
} from "../../../tui/select-with-message";
import { isFileAccessApproved } from "../../file-permissions";

interface CommandPermissionCallbacks {
    permissionPending(pending: boolean, activity: string): void;
    fileChanged(filePath: string): void;
    bashApproved(): void;
}

interface CommandPermissionOptions extends CommandPermissionCallbacks {
    parentContext: ExtensionContext;
    events?: EventBus;
    runId: string;
    runTitle?: string;
    agentName: string;
    /** Same-checkout children inherit parent session permissions. */
    nonIsolated?: boolean;
    permissionState?: PermissionState;
}

type PromptChoice = { kind: "yes" } | { kind: "no" };

function runLabel(options: CommandPermissionOptions): string {
    return options.runTitle ? `${options.runTitle} · ${options.runId}` : options.runId;
}

const COMMAND_CONFINEMENT = {
    enabled: true,
    permission: "allow" as const,
    resolveSymlinks: true,
};
const SETUP_BASH_TIMEOUT_SECONDS = 10 * 60;

function isCommandPathAllowed(
    filePath: string | undefined,
    cwd: string,
    additionalRoots: readonly string[] = [],
): boolean {
    const target = filePath?.trim() || cwd;
    return isSafeHeuristic(
        getPathConfinementPermission(target, cwd, COMMAND_CONFINEMENT, "write", additionalRoots),
    );
}

class PermissionQueue {
    private tail: Promise<void> = Promise.resolve();

    async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
        if (signal?.aborted) return undefined;
        let release!: () => void;
        const completed = new Promise<void>((resolve) => { release = resolve; });
        const previous = this.tail;
        this.tail = previous.catch(() => {}).then(() => completed);

        if (!signal) {
            await previous.catch(() => {});
            return release;
        }

        const acquired = await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", abort);
                resolve(value);
            };
            const abort = () => finish(false);
            signal.addEventListener("abort", abort, { once: true });
            void previous.then(() => finish(true), () => finish(true));
        });
        if (!acquired || signal.aborted) {
            release();
            return undefined;
        }
        return release;
    }
}

function getScratchpadRoots(ctx: ExtensionContext): readonly string[] {
    const scratchpadPath = getScratchpadPath(ctx.sessionManager);
    return scratchpadPath ? [scratchpadPath] : [];
}

function userNote(input: Record<string, unknown>): string | undefined {
    const note = input._userMessage;
    return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

function blockedReason(action: string, input: Record<string, unknown>): string {
    const note = userNote(input);
    return `Agent ${action} blocked by user.${note ? ` User message: ${note}` : ""}`;
}

async function prompt(
    options: CommandPermissionOptions,
    ctx: ExtensionContext,
    title: string | (() => string),
    contentLines: string[],
    activity: string,
    dialogOptions: {
        borderTone?: () => "border" | "borderAccent";
        handleSelectInput?: (key: string) => boolean;
        selectHelpText?: string;
    } = {},
): Promise<{ allowed: boolean; message?: string }> {
    if (!options.parentContext.hasUI) return { allowed: false };
    const items: SelectMessageItem<PromptChoice>[] = [
        { value: { kind: "yes" }, label: "Yes", description: "allow once" },
        { value: { kind: "no" }, label: "No", placeholder: "e.g., do not make this change" },
    ];
    options.permissionPending(true, activity);
    try {
        const result = await selectWithMessage(
            {
                title,
                contentLines,
                items,
                borderTone: dialogOptions.borderTone,
                handleSelectInput: dialogOptions.handleSelectInput,
                selectHelpText: dialogOptions.selectHelpText,
                confirmationDelayMs: PERMISSION_PROMPT_CONFIRMATION_DELAY_MS,
            },
            { ...options.parentContext, events: options.events },
            ctx.signal,
        );
        return {
            allowed: result?.value.kind === "yes",
            message: result?.message,
        };
    } finally {
        options.permissionPending(false, "Working");
    }
}

async function promptBash(
    options: CommandPermissionOptions,
    ctx: ExtensionContext,
    command: string,
    unresolved: string[][],
    permissionState: PermissionState,
    sandboxed: { value: boolean },
    canToggle: boolean,
): Promise<{ allowed: boolean; permission?: Permission; message?: string }> {
    if (!options.parentContext.hasUI) return { allowed: false };

    const suggestion = unresolved.length === 1 ? suggestRule(unresolved[0]) : null;
    const items: SelectMessageItem<PromptChoice | { kind: "remember"; saveRule: string }>[] = [
        { value: { kind: "yes" }, label: "Yes", description: "run once" },
    ];
    if (suggestion) {
        const boldPattern = options.parentContext.ui.theme.bold(suggestion);
        items.push({
            value: { kind: "remember", saveRule: suggestion },
            label: `Yes, and allow ${boldPattern}`,
            description: "remember for this session",
        });
    }
    items.push({
        value: { kind: "no" },
        label: "No",
        placeholder: "e.g., too risky",
    });

    options.permissionPending(true, "Waiting for permission to run bash");
    try {
        const result = await selectWithMessage(
            {
                title: () => `[${runLabel(options)}] ${options.agentName}: allow bash? — mode: ${sandboxed.value ? "sandbox" : "direct"}${canToggle ? " (s)" : ""}`,
                contentLines: command.split("\n"),
                items,
                borderTone: () => sandboxed.value ? "border" : "borderAccent",
                handleSelectInput: canToggle
                    ? (key) => {
                        if (!matchesKey(key, "s")) return false;
                        sandboxed.value = !sandboxed.value;
                        return true;
                    }
                    : undefined,
            },
            { ...options.parentContext, events: options.events },
            ctx.signal,
        );
        if (!result || result.value.kind === "no") {
            return { allowed: false, message: result?.message };
        }

        const permission = sandboxed.value ? "allow:sandbox" : "allow";
        if (result.value.kind === "remember") {
            permissionState.bashRules[result.value.saveRule] = permission;
        }
        return { allowed: true, permission, message: result.message };
    } finally {
        options.permissionPending(false, "Working");
    }
}

function relativePath(filePath: string, cwd: string): string {
    const resolved = path.resolve(cwd, filePath);
    const relative = path.relative(cwd, resolved);
    return relative || ".";
}

function boundedPreview(label: string, text: string, maxChars = 6_000): string[] {
    const clipped = text.length > maxChars
        ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} characters omitted)`
        : text;
    return [label, ...clipped.split("\n")];
}

function fileMutationPreview(event: { input: EditToolInput | WriteToolInput }, isEdit: boolean): string[] {
    if (!isEdit) {
        const input = event.input as WriteToolInput;
        return [input.path, ...boundedPreview(`Write ${input.content.length} characters:`, input.content)];
    }
    const input = event.input as EditToolInput;
    const lines = [input.path, `${input.edits.length} targeted replacement(s):`];
    for (const [index, edit] of input.edits.entries()) {
        lines.push(...boundedPreview(`Replacement ${index + 1} — old text:`, edit.oldText, 3_000));
        lines.push(...boundedPreview(`Replacement ${index + 1} — new text:`, edit.newText, 3_000));
    }
    const joined = lines.join("\n");
    return (joined.length > 12_000
        ? `${joined.slice(0, 12_000)}\n… (additional replacement content omitted)`
        : joined).split("\n");
}

/** Register the permission gate used by command-capable child sessions. */
export function registerCommandPermissionHooks(
    pi: ExtensionAPI,
    options: CommandPermissionOptions,
): void {
    const permissionQueue = new PermissionQueue();
    const releases = new Map<string, () => void>();
    const permissionState = options.permissionState ?? createPermissionState();

    pi.on("tool_call", async (event, ctx) => {
        const isEdit = isToolCallEventType<"edit", EditToolInput>("edit", event);
        const isWrite = isToolCallEventType<"write", WriteToolInput>("write", event);
        const isBash = isToolCallEventType<"bash", BashToolInput>("bash", event);
        if (!isEdit && !isWrite && !isBash) return;

        const release = await permissionQueue.acquire(ctx.signal);
        if (!release) return { block: true, reason: "Agent mutation canceled before permission was granted." };

        if (isEdit || isWrite) {
            const action = isEdit ? "edit" : "write";
            const input = event.input as EditToolInput | WriteToolInput;
            const additionalRoots = getScratchpadRoots(ctx);
            const cwdPathAllowed = isCommandPathAllowed(input.path, ctx.cwd, additionalRoots);
            const scratchpadPathAllowed = additionalRoots.some((root) =>
                isPathWithinDirectory(input.path, root, ctx.cwd, COMMAND_CONFINEMENT));
            if ((options.nonIsolated && cwdPathAllowed) || scratchpadPathAllowed) {
                // Same-checkout workers are trusted to mutate ordinary files in
                // their cwd. Scratchpad files are also trusted because they are
                // private runtime-owned temporary data. Keep the confinement
                // checks so sensitive project paths and symlink escapes cannot
                // be auto-approved accidentally.
                releases.set(event.toolCallId, release);
                return { block: false };
            }
            if (!cwdPathAllowed) {
                const assessment = getPathConfinementAssessment(
                    input.path,
                    ctx.cwd,
                    COMMAND_CONFINEMENT,
                    "write",
                    additionalRoots,
                );
                const outsideCwd = assessment.reasons.length === 1
                    && assessment.reasons[0] === UnsafeReason.OUTSIDE_CWD;
                // The shared file hook handles explicit outside-cwd access for
                // non-isolated children. Sensitive paths and symlink escapes
                // remain blocked before any prompt.
                if (options.nonIsolated && outsideCwd && isFileAccessApproved(event)) {
                    releases.set(event.toolCallId, release);
                    return { block: false };
                }
                release();
                return {
                    block: true,
                    reason: `Agent ${action} blocked: path is outside the working directory or is sensitive.`,
                };
            }
            const contentLines = fileMutationPreview(event, isEdit);
            let result: { allowed: boolean; message?: string };
            try {
                result = await prompt(
                    options,
                    ctx,
                    `[${runLabel(options)}] ${options.agentName}: allow ${action}?`,
                    contentLines,
                    `Waiting for permission to ${action} ${relativePath(input.path, ctx.cwd)}`,
                );
            } catch (error) {
                release();
                throw error;
            }
            if (result.message) (event.input as Record<string, unknown>)._userMessage = result.message;
            if (!result.allowed) {
                release();
                return { block: true, reason: blockedReason(action, event.input as Record<string, unknown>) };
            }
            releases.set(event.toolCallId, release);
            return { block: false };
        }

        const input = event.input as BashToolInput;
        if (options.agentName === "workspace-setup" && input.timeout === undefined) {
            input.timeout = SETUP_BASH_TIMEOUT_SECONDS;
        }
        let permission: Permission = "ask";
        let unresolved: string[][] = [];
        const additionalRoots = getScratchpadRoots(ctx);
        try {
            const details = resolvePermissionDetails(input.command, ctx.cwd, {
                permissions: {
                    ...sandboxConfig.current?.permissions,
                    ...(options.nonIsolated ? permissionState.bashRules : {}),
                },
                additionalRoots,
            });
            permission = details.permission;
            unresolved = details.unresolved;
        } catch {
            permission = "ask";
        }
        if (permission === "deny") {
            release();
            return { block: true, reason: "Agent bash blocked by configured permission policy." };
        }

        const sandboxEnabled = sandboxConfig.current?.sandbox.enabled !== false;
        const supported = process.platform === "linux" || process.platform === "freebsd";
        let bwrap = "";
        try {
            bwrap = sandboxEnabled && supported ? (await lookpath("bwrap")) ?? "" : "";
        } catch (error) {
            release();
            throw error;
        }
        let sandboxedModeValue = false;
        if (permission === "allow:sandbox") {
            sandboxedModeValue = sandboxEnabled;
        } else if (permission === "ask") {
            sandboxedModeValue = permissionState.bashSandboxed && sandboxEnabled && bwrap.length > 0;
        }
        const sandboxedMode = { value: sandboxedModeValue };
        const sandboxed = sandboxedMode.value;
        if (sandboxed && !bwrap) {
            release();
            return { block: true, reason: "Agent bash requires sandboxing, but bubblewrap is unavailable." };
        }
        const needsPrompt = permission === "ask";
        const canToggle = needsPrompt && sandboxEnabled && bwrap.length > 0;
        let result: { allowed: boolean; permission?: Permission; message?: string } = {
            allowed: permission !== "ask",
            permission,
        };
        try {
            if (needsPrompt) {
                result = await promptBash(
                    options,
                    ctx,
                    input.command,
                    unresolved,
                    permissionState,
                    sandboxedMode,
                    canToggle,
                );
            }
        } catch (error) {
            release();
            throw error;
        }
        if (result.message) (event.input as Record<string, unknown>)._userMessage = result.message;
        if (!result.allowed) {
            release();
            return { block: true, reason: blockedReason("bash", event.input as Record<string, unknown>) };
        }
        permission = result.permission ?? permission;
        if (needsPrompt && canToggle) {
            permissionState.bashSandboxed = sandboxedMode.value;
        }
        options.bashApproved();
        if (sandboxedMode.value) {
            try {
                input.command = sandbox(bwrap, input.command, {
                    cwd: ctx.cwd,
                    additionalRoots,
                });
            } catch (error) {
                release();
                throw error;
            }
        }
        releases.set(event.toolCallId, release);
        return { block: false };
    });

    pi.on("tool_result", (event) => {
        const release = releases.get(event.toolCallId);
        if (release) {
            releases.delete(event.toolCallId);
            release();
        }
        if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
            const filePath = event.input.path;
            if (typeof filePath === "string") options.fileChanged(relativePath(filePath, options.parentContext.cwd));
        }

        const note = userNote(event.input);
        if (!note) return;
        const text = note.includes("\n")
            ? `<user_note>\nThe user has made a note: ${note}\n</user_note>\n`
            : `<user_note>The user has made a note: ${note}</user_note>\n`;
        return { content: [{ type: "text" as const, text }, ...event.content] };
    });
}
