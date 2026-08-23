import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { askUser } from "../../tui/ask-user";

export default function registerAskUserTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user",
        label: "Ask User",
        description:
            "Ask the user a question with predefined options and get their feedback. "
            + "Use this when you need the user's input, preference, or decision. "
            + "The user can select one of the provided options or type a custom reply. "
            + "Proactively ask when you are uncertain about the user's intent, "
            + "when multiple reasonable approaches exist, or when user guidance "
            + "could improve the outcome. It is better to ask than to guess wrong.",
        promptSnippet:
            "Use ask_user to get feedback, preferences, or decisions from the user. "
            + "Prefer asking over assuming when the task is ambiguous or "
            + "multiple valid approaches exist.",
        promptGuidelines: [
            "When asking the user a question, indicate your recommendation in the option's `description` field with 'Recommended because …' or '(recommended)'",
            "In questions to the user, include an 'Unsure' or 'You decide' option when the user may not have a strong preference, so you can fall back to your own judgment instead of stalling",
        ],
        parameters: Type.Object({
            title: Type.String({ description: "A short title for the question" }),
            description: Type.Optional(Type.String({ description: "Additional context or details about the question (rendered as plain text)" })),
            options: Type.Array(
                Type.Object({
                    label: Type.String({ description: "The option text shown to the user" }),
                    description: Type.Optional(Type.String({ description: "Optional explanation of what this option means" })),
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
                const label = selected
                    ? theme.fg("accent", theme.bold(opt.label))
                    : opt.label;

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
                ctx,
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
}
