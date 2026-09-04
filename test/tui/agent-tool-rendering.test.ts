import { describe, expect, it } from "vitest";

import { registerAgentTool } from "../../src/tools/agent/presentation/tool";
import { BACKGROUND_AGENT_WAIT_GUIDANCE } from "../../src/tools/agent/runs/manager";
import type { AgentParameters } from "../../src/tools/agent/definitions/prompt";
import type { AgentRunDetails, AgentRunOutcome } from "../../src/tools/agent/contracts/runs";
import { cloneUsage, ZERO_USAGE } from "../../src/tools/agent/runs/usage";
import { mockTheme, renderText, snapshotText } from "../helpers";
import { createPiStub, noRenderContext } from "../helpers/pi-stub";

interface AgentRenderCase {
    args: AgentParameters;
    outcome: AgentRunOutcome;
    isPartial?: boolean;
    /** Filename for this case's snapshot, needed where `args.action` alone would collide. */
    snapshotName?: string;
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
            ...(options.failedToolCalls !== undefined
                ? { failedToolCalls: options.failedToolCalls }
                : {}),
        },
        usage: cloneUsage(usage),
        ...((options.hasResponse ??
        ((args.action === "start" || args.action === "collect" || args.action === "continue") &&
            status === "completed"))
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
            {
                runId: "scout-1",
                title: "Project audit",
                agent: "scout",
                toolCounts: { read: 3, grep: 1 },
            },
        ),
    },
    {
        snapshotName: "start-background",
        args: {
            action: "start",
            agent: "worker",
            title: "Implement fix",
            task: workerTask,
            isolation: "worktree",
            background: true,
        },
        outcome: outcome(
            {
                action: "start",
                agent: "worker",
                title: "Implement fix",
                task: workerTask,
                isolation: "worktree",
                background: true,
            },
            workerTask,
            `Agent worker-1 started in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE} After a terminal notification, retrieve the full result with agent(action="collect", runId="worker-1").`,
            { runId: "worker-1", title: "Implement fix", background: true },
        ),
    },
    {
        snapshotName: "continue-waiting",
        args: {
            action: "continue",
            runId: "scout-1",
            guidance: "Continue with the remaining checks.",
        },
        outcome: outcome(
            {
                action: "continue",
                runId: "scout-1",
                guidance: "Continue with the remaining checks.",
            },
            projectTask,
            `Agent scout-1 resumed in the background. ${BACKGROUND_AGENT_WAIT_GUIDANCE}`,
            {
                runId: "scout-1",
                title: "Project audit",
                agent: "scout",
                background: true,
                status: "running",
            },
        ),
    },
    {
        snapshotName: "start-foreground-partial",
        isPartial: true,
        args: { action: "start", agent: "scout", title: "Project audit", task: projectTask },
        outcome: outcome(
            { action: "start", agent: "scout", title: "Project audit", task: projectTask },
            projectTask,
            "The child is still inspecting the project.",
            { runId: "scout-1", title: "Project audit", agent: "scout", status: "running" },
        ),
    },
    {
        snapshotName: "continue-foreground-partial",
        isPartial: true,
        args: {
            action: "continue",
            runId: "scout-1",
            guidance: "Continue with the remaining checks.",
        },
        outcome: outcome(
            {
                action: "continue",
                runId: "scout-1",
                guidance: "Continue with the remaining checks.",
            },
            projectTask,
            "The child is still inspecting the project.",
            { runId: "scout-1", title: "Project audit", agent: "scout", status: "running" },
        ),
    },
    {
        args: { action: "cancel", runId: "worker-1" },
        outcome: outcome(
            { action: "cancel", runId: "worker-1" },
            workerTask,
            "Agent run worker-1 canceled.",
            {
                runId: "worker-1",
                background: true,
                status: "canceled",
                toolCounts: { read: 2, bash: 1 },
            },
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
        snapshotName: "continue-revision",
        args: {
            action: "continue",
            runId: "worker-1",
            guidance: "Please revisit the test coverage.",
        },
        outcome: outcome(
            {
                action: "continue",
                runId: "worker-1",
                guidance: "Please revisit the test coverage.",
            },
            workerTask,
            "The revised implementation passes the focused tests.",
            {
                runId: "worker-1",
                title: "Implement fix revision",
                background: false,
                toolCounts: { read: 2, edit: 1, bash: 1 },
            },
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
            {
                runId: "scout-1",
                title: "Project audit",
                agent: "scout",
                background: true,
                status: "running",
                toolCounts: { read: 2, grep: 1 },
            },
        ),
    },
    {
        args: { action: "collect", runId: "worker-1" },
        outcome: outcome(
            { action: "collect", runId: "worker-1" },
            workerTask,
            "The implementation is complete.\n\nAll focused tests pass.",
            {
                runId: "worker-1",
                background: true,
                toolCounts: { read: 4, edit: 2, bash: 1 },
                failedToolCalls: 1,
            },
        ),
    },
];

function setupAgentTool(expectedOutcome: AgentRunOutcome) {
    const stub = createPiStub();
    registerAgentTool(stub.pi, async () => expectedOutcome);
    return stub.requireTool<AgentRunDetails>("agent");
}

function renderCallAndResult(
    tool: ReturnType<typeof setupAgentTool>,
    args: AgentParameters,
    result: Awaited<ReturnType<typeof tool.execute>>,
    expanded: boolean,
    isPartial = false,
): string {
    const callComponent = tool.definition.renderCall?.(args, mockTheme, noRenderContext);
    const resultComponent = tool.definition.renderResult?.(
        result,
        { expanded, isPartial },
        mockTheme,
        noRenderContext,
    );
    if (!callComponent || !resultComponent) {
        throw new Error("the agent tool must declare both call and result renderers");
    }
    const call = renderText(callComponent, 120);
    const renderedResult = renderText(resultComponent, 120);
    return snapshotText([call, renderedResult].filter((part) => part.length > 0).join("\n"));
}

describe("agent tool TUI rendering", () => {
    it("does not retain the Ctrl+Alt+B hint after a foreground start is backgrounded", () => {
        const tool = setupAgentTool(
            outcome(
                { action: "start", agent: "scout", task: projectTask },
                projectTask,
                "The child is still inspecting the project.",
                { runId: "scout-1", agent: "scout", status: "running", background: true },
            ),
        );
        const args: AgentParameters = { action: "start", agent: "scout", task: projectTask };
        const result = tool.execute("call-manual-background", args, undefined, undefined, {});

        return result.then((renderedResult) => {
            const call = tool.definition.renderCall?.(args, mockTheme, noRenderContext);
            const partial = tool.definition.renderResult?.(
                renderedResult,
                { expanded: false, isPartial: true },
                mockTheme,
                noRenderContext,
            );
            if (!call || !partial) {
                throw new Error("the agent tool must declare both call and result renderers");
            }
            expect(renderText(call, 120)).not.toContain("Ctrl+Alt+B");
            expect(renderText(partial, 120)).not.toContain("Ctrl+Alt+B");
        });
    });

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
        const simple = renderCallAndResult(tool, testCase.args, result, false, testCase.isPartial);
        const detailed = renderCallAndResult(tool, testCase.args, result, true, testCase.isPartial);
        const rendered = ["[simple]", simple, "", "[detailed]", detailed].join("\n");

        await expect(rendered).toMatchFileSnapshot(
            `__snapshots__/agent-tool-rendering.${testCase.snapshotName ?? testCase.args.action}.txt`,
        );
    });
});
