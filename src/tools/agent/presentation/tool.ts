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

export function registerAgentTool(pi: ExtensionAPI, executeAction: AgentToolExecutor): void {
    pi.registerTool({
        name: "agent",
        label: "Agent",
        description:
            "Delegate codebase work when useful to a built-in or custom agent. The parent agent may also use its own active built-in tools directly, including read, edit, write, and bash; delegation is not required for file changes. "
            + "Scout, reviewer, advisor, and custom agents are read-only. A non-isolated worker edits the parent's current checkout using inherited in-cwd file access and session-approved bash rules; outside-cwd file access and unmatched bash use shared parent-visible prompts. An isolated worker edits a separate worktree with independent mutation prompts, and its changes reach the parent only after apply. "
            + "Run work in the foreground or background; optionally provide a short human-readable title and bounded context sections; list, status, collect, resume, or cancel retained runs. In persisted "
            + "parent sessions, paused and interrupted child context survives reload, restart, and switching away and back. The parent can inspect, apply, discard, or revise isolated workspace results without opening the TUI.",
        promptSnippet:
            "Use agent for optional delegated work; the parent may edit directly with its own built-in tools. The worker handles implementation in either the current checkout or an isolated worktree, with the permission model described by the selected mode.",
        promptGuidelines: [
            "Use agent with action=\"list\" to recover delegated run IDs and statuses after compaction or session restoration; use the returned IDs with agent actions status, resume, collect, or cancel",
            "Use agent with action=\"start\" when the result is needed immediately; use agent with action=\"spawn\" for independent work that can run concurrently; provide a short title when the run should be easy to identify later",
            "Spawned-agent progress and results arrive asynchronously. Do not duplicate the same investigation in the parent unless you intentionally want overlapping work; if you have no other work to do, report your current progress to the user and end your turn. Do not poll with agent action=\"status\" or wait by sleeping; automatic follow-up mailbox context will notify you when they finish or need parent guidance",
            "After a terminal agent notification, use agent action=\"collect\" to retrieve the full result; mailbox updates never interrupt current work and never include the full result",
            "For isolated workspace results, use action=\"inspect\", \"apply\", \"discard\", or \"revise\" with the runId; these are parent-controlled dispositions and only apply modifies the parent checkout.",
            "Treat a waiting agent as paused, not completed; investigate or obtain guidance, then use agent action=\"resume\" or action=\"cancel\" as appropriate",
            "Durable interrupted agent runs never replay or resume automatically; wait for explicit user direction before using agent action=\"resume\" or action=\"cancel\", and account for uncertain tool outcomes",
            "Remember that background agents cannot open direct user dialogs; use agent action=\"resume\" after providing parent guidance instead",
            "Use the returned agent run ID exactly; agent runs are cwd-confined and durable only within the exact persisted parent session",
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
                    + theme.fg("accent", args.title ?? args.agent)
                    + theme.fg("muted", ` (${args.agent}) — ${args.task}`),
                    0,
                    0,
                );
            }
            return new Text(
                theme.fg("toolTitle", theme.bold(`agent ${args.action} `))
                + theme.fg("accent", args.runId),
                0,
                0,
            );
        },
        renderResult(result, { expanded }, theme) {
            const details = result.details as AgentRunDetails;
            const color = details.status === "completed"
                ? "success"
                : details.status === "waiting_for_parent" || details.status === "waiting_for_permission" || details.status === "interrupted"
                    ? "warning"
                    : details.status === "starting" || details.status === "running"
                        ? "accent"
                        : details.status === "canceled"
                            ? "muted"
                            : "error";
            const response = details.response
                ?? result.content.find((part) => part.type === "text")?.text
                ?? "";
            const action = (details as AgentRunDetails & { action?: string }).action;
            const header = `${action ? `agent ${action} ` : ""}${details.title} (${details.agent}) — ${details.status}`;
            const toolCount = Object.values(details.toolCounts ?? {}).reduce(
                (total, count) => total + count,
                0,
            );
            const toolSummary = formatToolCallSummary(toolCount, details.failedToolCalls ?? 0);
            const body = expanded
                ? `${quoteText(details.task)}\n\n${toolSummary}${response ? `\n\n${response}` : ""}`
                : toolSummary;
            const container = new Container();
            container.addChild(new Text(theme.fg(color, header), 0, 0));
            container.addChild(new Markdown(body, 0, 0, markdownTheme(theme)));
            return container;
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const outcome = await executeAction(
                params,
                signal,
                (details) => onUpdate?.(updateResult(details)),
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
