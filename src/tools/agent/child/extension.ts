import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    isBashToolResult,
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
import { getPathConfinementPermission, Heuristic } from "../../../modules/sandbox/heuristics";
import { askUser } from "../../../tui/ask-user";
import { getScratchpadPath } from "../../../modules/scratchpad";
import registerFileToolHook, { isFileAccessApproved } from "../../file-permissions";
import { getPermissionState } from "../../../modules/sandbox/permission-state";
import { guardSafeBashCommand } from "./safe-bash";
import { registerCommandPermissionHooks } from "./command-permissions";
import type { ChildAgentFactoryContext } from "../contracts/runs";
import { hasAgentAuthority } from "../definitions/types";
import type { AgentAuthority } from "../definitions/types";
import { reportProgress } from "./progress";
import type { ChildProgressTracker as ProgressTracker } from "./progress";

const MAX_RECENT_ACTIVITY = 8;

const CHILD_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};

/** Named options for child read-path confinement checks. */
export interface ChildPathOptions {
    additionalRoots?: readonly string[];
    sensitiveAdditionalRoots?: readonly string[];
}

export function isChildPathAllowed(
    filePath: string | undefined,
    cwd: string,
    options: ChildPathOptions = {},
): boolean {
    const { additionalRoots = [], sensitiveAdditionalRoots = [] } = options;
    const effectivePath = filePath?.trim() || cwd;
    return (
        getPathConfinementPermission(effectivePath, {
            cwd,
            config: CHILD_CONFINEMENT,
            access: "read",
            additionalRoots,
            sensitiveAdditionalRoots,
        }) === Heuristic.SAFE_READONLY
    );
}

export {
    getSafeBashAssessment,
    getScoutBashAssessment,
    guardSafeBashCommand,
    isSafeBashAllowed,
    isScoutBashAllowed,
    type SafeBashGuardOptions,
    type SafeBashOptions,
} from "./safe-bash";

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
            content: [
                {
                    type: "text" as const,
                    text: "Direct user interaction is unavailable in this mode. Use ask_parent for guidance instead.",
                },
            ],
            details: { unavailable: true },
        };
    }

    const result = await askUser(
        {
            title: `${agentName} asks: ${question.title}`,
            description: question.description,
            options: question.options,
        },
        { hasUI: parentContext.hasUI, ui: parentContext.ui, events },
        signal,
    );

    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Child user question was aborted.");
    }
    if (!result) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: "The user cancelled the question. Continue with a reasonable default or use ask_parent if guidance is required.",
                },
            ],
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

/**
 * What the child extension needs, all of it already resolved by `resolveChildGrant`.
 *
 * Nothing here is a raw capability flag to be combined: `authority` is the rung, `isolated` is the
 * reconciled run mode, and `canAskUser` already accounts for the parent's ability to host a prompt.
 * An earlier version of this bag carried `allowUserInteraction` plus `workspaceId` and re-derived
 * both decisions here, which is how the same question came to have two answers.
 */
export interface ChildExtensionOptions {
    agentName: string;
    /** Where this child sits on the command-and-mutation ladder; decides which gates get installed. */
    authority: AgentAuthority;
    /** Whether the run owns a workspace, with a workspace id already counted as isolated. */
    isolated: boolean;
    /** Whether this child may prompt the end user, with parent UI availability already counted. */
    canAskUser: boolean;
    runId: string;
    runTitle: string;
    onProgress: ChildAgentFactoryContext["onProgress"];
    onFileChanged?: ChildAgentFactoryContext["onFileChanged"];
    onTrace?: ChildAgentFactoryContext["onTrace"];
    events?: EventBus;
    additionalPaths?: readonly string[];
    safeBashCommands?: readonly string[];
    /** Default timeout applied to Bash calls when the caller sets one, for example workspace setup. */
    defaultBashTimeoutSeconds?: number;
}

