import path from "node:path";
import {
    isToolCallEventType,
    type ExtensionAPI,
    type ExtensionContext,
    type FindToolInput,
    type GrepToolInput,
    type LsToolInput,
    type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SandboxConfigCwdConfinement } from "../../../common/config";
import { getPathConfinementPermission } from "../../../modules/sandbox/heuristics";
import { askUser } from "../../../tui/ask-user";
import { registerWorkerMutationHooks } from "./worker-permissions";
import type { ChildAgentFactoryContext } from "../runtime";
import type { ChildProgressTracker as ProgressTracker } from "./progress";

const MAX_RECENT_ACTIVITY = 8;

const CHILD_CONFINEMENT: SandboxConfigCwdConfinement = {
    enabled: true,
    permission: "allow",
    resolveSymlinks: true,
};

export function childProtocolPrompt(background: boolean, mutating: boolean): string {
    const interaction = background
        ? "Direct end-user dialogs are unavailable while you run in the background. Use ask_parent when guidance is materially necessary; make reasonable progress first, include evidence and a recommendation, and call it alone in its tool batch."
        : "Use ask_user when you need a preference, clarification, or decision directly from the end user, and call it alone in its tool batch so later work can incorporate the answer. The answer returns in the same turn, so continue your work afterward. Use ask_parent instead when the parent can answer, investigate, or decide; make reasonable progress first, include evidence and a recommendation, and call ask_parent alone in its tool batch. Do not ask questions only in prose when either interaction tool applies.";
    const capability = mutating
        ? "You are a mutation-capable worker operating in the parent's current checkout. Every edit, write, and bash call opens an explicit parent-visible permission gate. Call mutation tools one at a time, and remember that parent activity may concurrently affect the checkout."
        : "You are a read-only subagent working for a parent coding agent. You cannot run commands or modify files.";
    return `${capability}\n\n${interaction}\n\nWhen the task is complete, provide a self-contained final report to the parent. Mutation-capable workers must list changed files and validation performed.`;

}

export function isChildPathAllowed(filePath: string | undefined, cwd: string): boolean {
    const effectivePath = filePath?.trim() || cwd;
    return getPathConfinementPermission(effectivePath, cwd, CHILD_CONFINEMENT) !== undefined;
}

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
    }, parentContext, signal);

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
    agentName: string,
    background: boolean,
    mutating: boolean,
    runId: string,
    runTitle: string,
    onProgress: ChildAgentFactoryContext["onProgress"],
    onTrace?: ChildAgentFactoryContext["onTrace"],
) {
    return (pi: ExtensionAPI): void => {
        if (!background) pi.registerTool({
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
                    const result = await askChildUser(params, parentContext, agentName, signal);
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
                "Pause this scout and request guidance from the parent agent. "
                + "Use only after making reasonable progress and include evidence and a recommendation.",
            promptSnippet: "Use ask_parent to pause and request guidance from the parent agent.",
            promptGuidelines: [
                "Call ask_parent alone in a tool batch and only when parent guidance materially improves the result",
                "Include relevant evidence, partial findings, and your recommended next step",
                background
                    ? "Direct end-user dialogs are unavailable in background runs"
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

        if (mutating) {
            registerWorkerMutationHooks(pi, {
                parentContext,
                runId,
                runTitle,
                agentName,
                permissionPending(pending, activity) {
                    tracker.progress.permissionPending = pending;
                    tracker.progress.recentActivity.push(activity);
                    tracker.progress.recentActivity = tracker.progress.recentActivity.slice(-MAX_RECENT_ACTIVITY);
                    onTrace?.("mutation.permission", { pending, activity });
                    onProgress({
                        output: tracker.progress.output,
                        recentActivity: [...tracker.progress.recentActivity],
                        permissionPending: pending,
                    });
                },
                fileChanged(filePath) {
                    tracker.changedFiles.add(filePath);
                    onTrace?.("mutation.file_changed", { path: filePath });
                },
                bashApproved() {
                    tracker.bashApproved = true;
                    onTrace?.("mutation.bash_approved");
                },
            });
        }

        pi.on("tool_call", (event, ctx) => {
            let filePath: string | undefined;
            if (isToolCallEventType<"read", ReadToolInput>("read", event)) {
                filePath = event.input.path;
            } else if (isToolCallEventType<"grep", GrepToolInput>("grep", event)) {
                filePath = event.input.path;
            } else if (isToolCallEventType<"find", FindToolInput>("find", event)) {
                filePath = event.input.path;
            } else if (isToolCallEventType<"ls", LsToolInput>("ls", event)) {
                filePath = event.input.path;
            } else {
                return;
            }

            if (isChildPathAllowed(filePath, ctx.cwd)) {
                tracker.readFiles.add(relativeReadPath(filePath, ctx.cwd));
                return;
            }
            return {
                block: true,
                reason: "Read-only scout access blocked: path is outside the allowed working directory or is sensitive.",
            };
        });
    };
}

function relativeReadPath(filePath: string | undefined, cwd: string): string {
    const resolved = path.resolve(cwd, filePath?.trim() || ".");
    return path.relative(cwd, resolved) || ".";
}

