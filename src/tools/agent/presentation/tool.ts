import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

import { type AgentParameters, parameters } from "../definitions/prompt";
import { updateResult } from "./outcomes";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import { formatToolCallSummary, quoteText } from "./transcript";
import { markdownTheme } from "../../../tui/markdown-theme";

export type AgentToolExecutor = (
    params: AgentParameters,
    signal: AbortSignal | undefined,
    progress: (details: AgentRunDetails) => void,
    ctx: ExtensionContext,
) => Promise<AgentRunOutcome>;

type AgentToolDetails = AgentRunDetails & { action?: AgentParameters["action"] };
type AgentToolResult = {
    content: Array<{ type: string; text?: string }>;
    details: AgentToolDetails;
};
function resultResponse(result: AgentToolResult): string {
    return (
        result.details.response ?? result.content.find((part) => part.type === "text")?.text ?? ""
    );
}

function toolSummary(details: AgentToolDetails): string {
    const toolCount = Object.values(details.toolCounts ?? {}).reduce(
        (total, count) => total + count,
        0,
    );
    return formatToolCallSummary(toolCount, details.failedToolCalls ?? 0);
}

function markdownResult(
    body: string,
    expanded: boolean,
    theme: Parameters<typeof markdownTheme>[0],
): Container {
    const container = new Container();
    if (!expanded) {
        return container;
    }

    container.addChild(new Markdown(body, 0, 1, markdownTheme(theme)));
    return container;
}

function taskResult(
    result: AgentToolResult,
    expanded: boolean,
    theme: Parameters<typeof markdownTheme>[0],
): Container {
    const sections = [
        result.details.task ? quoteText(result.details.task) : undefined,
        toolSummary(result.details),
        resultResponse(result) || undefined,
    ].filter((section): section is string => section !== undefined);
    return markdownResult(sections.join("\n\n"), expanded, theme);
}

function responseResult(
    result: AgentToolResult,
    expanded: boolean,
    theme: Parameters<typeof markdownTheme>[0],
): Container {
    return markdownResult(resultResponse(result), expanded, theme);
}

const BACKGROUND_SHORTCUT_HINT = "(Ctrl+Alt+B to move to background)";

function continueResult(
    result: AgentToolResult,
    expanded: boolean,
    isPartial: boolean,
    theme: Parameters<typeof markdownTheme>[0],
): Container {
    const body = taskResult(result, expanded, theme);
    const showBackgroundHint =
        isPartial && !result.details.background && result.details.status === "running";
    if (!showBackgroundHint) {
        return body;
    }

    const container = new Container();
    container.addChild(new Text(theme.fg("muted", BACKGROUND_SHORTCUT_HINT), 0, 0));
    container.addChild(body);
    return container;
}

function startResult(
    result: AgentToolResult,
    expanded: boolean,
    isPartial: boolean,
    theme: Parameters<typeof markdownTheme>[0],
): Container {
    const body = result.details.background
        ? responseResult(result, expanded, theme)
        : taskResult(result, expanded, theme);
    const showBackgroundHint =
        isPartial && !result.details.background && result.details.status === "running";
    if (!showBackgroundHint) {
        return body;
    }

    const container = new Container();
    container.addChild(new Text(theme.fg("muted", BACKGROUND_SHORTCUT_HINT), 0, 0));
    container.addChild(body);
    return container;
}

function renderAgentResult(
    result: AgentToolResult,
    expanded: boolean,
    isPartial: boolean,
    theme: Parameters<typeof markdownTheme>[0],
): Container {
    switch (result.details.action) {
        case "list":
            return responseResult(result, expanded, theme);
        case "start":
            return startResult(result, expanded, isPartial, theme);
        case "continue":
            return continueResult(result, expanded, isPartial, theme);
        case "cancel":
            return responseResult(result, expanded, theme);
        case "inspect":
            return responseResult(result, expanded, theme);
        case "apply":
            return responseResult(result, expanded, theme);
        case "discard":
            return responseResult(result, expanded, theme);
        case "status":
            return responseResult(result, expanded, theme);
        case "collect":
            return taskResult(result, expanded, theme);
        default:
            return taskResult(result, expanded, theme);
    }
}

export function registerAgentTool(pi: ExtensionAPI, executeAction: AgentToolExecutor): void {
    pi.registerTool({
        name: "agent",
        label: "Agent",
        description:
            "Delegate codebase work to a built-in or custom agent, in the current checkout or an isolated " +
            "worktree. Every task is a complete assignment for a child that cannot see this conversation.",
        promptSnippet: "Delegate codebase work to a built-in or custom agent.",
        parameters,
        executionMode: "sequential",
        renderCall(args, theme) {
            if (args.action === "list") {
                return new Text(theme.fg("toolTitle", theme.bold("agent list")), 0, 0);
            }
            if (args.action === "start") {
                return new Text(
                    theme.fg("toolTitle", theme.bold(`agent ${args.action} `)) +
                        theme.fg("muted", `(${args.agent ?? "unknown"})`) +
                        " — " +
                        theme.fg("accent", args.title ?? args.agent ?? args.action),
                    0,
                    0,
                );
            }
            return new Text(
                theme.fg("toolTitle", theme.bold(`agent ${args.action} `)) +
                    theme.fg("accent", args.runId ?? ""),
                0,
                0,
            );
        },
        renderResult(result, { expanded, isPartial }, theme) {
            return renderAgentResult(result as AgentToolResult, expanded, isPartial, theme);
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const outcome = await executeAction(
                params,
                signal,
                (details) =>
                    onUpdate?.(
                        updateResult({ ...details, action: params.action } as AgentRunDetails),
                    ),
                ctx,
            );
            return {
                content: [{ type: "text", text: outcome.content }],
                details: { ...outcome.details, action: params.action },
                usage: outcome.usage,
            };
        },
    });
}
