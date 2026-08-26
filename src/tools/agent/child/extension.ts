import path from "node:path";
import {
    isToolCallEventType,
    type EventBus,
    type ExtensionAPI,
    type ExtensionContext,
    type BashToolInput,
    type FindToolInput,
    type GrepToolInput,
    type LsToolInput,
    type ReadToolInput,
    type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SandboxConfigCwdConfinement } from "../../../common/config";
import {
    getPathConfinementPermission,
    Heuristic,
} from "../../../modules/sandbox/heuristics";
import { askUser } from "../../../tui/ask-user";
import registerFileToolHook, {
    isFileAccessApproved,
} from "../../file-permissions";
import { getPermissionState } from "../../../modules/sandbox/permission-state";
import { guardSafeBashCommand } from "./safe-bash";
import { registerCommandPermissionHooks } from "./command-permissions";
import type { ChildAgentFactoryContext } from "../contracts/runs";
import type { ChildProgressTracker as ProgressTracker } from "./progress";

const MAX_RECENT_ACTIVITY = 8;

const CHILD_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};

export function childProtocolPrompt(
    background: boolean,
    canEdit: boolean,
    safeBash: boolean,
    allowUserInteraction = true,
    isolated = false,
    commandRunner = false,
): string {
    const interaction = background || !allowUserInteraction
        ? "If guidance from the parent is necessary, make reasonable progress first, then use `ask_parent` with the evidence you found and your recommended course. Call `ask_parent` by itself, not alongside other tools."
        : [
            "Use `ask_user` when you need a preference, clarification, or decision from the end user. Call it by itself, not alongside other tools, and continue after the answer is returned.",
            "Use `ask_parent` instead when the parent can answer or make the decision. Before asking, make reasonable progress and include the evidence you found and your recommendation. Do not leave a blocking question only in prose when an interaction tool applies.",
        ].join(" ");
    let capability: string;
    if (canEdit && isolated) {
        capability = [
            "Run mode: mutation-capable worker in a separate Git worktree.",
            "This worktree is your current working directory. Changes you make there do not affect the parent's checkout unless the parent later applies your result.",
            "This run has its own permission state. A file mutation or Bash command that is not already allowed may pause while the end user decides whether to approve it; do not assume an approval granted to the parent also applies to you.",
            "Run only one mutation tool at a time. Other isolated workers may run concurrently, so avoid destructive Git operations and keep changes narrow.",
        ].join("\n\n");
    } else if (canEdit) {
        capability = [
            "Run mode: mutation-capable worker in the parent's current checkout. That checkout is your current working directory.",
            "You may call `edit` and `write` directly for paths inside the current working directory; that access is already authorized and does not require an additional approval request. Eligible file access outside it may pause while the end user approves or denies the request. Sensitive paths and paths that escape through symlinks are always blocked.",
            "A Bash command covered by an existing parent permission rule runs immediately. Any other eligible command may pause while the end user approves or denies it. A denied command or one rejected by the safety checks remains blocked.",
            "Successful changes appear immediately in the parent's checkout. Inspect the latest file contents before editing, preserve unrelated changes, and run only one mutation tool at a time.",
        ].join("\n\n");
    } else if (commandRunner) {
        capability = [
            "Run mode: delegated agent with permission-gated command execution.",
            "You may use `read`, `grep`, `find`, and `ls`. Every direct file path, after resolving symlinks, must remain inside the current working directory and must not enter a sensitive location. You cannot use direct edit or write tools.",
            "You may use `bash`. Commands recognized as local read-only inspection run directly; other eligible commands may pause while the end user approves or denies them. Approved commands can have project side effects, so keep them relevant to validation and do not assume a command is harmless because it has a test-like name.",
        ].join("\n\n");
    } else {
        const bashAccess = safeBash
            ? "You may also use `bash`, but only for local inspection commands that the runtime recognizes as read-only. Commands that may write, use unsafe modes, access the network or sensitive paths, or cannot be classified safely are blocked. If a command is blocked, use the stated reason to choose a read/search tool or report the limitation; do not try alternate spellings to bypass the restriction."
            : "The `bash` tool is unavailable in this run.";

        capability = [
            "Run mode: read-only delegated agent.",
            "You may use `read`, `grep`, `find`, and `ls`. Every path, after resolving symlinks, must remain inside the current working directory and must not enter a sensitive location. You cannot modify files.",
            bashAccess,
        ].join("\n\n");
    }

    const reporting = canEdit
        ? "When finished, give the parent a self-contained report with a summary, every changed file, validation performed, and any unresolved concern."
        : "When finished, give the parent a self-contained report with your findings, supporting evidence, limitations, and useful next steps.";

    return `${capability}\n\n${interaction}\n\n${reporting}`;

}

export function isChildPathAllowed(filePath: string | undefined, cwd: string): boolean {
    const effectivePath = filePath?.trim() || cwd;
    return getPathConfinementPermission(effectivePath, cwd, CHILD_CONFINEMENT) === Heuristic.SAFE_READONLY;
}

