import { describe, expect, it } from "vitest";

import { registerAgentTool } from "../../src/tools/agent/presentation/tool";
import { BACKGROUND_AGENT_WAIT_GUIDANCE } from "../../src/tools/agent/runs/manager";
import type { AgentParameters } from "../../src/tools/agent/definitions/prompt";
import type { AgentRunOutcome } from "../../src/tools/agent/contracts/runs";
import { cloneUsage, ZERO_USAGE } from "../../src/tools/agent/runs/usage";
import { mockTheme, renderText, snapshotText } from "../helpers";

interface AgentToolResult {
    content: Array<{ type: string; text?: string }>;
    details: Record<string, unknown>;
}

interface AgentToolDefinition {
    renderCall: (args: AgentParameters, theme: typeof mockTheme) => unknown;
    renderResult: (result: AgentToolResult, options: { expanded: boolean }, theme: typeof mockTheme) => unknown;
    execute: (
        toolCallId: string,
        args: AgentParameters,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
    ) => Promise<AgentToolResult>;
}

interface AgentRenderCase {
    args: AgentParameters;
    outcome: AgentRunOutcome;
}

const projectTask = "Inspect the project structure.";
const workerTask = "Implement the requested fix.";
function outcome(
    args: AgentParameters,
    task: string,
    content: string,
    options: {
        runId?: string;
        title?: string;
        agent?: string;
        status?: AgentRunOutcome["details"]["status"];
        background?: boolean;
        toolCounts?: Record<string, number>;
        failedToolCalls?: number;
        hasResponse?: boolean;
    } = {},
): AgentRunOutcome {
    const usage = cloneUsage(ZERO_USAGE);
    const status = options.status ?? "completed";
    return {
        content,
        details: {
            runId: options.runId ?? (args.action === "list" ? "list" : "worker-1"),
            title: options.title ?? "Implement fix",
            agent: options.agent ?? "worker",
            status,
            background: options.background ?? false,
            task,
            recentActivity: [],
            usage,
            startedAt: 1,
            updatedAt: 2,
            ...(options.toolCounts ? { toolCounts: options.toolCounts } : {}),
            ...(options.failedToolCalls !== undefined ? { failedToolCalls: options.failedToolCalls } : {}),
        },
        usage: cloneUsage(usage),
        ...((options.hasResponse
            ?? ((args.action === "start" || args.action === "collect" || args.action === "revise")
                && status === "completed"))
            ? { hasResponse: true as const }
            : {}),
        isError: false,
    };
}

