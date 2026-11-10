import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { contributeToolGuide } from "../../common/prompt-section";
import { askUser } from "../../tui/ask-user";
import { askUserGuidePrompt } from "./prompt";

export default function registerAskUserTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user",
        label: "Ask User",
        description:
            "Ask the user a question with predefined options and get their feedback. `title` and `options` are " +
            "required; an option may carry a `description` explaining what it means.",
        promptSnippet: "Ask the user for a decision, preference, or missing detail.",
        parameters: Type.Object({
            title: Type.String({ description: "A short title for the question" }),
            description: Type.Optional(
                Type.String({
                    description:
                        "Additional context or details about the question (rendered as plain text)",
                }),
            ),
            options: Type.Array(
                Type.Object({
                    label: Type.String({ description: "The option text shown to the user" }),
                    description: Type.Optional(
                        Type.String({
                            description: "Optional explanation of what this option means",
                        }),
                    ),
                }),
                { description: "Predefined options for the user to choose from" },
            ),
        }),
        renderCall(args, theme, _context) {
            let text = theme.fg("toolTitle", theme.bold("ask_user "));
            text += theme.fg("accent", args.title ?? "...");

            if (args.options?.length) {
                text += theme.fg("muted", ` (${args.options.length} options)`);
            }

            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, context) {
            const content = result.content[0];
            if (content?.type !== "text") {
                return new Text(theme.fg("success", "Done"), 0, 0);
            }

            if (content.text.includes("cancelled")) {
                return new Text(theme.fg("warning", "Cancelled"), 0, 0);
            }

            let text = content.text;

            if (!expanded) {
                return new Text(text, 0, 0);
            }

            const args = context.args;
            if (!args.options?.length) {
                return new Text(text, 0, 0);
            }

            const details = result.details as { answer?: string; optionIndex?: number };

            for (let i = 0; i < args.options.length; i++) {
                const opt = args.options[i]!;
                const selected = i === details.optionIndex;
                const marker = selected ? "●" : "○";
                const label = selected ? theme.fg("accent", theme.bold(opt.label)) : opt.label;

                let line = `\n  ${marker} ${label}`;
                if (opt.description) {
                    line += theme.fg("muted", ` — ${opt.description}`);
                }
                text += line;
            }

            return new Text(text, 0, 0);
        },

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const result = await askUser(
                {
                    title: params.title,
                    description: params.description,
                    options: params.options,
                },
                { ...ctx, events: pi.events },
                signal,
            );

            if (result === undefined) {
                return {
                    content: [{ type: "text", text: "User cancelled the question." }],
                    details: {},
                };
            }

            const responseText = result.isCustom
                ? `User replied with custom message: ${result.answer}`
                : `User selected: ${result.answer}`;

            return {
                content: [{ type: "text", text: responseText }],
                details: {
                    answer: result.answer,
                    isCustom: result.isCustom,
                    optionIndex: result.optionIndex,
                },
            };
        },
    });

    pi.on("before_agent_start", (event) => {
        contributeToolGuide(event.systemPromptOptions, "ask_user", askUserGuidePrompt());
    });
}
