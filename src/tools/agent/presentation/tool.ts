import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

import {
    type AgentParameters,
    parameters,
} from "../definitions/prompt";
import { updateResult } from "./outcomes";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import {
    formatToolCallSummary,
    quoteText,
} from "./transcript";
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
    return result.details.response
        ?? result.content.find((part) => part.type === "text")?.text
        ?? "";
}

function toolSummary(details: AgentToolDetails): string {
    const toolCount = Object.values(details.toolCounts ?? {}).reduce(
        (total, count) => total + count,
        0,
    );
    return formatToolCallSummary(toolCount, details.failedToolCalls ?? 0);
}

function markdownResult(body: string, expanded: boolean, theme: Parameters<typeof markdownTheme>[0]): Container {
    const container = new Container();
    if (!expanded) {
        return container;
    }

    container.addChild(new Markdown(body, 0, 1, markdownTheme(theme)));
    return container;
}

function taskResult(result: AgentToolResult, expanded: boolean, theme: Parameters<typeof markdownTheme>[0]): Container {
    const sections = [
        result.details.task ? quoteText(result.details.task) : undefined,
        toolSummary(result.details),
        resultResponse(result) || undefined,
    ].filter((section): section is string => section !== undefined);
    return markdownResult(sections.join("\n\n"), expanded, theme);
}

function responseResult(result: AgentToolResult, expanded: boolean, theme: Parameters<typeof markdownTheme>[0]): Container {
    return markdownResult(resultResponse(result), expanded, theme);
}

function renderAgentResult(result: AgentToolResult, expanded: boolean, theme: Parameters<typeof markdownTheme>[0]): Container {
    switch (result.details.action) {
        case "list": return responseResult(result, expanded, theme);
        case "start": return taskResult(result, expanded, theme);
        case "spawn": return responseResult(result, expanded, theme);
        case "resume": return responseResult(result, expanded, theme);
        case "cancel": return responseResult(result, expanded, theme);
        case "inspect": return responseResult(result, expanded, theme);
        case "apply": return responseResult(result, expanded, theme);
        case "discard": return responseResult(result, expanded, theme);
        case "revise": return taskResult(result, expanded, theme);
        case "status": return responseResult(result, expanded, theme);
        case "collect": return taskResult(result, expanded, theme);
        default: return taskResult(result, expanded, theme);
    }
}

export function registerAgentTool(pi: ExtensionAPI, executeAction: AgentToolExecutor): void {
    pi.registerTool({
        name: "agent",
        label: "Agent",
        description:
            "Delegate codebase work when useful to a built-in or custom agent. The parent agent may also use its own active built-in tools directly, including read, edit, write, and bash; delegation is not required for file changes. "
            + "Scout and advisor are read-only. Reviewer and custom agents with command-runner are command-capable: they may execute Bash through the permission flow but have no direct edit/write tools. The built-in worker is the only direct edit-capable child. A non-isolated worker edits the parent's current checkout using inherited in-cwd file access and session-approved bash rules; outside-cwd file access and unmatched bash use shared parent-visible prompts. An isolated worker edits a separate worktree with independent mutation prompts, and its changes reach the parent only after apply. "
            + "Run work in the foreground or background; provide a detailed, self-contained task that may be multiline, plus an optional short human-readable title and bounded supplemental context sections; list, status, collect, resume, or cancel retained runs. In persisted "
            + "parent sessions, paused and interrupted child context survives reload, restart, and switching away and back. The parent can inspect, apply, or discard isolated workspace results; revise an isolated worker only while its prepared task lease is held, or revise a collected terminal non-mutating run such as reviewer without a workspace, without opening the TUI. "
            + "Parameters depend on action: start and spawn take agent, task, and optional title, isolation, and context; resume takes runId and optional guidance; cancel, inspect, apply, discard, status, and collect take runId; revise takes runId and guidance; list takes no parameters.",
        promptSnippet:
            "Use agent for optional delegated work; the parent may edit directly with its own built-in tools. The worker handles implementation in either the current checkout or an isolated worktree, with the permission model described by the selected mode.",
        promptGuidelines: [
            "Use agent with action=\"list\" to recover delegated run IDs and statuses after compaction or session restoration; use the returned IDs with agent actions status, resume, collect, revise, or cancel",
            "Use agent with action=\"start\" when the result is needed immediately; use agent with action=\"spawn\" for independent work that can run concurrently; provide a short title when the run should be easy to identify later",
            "Make every delegation task a self-contained, detailed brief for a child that cannot see the parent's conversation or infer unstated context. Include the objective, relevant files/symbols and current state, scope and non-goals, constraints, expected report or changes, validation steps, and any other details the child needs; do not optimize the task for brevity.",
            "Delegation tasks may and should be multiline. A title is only a short display label and does not constrain the task's length or detail. Put required instructions and facts in task; use context.sections only for supplemental parent, repository, or workspace context when the selected agent supports those sections.",
            "Spawned-agent progress and results arrive asynchronously. Do not duplicate the same investigation in the parent unless you intentionally want overlapping work; if you have no other work to do, report your current progress to the user and end your turn. Do not poll with agent action=\"status\" or wait by sleeping; automatic follow-up mailbox context will notify you when they finish or need parent guidance",
            "After a terminal agent notification, use agent action=\"collect\" to retrieve the full result; mailbox updates never interrupt current work and never include the full result",
            "For an isolated worker result, use action=\"inspect\", \"apply\", \"discard\", or \"revise\" with the runId; revise is available only while its prepared task lease is held. These are parent-controlled dispositions and only apply modifies the parent checkout.",
            "After collecting a terminal read-only or command-capable run, such as reviewer, use action=\"revise\" with its runId and guidance to continue the existing child session without an isolated workspace.",
            "Treat a waiting agent as paused, not completed; investigate or obtain guidance, then use agent action=\"resume\" or action=\"cancel\" as appropriate",
            "Durable interrupted agent runs never replay or resume automatically; wait for explicit user direction before using agent action=\"resume\" or action=\"cancel\", and account for uncertain tool outcomes",
            "Remember that background agents cannot open direct user dialogs; use agent action=\"resume\" after providing parent guidance instead",
            "Use the returned agent run ID exactly; agent runs are cwd-confined, and durable revision resolution is limited to the exact persisted parent session and active parent-tree branch.",
        ],
        parameters,
        executionMode: "sequential",
        renderCall(args, theme) {
            if (args.action === "list") {
                return new Text(theme.fg("toolTitle", theme.bold("agent list")), 0, 0);
            }
            if (args.action === "start" || args.action === "spawn") {
                return new Text(
                    theme.fg("toolTitle", theme.bold(`agent ${args.action} `))
                    + theme.fg("muted", `(${args.agent ?? "unknown"})`)
                    + " — "
                    + theme.fg("accent", args.title ?? args.agent ?? args.action)
                    + (args.action === "start"
                        ? ` ${theme.fg("muted", "(Ctrl+B to move to background)")}`
                        : ""),
                    0,
                    0,
                );
            }
            return new Text(
                theme.fg("toolTitle", theme.bold(`agent ${args.action} `))
                + theme.fg("accent", args.runId ?? ""),
                0,
                0,
            );
        },
        renderResult(result, { expanded }, theme) {
            return renderAgentResult(result as AgentToolResult, expanded, theme);
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const outcome = await executeAction(
                params,
                signal,
                (details) => onUpdate?.(updateResult({ ...details, action: params.action } as AgentRunDetails)),
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