export { getScoutBashAssessment, isScoutBashAllowed } from "./safe-bash";

export interface ChildUserQuestion {
    title: string;
    description?: string;
    options: Array<{ label: string; description?: string }>;
}

export interface ChildUserAnswerDetails {
    unavailable?: boolean;
    canceled?: boolean;
    answer?: string;
    isCustom?: boolean;
    optionIndex?: number;
}

export interface ChildUserAnswerResult {
    content: Array<{ type: "text"; text: string }>;
    details: ChildUserAnswerDetails;
}

export async function askChildUser(
    question: ChildUserQuestion,
    parentContext: ExtensionContext,
    agentName: string,
    signal?: AbortSignal,
    events?: EventBus,
): Promise<ChildUserAnswerResult> {
    if (!parentContext.hasUI || parentContext.mode !== "tui") {
        return {
            content: [{
                type: "text" as const,
                text: "Direct user interaction is unavailable in this mode. Use ask_parent for guidance instead.",
            }],
            details: { unavailable: true },
        };
    }

    const result = await askUser({
        title: `${agentName} asks: ${question.title}`,
        description: question.description,
        options: question.options,
    }, { hasUI: parentContext.hasUI, ui: parentContext.ui, events }, signal);

    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Child user question was aborted.");
    }
    if (!result) {
        return {
            content: [{
                type: "text" as const,
                text: "The user cancelled the question. Continue with a reasonable default or use ask_parent if guidance is required.",
            }],
            details: { canceled: true },
        };
    }

    const responseText = result.isCustom
        ? `User replied with custom message: ${result.answer}`
        : `User selected: ${result.answer}`;
    return {
        content: [{ type: "text" as const, text: responseText }],
        details: {
            answer: result.answer,
            isCustom: result.isCustom,
            optionIndex: result.optionIndex,
        },
    };
}