export function registerChildExtension(
    tracker: ProgressTracker,
    parentContext: ExtensionContext,
    cwd: string,
    {
        agentName,
        authority,
        isolated,
        canAskUser,
        runId,
        runTitle,
        onProgress,
        onFileChanged,
        onTrace,
        events,
        additionalPaths = [],
        safeBashCommands = [],
        defaultBashTimeoutSeconds,
    }: ChildExtensionOptions,
) {
    return (pi: ExtensionAPI): void => {
        const bashOutputPaths = new Map<string, BashOutputPath>();
        const readRoots = (ctx: ExtensionContext): readonly string[] => [
            ...additionalPaths,
            ...getScratchpadRoots(ctx),
            ...activeBashOutputPaths(bashOutputPaths),
        ];
        const rememberSessionBashOutputs = (ctx: ExtensionContext): void => {
            for (const entry of ctx.sessionManager?.getBranch() ?? []) {
                if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
                if (entry.message.toolName !== "bash") continue;
                rememberBashOutputPath(
                    bashOutputPaths,
                    (entry.message as { details?: unknown }).details,
                );
            }
        };
        pi.on("session_start", (_event, ctx) => {
            rememberSessionBashOutputs(ctx);
        });
        pi.on("tool_result", (event) => {
            if (!isBashToolResult(event)) return;
            rememberBashOutputPath(bashOutputPaths, event.details);
        });

        // The grant already reconciled the run mode, so this extension and the protocol prompt can
        // no longer disagree about whether a run is isolated.
        const nonIsolated = !isolated;
        const parentSessionManager = parentContext.sessionManager;
        const parentPermissionState =
            parentSessionManager && hasAgentAuthority(authority, "command")
                ? getPermissionState(parentSessionManager)
                : undefined;
        const permissionState = nonIsolated ? parentPermissionState : undefined;
        const childRunLabel = runTitle ? `${runTitle} · ${runId}` : runId;
        const reportPermissionPending = (pending: boolean, activity: string): void => {
            tracker.progress.permissionPending = pending;
            tracker.progress.recentActivity.push(activity);
            tracker.progress.recentActivity =
                tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
            onTrace?.("mutation.permission", { pending, activity });
            // `permissionPending` is already stored above, so the shared frame projection
            // carries the same value this callback used to spell out by hand.
            reportProgress(tracker, onProgress);
        };

        if (nonIsolated && authority === "mutate" && permissionState !== undefined) {
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
                additionalReadRoots: () => [
                    ...additionalPaths,
                    ...activeBashOutputPaths(bashOutputPaths),
                ],
                promptTitle: `[${childRunLabel}] ${agentName}: allow read path?`,
            });
            registerFileToolHook(pi, "write", {
                ...fileHookOptions,
                promptTitle: `[${childRunLabel}] ${agentName}: allow write path?`,
            });
        }

        if (canAskUser)
            pi.registerTool({
                name: "ask_user",
                label: "Ask User",
                description:
                    "Ask the end user for a preference, clarification, or decision, then continue this child turn. " +
                    "Use ask_parent instead when the parent agent can investigate or decide.",
                promptSnippet: "Use ask_user for decisions that require direct end-user input.",
                promptGuidelines: [
                    "Use ask_user only when the end user's input materially affects the work, and call it alone in its tool batch",
                    "Include a recommendation and an Unsure or You decide option when appropriate",
                    "Continue the task after receiving the user's answer",
                ],
                executionMode: "sequential",
                parameters: Type.Object(
                    {
                        title: Type.String({ minLength: 1, maxLength: 200 }),
                        description: Type.Optional(Type.String({ maxLength: 4_000 })),
                        options: Type.Array(
                            Type.Object(
                                {
                                    label: Type.String({ minLength: 1, maxLength: 500 }),
                                    // Keep bounded string repeats under llama.cpp's grammar
                                    // parser threshold (max repetition 2000): char{0,N} with
                                    // N >= 2000 fails grammar parsing and 400s the request.
                                    description: Type.Optional(Type.String({ maxLength: 1_000 })),
                                },
                                { additionalProperties: false },
                            ),
                            { minItems: 2, maxItems: 8 },
                        ),
                    },
                    { additionalProperties: false },
                ),
                async execute(_toolCallId, params, signal) {
                    onTrace?.("interaction.user.opened", {
                        titleChars: params.title.length,
                        optionCount: params.options.length,
                    });
                    try {
                        const result = await askChildUser(
                            params,
                            parentContext,
                            agentName,
                            signal,
                            events,
                        );
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
                            error:
                                error instanceof Error
                                    ? error.message.slice(0, 500)
                                    : String(error).slice(0, 500),
                        });
                        throw error;
                    }
                },
            });

        pi.registerTool({
            name: "ask_parent",
            label: "Ask Parent",
            description:
                "Pause and request guidance from the parent agent. " +
                "Use only after making reasonable progress and include evidence and a recommendation.",
            promptSnippet: "Use ask_parent to pause and request guidance from the parent agent.",
            promptGuidelines: [
                "Call ask_parent alone in a tool batch and only when parent guidance materially improves the result",
                "Include relevant evidence, partial findings, and your recommended next step",
                ...(canAskUser
                    ? ["Use ask_user when a decision genuinely requires direct end-user input"]
                    : []),
            ],
            executionMode: "sequential",
            parameters: Type.Object(
                {
                    question: Type.String({ minLength: 1, maxLength: 4_000 }),
                    context: Type.Optional(Type.String({ maxLength: 12_000 })),
                    options: Type.Optional(
                        Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 8 }),
                    ),
                    recommendation: Type.Optional(Type.String({ maxLength: 4_000 })),
                },
                { additionalProperties: false },
            ),
            // TODO(agent): Consider returning parent guidance in this tool result
            // instead of ending the child turn and sending a follow-up prompt.
            // This requires an asynchronous parent-answer channel and transcript support.
            async execute(_toolCallId, params) {
                if (tracker.pendingQuestion) {
                    return {
                        content: [
                            { type: "text", text: "A parent-guidance request is already pending." },
                        ],
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

        if (hasAgentAuthority(authority, "command")) {
            registerCommandPermissionHooks(pi, {
                parentContext,
                events,
                runId,
                runTitle,
                agentName,
                isolated,
                defaultBashTimeoutSeconds,
                additionalReadRoots: additionalPaths,
                safeBashCommands,
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
                bashRuleRemembered(pattern, permission) {
                    // Isolated children do not inherit parent rules, but an
                    // explicit end-user remember choice is an instruction to
                    // update the parent session for later parent calls.
                    if (!isolated || parentPermissionState === undefined) return;
                    parentPermissionState.bashRules[pattern] = permission;
                },
            });
        }

        pi.on("tool_call", (event, ctx) => {
            if (
                !hasAgentAuthority(authority, "command") &&
                isToolCallEventType<"bash", BashToolInput>("bash", event)
            ) {
                return guardSafeBashCommand(event.input.command, ctx.cwd, {
                    safeBash: hasAgentAuthority(authority, "inspect"),
                    onTrace,
                    additionalRoots: [...additionalPaths, ...getScratchpadRoots(ctx)],
                    sensitiveAdditionalRoots: getScratchpadRoots(ctx),
                    safeBashCommands,
                });
            }

            const filePath = readToolPath(event);
            if (filePath === undefined) return;
            const additionalRoots = readRoots(ctx);
            if (
                !isChildPathAllowed(filePath, ctx.cwd, {
                    additionalRoots,
                    sensitiveAdditionalRoots: getScratchpadRoots(ctx),
                })
            ) {
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

interface BashOutputPath {
    lexical: string;
    real: string;
    device: number;
    inode: number;
}

function isWithinDirectory(filePath: string, directory: string): boolean {
    const relative = path.relative(directory, filePath);
    return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
}

function bashOutputPath(value: unknown): BashOutputPath | undefined {
    if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;

    const lexical = path.resolve(value);
    const temporaryDirectory = path.resolve(os.tmpdir());
    if (!isWithinDirectory(lexical, temporaryDirectory)) return undefined;

    try {
        const stat = fs.lstatSync(lexical);
        if (!stat.isFile() || stat.isSymbolicLink()) return undefined;

        const real = fs.realpathSync(lexical);
        const realTemporaryDirectory = fs.realpathSync(temporaryDirectory);
        if (!isWithinDirectory(real, realTemporaryDirectory)) return undefined;

        return {
            lexical,
            real,
            device: stat.dev,
            inode: stat.ino,
        };
    } catch {
        return undefined;
    }
}

function rememberBashOutputPath(paths: Map<string, BashOutputPath>, details: unknown): void {
    if (!details || typeof details !== "object") return;
    const value = (details as { fullOutputPath?: unknown }).fullOutputPath;
    const outputPath = bashOutputPath(value);
    if (!outputPath) return;

    // Keep every validated path: this retains only small path/stat metadata,
    // not output contents or open handles, and truncated results are naturally
    // bounded by the amount of work a child run performs.
    paths.delete(outputPath.lexical);
    paths.set(outputPath.lexical, outputPath);
}

function activeBashOutputPaths(paths: Map<string, BashOutputPath>): string[] {
    const active: string[] = [];
    for (const [lexical, expected] of paths) {
        const current = bashOutputPath(lexical);
        if (
            !current ||
            current.real !== expected.real ||
            current.device !== expected.device ||
            current.inode !== expected.inode
        ) {
            paths.delete(lexical);
            continue;
        }
        active.push(lexical);
    }
    return active;
}

function getScratchpadRoots(ctx: ExtensionContext): readonly string[] {
    const scratchpadPath = getScratchpadPath(ctx.sessionManager);
    return scratchpadPath ? [scratchpadPath] : [];
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
