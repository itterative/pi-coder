import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
    type AgentParameters,
    parameters,
} from "../definitions/prompt";
import { updateResult } from "./outcomes";
import type { AgentRunDetails, AgentRunOutcome } from "../contracts/runs";
import { oneLinePreview } from "./widget";

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
            + "Scout and custom agents are read-only; the built-in worker can edit the selected checkout or isolated worktree and run bash only through explicit per-action user permission prompts. "
            + "Run work in the foreground or background; optionally provide a short human-readable title; list, status, collect, resume, or cancel retained runs. In persisted "
            + "parent sessions, paused and interrupted child context survives reload, restart, and switching away and back. The parent can inspect, apply, discard, or revise isolated workspace results without opening the TUI.",
        promptSnippet:
            "Use agent for optional delegated work; the parent may edit directly with its own built-in tools, while worker handles permission-gated child implementation.",
        promptGuidelines: [
            "Use agent with action=\"list\" to recover delegated run IDs and statuses after compaction or session restoration; use the returned IDs with agent actions status, resume, collect, or cancel",
            "Use agent with action=\"start\" when the result is needed immediately; use agent with action=\"spawn\" for independent work that can run concurrently; provide a short title when the run should be easy to identify later",
            "Do not poll spawned agent runs with agent action=\"status\" or wait by sleeping. If you have no other work to do, report your current progress to the user and end your turn; automatic follow-up mailbox context will notify you when they finish or need parent guidance",
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
            const content = result.content.find((part) => part.type === "text");
            const source = details.agentSource ? ` (${details.agentSource})` : "";
            let text = theme.fg(color, `${details.title} (${details.runId})${source}: ${details.status}`);
            if (!expanded && details.status === "waiting_for_permission") {
                text += theme.fg("warning", `\n${oneLinePreview(details.recentActivity[details.recentActivity.length - 1] ?? "Waiting for mutation permission")}`);
            } else if (!expanded && details.status === "interrupted") {
                text += theme.fg("warning", `\nResume with explicit guidance: ${details.runId}`);
            } else if (!expanded && details.status === "waiting_for_parent") {
                const question = oneLinePreview(details.question?.question ?? "");
                if (question) text += `\n${theme.fg("warning", `Question: ${question}`)}`;
                text += theme.fg("muted", `\nResume required: ${details.runId}`);
            } else if (
                !expanded
                && (details.status === "completed" || details.status === "starting" || details.status === "running")
                && content?.type === "text"
            ) {
                const preview = oneLinePreview(content.text);
                if (preview) text += `\n${theme.fg("muted", `${details.status === "completed" ? "Result" : "Status"}: ${preview}`)}`;
            } else if (expanded && content?.type === "text") {
                text += theme.fg("muted", `\nTitle: ${details.title}\nTask: ${details.task}`);
                text += `\n\n${content.text}`;
                if (details.recentActivity.length) {
                    text += theme.fg("muted", `\n\nActivity:\n- ${details.recentActivity.join("\n- ")}`);
                }
                if (details.discoveryDiagnostics?.length) {
                    text += theme.fg("muted", `\n\nDiscovery diagnostics:\n- ${details.discoveryDiagnostics.join("\n- ")}`);
                }
                const usage = details.usage;
                text += theme.fg(
                    "muted",
                    `\n\nUsage: ${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, $${usage.cost.total.toFixed(4)}`,
                );
            }
            return new Text(text, 0, 0);
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
                details: outcome.details,
                usage: outcome.usage,
            };
        },
    });
}