export function registerChildExtension(
    tracker: ProgressTracker,
    parentContext: ExtensionContext,
    cwd: string,
    agentName: string,
    background: boolean,
    canEdit: boolean,
    safeBash: boolean,
    runId: string,
    runTitle: string,
    onProgress: ChildAgentFactoryContext["onProgress"],
    onFileChanged?: ChildAgentFactoryContext["onFileChanged"],
    onTrace?: ChildAgentFactoryContext["onTrace"],
    events?: EventBus,
    allowUserInteraction = true,
    workspaceId?: string,
    isolated = false,
    commandRunner = false,
) {
    return (pi: ExtensionAPI): void => {
        const nonIsolated = !isolated && workspaceId === undefined;
        const parentSessionManager = parentContext.sessionManager;
        const permissionState = nonIsolated && parentSessionManager
            ? getPermissionState(parentSessionManager)
            : undefined;
        const childRunLabel = runTitle ? `${runTitle} · ${runId}` : runId;
        const reportPermissionPending = (pending: boolean, activity: string): void => {
            tracker.progress.permissionPending = pending;
            tracker.progress.recentActivity.push(activity);
            tracker.progress.recentActivity = tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
            onTrace?.("mutation.permission", { pending, activity });
            onProgress({
                output: tracker.progress.output,
                ...(tracker.progress.lastAssistantMessage
                    ? { lastAssistantMessage: tracker.progress.lastAssistantMessage }
                    : {}),
                recentActivity: [...tracker.progress.recentActivity],
                ...(tracker.progress.phase ? { phase: tracker.progress.phase } : {}),
                ...(tracker.progress.lastToolActivity ? { lastToolActivity: tracker.progress.lastToolActivity } : {}),
                ...(tracker.progress.toolCounts ? { toolCounts: { ...tracker.progress.toolCounts } } : {}),
                permissionPending: pending,
            });
        };

        if (nonIsolated && canEdit && permissionState !== undefined) {
            const fileHookOptions = {
                state: permissionState,
                promptContext: parentContext,
                restoreSession: false,
                persistSession: false,
                childAccess: true,
                confinement: CHILD_CONFINEMENT,
                permissionPending: reportPermissionPending,
            };
            registerFileToolHook(pi, "read", {
                ...fileHookOptions,
                promptTitle: `[${childRunLabel}] ${agentName}: allow read path?`,
            });
            registerFileToolHook(pi, "write", {
                ...fileHookOptions,
                promptTitle: `[${childRunLabel}] ${agentName}: allow write path?`,
            });
        }

        if (!background && allowUserInteraction) pi.registerTool({
            name: "ask_user",
            label: "Ask User",
            description:
                "Ask the end user for a preference, clarification, or decision, then continue this child turn. "
                + "Use ask_parent instead when the parent agent can investigate or decide.",
            promptSnippet: "Use ask_user for decisions that require direct end-user input.",
            promptGuidelines: [
                "Use ask_user only when the end user's input materially affects the work, and call it alone in its tool batch",
                "Include a recommendation and an Unsure or You decide option when appropriate",
                "Continue the task after receiving the user's answer",
            ],
            executionMode: "sequential",
            parameters: Type.Object({
                title: Type.String({ minLength: 1, maxLength: 200 }),
                description: Type.Optional(Type.String({ maxLength: 4_000 })),
                options: Type.Array(Type.Object({
                    label: Type.String({ minLength: 1, maxLength: 500 }),
                    description: Type.Optional(Type.String({ maxLength: 2_000 })),
                }, { additionalProperties: false }), { minItems: 2, maxItems: 8 }),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params, signal) {
                onTrace?.("interaction.user.opened", {
                    titleChars: params.title.length,
                    optionCount: params.options.length,
                });
                try {
                    const result = await askChildUser(params, parentContext, agentName, signal, events);
                    const outcome = result.details.unavailable
                        ? "unavailable"
                        : result.details.canceled
                            ? "canceled"
                            : result.details.isCustom
                                ? "custom_answer"
                                : "option_selected";
                    onTrace?.("interaction.user.closed", {
                        outcome,
                        optionIndex: result.details.optionIndex ?? -1,
                        answerChars: result.details.answer?.length ?? 0,
                    });
                    return result;
                } catch (error) {
                    onTrace?.("interaction.user.aborted", {
                        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
                    });
                    throw error;
                }
            },
        });

        pi.registerTool({
            name: "ask_parent",
            label: "Ask Parent",
            description:
                "Pause and request guidance from the parent agent. "
                + "Use only after making reasonable progress and include evidence and a recommendation.",
            promptSnippet: "Use ask_parent to pause and request guidance from the parent agent.",
            promptGuidelines: [
                "Call ask_parent alone in a tool batch and only when parent guidance materially improves the result",
                "Include relevant evidence, partial findings, and your recommended next step",
                background || !allowUserInteraction
                    ? "Direct end-user dialogs are unavailable for this child"
                    : "Use ask_user instead when a decision genuinely requires direct end-user input",
            ],
            executionMode: "sequential",
            parameters: Type.Object({
                question: Type.String({ minLength: 1, maxLength: 4_000 }),
                context: Type.Optional(Type.String({ maxLength: 12_000 })),
                options: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 8 })),
                recommendation: Type.Optional(Type.String({ maxLength: 4_000 })),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params) {
                if (tracker.pendingQuestion) {
                    return {
                        content: [{ type: "text", text: "A parent-guidance request is already pending." }],
                        details: tracker.pendingQuestion,
                        terminate: true,
                    };
                }

                tracker.pendingQuestion = {
                    question: params.question,
                    context: params.context,
                    options: params.options,
                    recommendation: params.recommendation,
                };
                onTrace?.("interaction.parent.requested", {
                    questionChars: params.question.length,
                    optionCount: params.options?.length ?? 0,
                });
                return {
                    content: [{ type: "text", text: "Paused for parent guidance." }],
                    details: tracker.pendingQuestion,
                    terminate: true,
                };
            },
        });

        if (canEdit || commandRunner) {
            registerCommandPermissionHooks(pi, {
                parentContext,
                events,
                runId,
                runTitle,
                agentName,
                nonIsolated,
                permissionState,
                permissionPending: reportPermissionPending,
                fileChanged(filePath) {
                    const wasChanged = tracker.changedFiles.has(filePath);
                    tracker.changedFiles.add(filePath);
                    if (!wasChanged) onFileChanged?.(filePath);
                    onTrace?.("mutation.file_changed", { path: filePath });
                },
                bashApproved() {
                    tracker.bashApproved = true;
                    onTrace?.("mutation.bash_approved");
                },
            });
        }

        pi.on("tool_call", (event, ctx) => {
            if (!canEdit && !commandRunner && isToolCallEventType<"bash", BashToolInput>("bash", event)) {
                return guardSafeBashCommand(event.input.command, ctx.cwd, safeBash, onTrace);
            }

            const filePath = readToolPath(event);
            if (filePath === undefined) return;
            if (!isChildPathAllowed(filePath, ctx.cwd)) {
                if (!isFileAccessApproved(event)) {
                    return {
                        block: true,
                        reason: "Read-only child access blocked: path is outside the allowed working directory or is sensitive.",
                    };
                }
            }
            tracker.readFiles.add(relativeReadPath(filePath, ctx.cwd));
        });
    };
}

function readToolPath(event: ToolCallEvent): string | undefined {
    if (isToolCallEventType<"read", ReadToolInput>("read", event)) return event.input.path;
    if (isToolCallEventType<"grep", GrepToolInput>("grep", event)) return event.input.path;
    if (isToolCallEventType<"find", FindToolInput>("find", event)) return event.input.path;
    if (isToolCallEventType<"ls", LsToolInput>("ls", event)) return event.input.path;
    return undefined;
}

function relativeReadPath(filePath: string | undefined, cwd: string): string {
    const resolved = path.resolve(cwd, filePath?.trim() || ".");
    return path.relative(cwd, resolved) || ".";
}