const actionCases: AgentRenderCase[] = [
    {
        args: { action: "list" },
        outcome: outcome(
            { action: "list" },
            "List delegated agent runs",
            [
                '- "scout-1" · "Project audit" · scout · running',
                `  Task: "${projectTask}"`,
                `  Next: ${BACKGROUND_AGENT_WAIT_GUIDANCE}`,
                '- "worker-1" · "Implement fix" · worker · completed',
                `  Task: "${workerTask}"`,
                '  Next: collect with runId="worker-1"',
            ].join("\n"),
            { runId: "list", title: "Delegated agent runs", agent: "runtime" },
        ),
    },
    {
        args: { action: "start", agent: "scout", title: "Project audit", task: projectTask },
        outcome: outcome(
            { action: "start", agent: "scout", title: "Project audit", task: projectTask },
            projectTask,
            "Finished inspecting the project. The main entry point is src/index.ts.",
            { runId: "scout-1", title: "Project audit", agent: "scout", toolCounts: { read: 3, grep: 1 } },
        ),
    },
    {
        snapshotName: "start-background",
        args: { action: "start", agent: "worker", title: "Implement fix", task: workerTask, isolation: "worktree", background: true },
        outcome: outcome(
            { action: "start", agent: "worker", title: "Implement fix", task: workerTask, isolation: "worktree", background: true },
            workerTask,
            `Agent worker-1 started in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE} After a terminal notification, retrieve the full result with agent(action="collect", runId="worker-1").`,
            { runId: "worker-1", title: "Implement fix", background: true },
        ),
    },
    {
        args: { action: "resume", runId: "scout-1", guidance: "Continue with the remaining checks." },
        outcome: outcome(
            { action: "resume", runId: "scout-1", guidance: "Continue with the remaining checks." },
            projectTask,
            `Agent scout-1 resumed in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE}`,
            { runId: "scout-1", title: "Project audit", agent: "scout", background: true, status: "running" },
        ),
    },
    {
        args: { action: "cancel", runId: "worker-1" },
        outcome: outcome(
            { action: "cancel", runId: "worker-1" },
            workerTask,
            "Agent run worker-1 canceled.",
            { runId: "worker-1", background: true, status: "canceled", toolCounts: { read: 2, bash: 1 } },
        ),
    },
    {
        args: { action: "inspect", runId: "worker-1" },
        outcome: outcome(
            { action: "inspect", runId: "worker-1" },
            workerTask,
            [
                "Workspace: quiet-lantern-7k3",
                "Base revision: abc123",
                "Worker revision: def456",
                "Commit range: abc123..def456",
                "Commits: worker-fix",
                "Durable ref: refs/pi-coder/results/worker-1",
                "",
                "Changed files:",
                " src/index.ts | 2 +-",
            ].join("\n"),
            { runId: "worker-1", background: true },
        ),
    },
    {
        args: { action: "apply", runId: "worker-1" },
        outcome: outcome(
            { action: "apply", runId: "worker-1" },
            workerTask,
            "Applied workspace result result-1 to the parent checkout.",
            { runId: "worker-1", background: true },
        ),
    },
    {
        args: { action: "discard", runId: "worker-1" },
        outcome: outcome(
            { action: "discard", runId: "worker-1" },
            workerTask,
            "Discarded workspace result result-1; the isolated workspace is reusable.",
            { runId: "worker-1", background: true },
        ),
    },
    {
        args: { action: "revise", runId: "worker-1", guidance: "Please revisit the test coverage." },
        outcome: outcome(
            { action: "revise", runId: "worker-1", guidance: "Please revisit the test coverage." },
            workerTask,
            "The revised implementation passes the focused tests.",
            { runId: "worker-1", title: "Implement fix revision", background: false, toolCounts: { read: 2, edit: 1, bash: 1 } },
        ),
    },
    {
        args: { action: "status", runId: "scout-1" },
        outcome: outcome(
            { action: "status", runId: "scout-1" },
            projectTask,
            [
                "Agent scout-1 is running in the background.",
                "",
                "Partial output:",
                "I found the main entry points.",
                "",
                "Recent activity:",
                "- read src/index.ts",
                "- grep AgentSession src/tui",
                "",
                BACKGROUND_AGENT_WAIT_GUIDANCE,
            ].join("\n"),
            { runId: "scout-1", title: "Project audit", agent: "scout", background: true, status: "running", toolCounts: { read: 2, grep: 1 } },
        ),
    },
    {
        args: { action: "collect", runId: "worker-1" },
        outcome: outcome(
            { action: "collect", runId: "worker-1" },
            workerTask,
            "The implementation is complete.\n\nAll focused tests pass.",
            { runId: "worker-1", background: true, toolCounts: { read: 4, edit: 2, bash: 1 }, failedToolCalls: 1 },
        ),
    },
];

function setupAgentTool(expectedOutcome: AgentRunOutcome): AgentToolDefinition {
    let definition: AgentToolDefinition | undefined;
    registerAgentTool({
        registerTool(value: AgentToolDefinition) {
            definition = value;
        },
    } as any, async () => expectedOutcome);
    if (!definition) {
        throw new Error("Agent tool was not registered.");
    }
    return definition;
}

function renderCallAndResult(
    tool: AgentToolDefinition,
    args: AgentParameters,
    result: AgentToolResult,
    expanded: boolean,
): string {
    const call = renderText(tool.renderCall(args, mockTheme) as any, 120);
    const renderedResult = renderText(tool.renderResult(result, { expanded }, mockTheme) as any, 120);
    return snapshotText([call, renderedResult].filter((part) => part.length > 0).join("\n"));
}

describe("agent tool TUI rendering", () => {
    it.each(actionCases)("renders $args.action", async (testCase) => {
        const tool = setupAgentTool(testCase.outcome);
        const result = await tool.execute(
            `call-${testCase.args.action}`,
            testCase.args,
            undefined,
            undefined,
            {},
        );

        expect(result.details.action).toBe(testCase.args.action);
        const simple = renderCallAndResult(tool, testCase.args, result, false);
        const detailed = renderCallAndResult(tool, testCase.args, result, true);
        const rendered = ["[simple]", simple, "", "[detailed]", detailed].join("\n");

        await expect(rendered).toMatchFileSnapshot(
            `__snapshots__/agent-tool-rendering.${testCase.snapshotName ?? testCase.args.action}.txt`,
        );
    });
});
