import { Type } from "typebox";

import { askUser } from "../../../../tui/ask-user";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildGate } from "./gate";

export interface ChildUserQuestion {
    title: string;
    description?: string;
    options: Array<{ label: string; description?: string }>;
}

interface ChildUserAnswerDetails {
    unavailable?: boolean;
    canceled?: boolean;
    answer?: string;
    isCustom?: boolean;
    optionIndex?: number;
}

interface ChildUserAnswerResult {
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
 * The child's two ways of asking a question.
 *
 * `ask_user` is installed only when the grant says the parent can host the prompt, while `ask_parent`
 * is always installed: pausing for the parent needs no UI, it ends the child's turn, and the answer
 * arrives as a follow-up prompt. Both live in one gate because their guidance is co-dependent -
 * `ask_parent`'s guidelines mention `ask_user` only when it exists.
 */
export const INTERACTION_GATE: ChildGate = {
    id: "interaction",
    install(runtime) {
        const { options, parentContext, tracker } = runtime;
        const { agentName, canAskUser, events, onTrace } = options;

        if (canAskUser)
            runtime.pi.registerTool({
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

        runtime.pi.registerTool({
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
    },
};
