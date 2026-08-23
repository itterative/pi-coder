import path from "node:path";

import {
    isToolCallEventType,
    type BashToolInput,
    type EditToolInput,
    type ExtensionAPI,
    type ExtensionContext,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { lookpath } from "lookpath";

import sandboxConfig from "../../common/config";
import sandbox from "../../modules/sandbox/bubblewrap";
import { getPathConfinementPermission } from "../../modules/sandbox/heuristics";
import type { Permission } from "../../modules/sandbox/permissions";
import { resolvePermissionDetails } from "../../modules/sandbox/resolve";
import {
    selectWithMessage,
    type SelectMessageItem,
} from "../../tui/select-with-message";

interface WorkerMutationCallbacks {
    permissionPending(pending: boolean, activity: string): void;
    fileChanged(filePath: string): void;
    bashApproved(): void;
}

interface WorkerMutationOptions extends WorkerMutationCallbacks {
    parentContext: ExtensionContext;
    runId: string;
    runTitle?: string;
    agentName: string;
}

type PromptChoice = { kind: "yes" } | { kind: "no" };

function runLabel(options: WorkerMutationOptions): string {
    return options.runTitle ? `${options.runTitle} · ${options.runId}` : options.runId;
}

const WORKER_CONFINEMENT = {
    enabled: true,
    permission: "allow" as const,
    resolveSymlinks: true,
};

function isWorkerPathAllowed(filePath: string | undefined, cwd: string): boolean {
    const target = filePath?.trim() || cwd;
    return getPathConfinementPermission(target, cwd, WORKER_CONFINEMENT) !== undefined;
}

class MutationQueue {
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

function userNote(input: Record<string, unknown>): string | undefined {
    const note = input._userMessage;
    return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

function blockedReason(action: string, input: Record<string, unknown>): string {
    const note = userNote(input);
    return `Worker ${action} blocked by user.${note ? ` User message: ${note}` : ""}`;
}

async function prompt(
    options: WorkerMutationOptions,
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
            },
            options.parentContext,
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

/** Register the mutation gate used only by the built-in worker child. */
export function registerWorkerMutationHooks(
    pi: ExtensionAPI,
    options: WorkerMutationOptions,
): void {
    const mutationQueue = new MutationQueue();
    const releases = new Map<string, () => void>();

    pi.on("tool_call", async (event, ctx) => {
        const isEdit = isToolCallEventType<"edit", EditToolInput>("edit", event);
        const isWrite = isToolCallEventType<"write", WriteToolInput>("write", event);
        const isBash = isToolCallEventType<"bash", BashToolInput>("bash", event);
        if (!isEdit && !isWrite && !isBash) return;

        const release = await mutationQueue.acquire(ctx.signal);
        if (!release) return { block: true, reason: "Worker mutation canceled before permission was granted." };

        if (isEdit || isWrite) {
            const action = isEdit ? "edit" : "write";
            const input = event.input as EditToolInput | WriteToolInput;
            if (!isWorkerPathAllowed(input.path, ctx.cwd)) {
                release();
                return {
                    block: true,
                    reason: `Worker ${action} blocked: path is outside the working directory or is sensitive.`,
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
        let permission: Permission = "ask";
        try {
            permission = resolvePermissionDetails(input.command, ctx.cwd, {
                permissions: sandboxConfig.current?.permissions,
            }).permission;
        } catch {
            permission = "ask";
        }
        if (permission === "deny") {
            release();
            return { block: true, reason: "Worker bash blocked by configured permission policy." };
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
        let sandboxed = permission === "allow:sandbox" && sandboxEnabled;
        if (permission === "ask") sandboxed = sandboxEnabled && bwrap.length > 0;
        if (sandboxed && !bwrap) {
            release();
            return { block: true, reason: "Worker bash requires sandboxing, but bubblewrap is unavailable." };
        }
        const canToggle = permission === "ask" && sandboxEnabled && bwrap.length > 0;
        let result: { allowed: boolean; message?: string };
        try {
            result = await prompt(
                options,
                ctx,
                () => `[${runLabel(options)}] ${options.agentName}: allow bash? — mode: ${sandboxed ? "sandbox" : "direct"}${canToggle ? " (s)" : ""}`,
                input.command.split("\n"),
                "Waiting for permission to run bash",
                {
                    borderTone: () => sandboxed ? "border" : "borderAccent",
                    handleSelectInput: canToggle
                        ? (key) => {
                            if (!matchesKey(key, "s")) return false;
                            sandboxed = !sandboxed;
                            return true;
                        }
                        : undefined,
                },
            );
        } catch (error) {
            release();
            throw error;
        }
        if (result.message) (event.input as Record<string, unknown>)._userMessage = result.message;
        if (!result.allowed) {
            release();
            return { block: true, reason: blockedReason("bash", event.input as Record<string, unknown>) };
        }
        options.bashApproved();
        if (sandboxed) {
            try {
                input.command = sandbox(bwrap, input.command, { cwd: ctx.cwd });
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
