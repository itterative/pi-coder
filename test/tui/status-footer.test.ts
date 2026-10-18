import { sep } from "node:path";

import type { Usage } from "@earendil-works/pi-ai";
import {
    createEventBus,
    type ExtensionContext,
    type ExtensionUIContext,
    type ReadonlyFooterDataProvider,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockTheme, renderText, snapshotText, stubTui } from "../helpers";
import { countedUsage, partialRun } from "../helpers/agent-doubles";
import {
    createPiStub,
    stubContext,
    stubModel,
    stubSessionManager,
    stubUi,
} from "../helpers/pi-stub";
import type { TodoList } from "../../src/modules/todolist/parser";
import { emitTodoStatus } from "../../src/modules/todolist/events";
import decisionConfig from "../../src/modules/decision/config";
import { emitDecisionStatus } from "../../src/modules/decision/events";
import type { AgentRunSummary } from "../../src/tools/agent/contracts/runs";
import { PiCoderFooter, registerStatusFooter } from "../../src/tui/status";
import {
    UsageTotalsCache,
    formatCwd,
    formatTokens,
    layoutFooterLine,
    type FooterLineSegment,
    type FooterSessionSource,
} from "../../src/tui/status/footer-info";
import { emitAgentStatus } from "../../src/tools/agent/observability/events";

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const todo: TodoList = {
    path: "/tmp/TODO.md",
    version: 1,
    items: [
        { id: "inspect", title: "Inspect the implementation", status: "completed" },
        {
            id: "implement",
            title: "Implement the feature with careful validation",
            status: "in_progress",
        },
        { id: "verify", title: "Verify the result", status: "pending" },
        { id: "release", title: "Release the change", status: "blocked" },
    ],
    body: "",
};

const ENTRY_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function usageWithCost(
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    cost: number,
): Usage {
    const usage = countedUsage(input, output, cacheRead, cacheWrite);
    usage.cost.total = cost;
    return usage;
}

function usageEntry(id: string, usage: Usage): SessionEntry {
    return {
        type: "usage",
        id,
        parentId: null,
        timestamp: ENTRY_TIMESTAMP,
        kind: "test",
        provider: "anthropic",
        model: "stub-model",
        usage,
    };
}

function assistantEntry(id: string, usage: Usage): SessionEntry {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: ENTRY_TIMESTAMP,
        message: {
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "stub-model",
            usage,
            stopReason: "stop",
            timestamp: 0,
        },
    };
}

function footerSession(entries: SessionEntry[] = []): ExtensionContext["sessionManager"] {
    return stubSessionManager({
        getSessionId: () => "session-1",
        getLeafId: () => entries.at(-1)?.id ?? null,
        getEntries: () => entries,
    });
}

type FooterDataOverrides = {
    branch?: string | null;
    statuses?: ReadonlyMap<string, string>;
};

function footerData(overrides: FooterDataOverrides = {}): ReadonlyFooterDataProvider {
    return {
        getGitBranch: () => overrides.branch ?? null,
        getExtensionStatuses: () => overrides.statuses ?? new Map<string, string>(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => () => {},
    };
}

function baseContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    return stubContext({
        cwd: "/tmp/project",
        sessionManager: footerSession(),
        ...overrides,
    });
}

function statusContext(): ExtensionContext {
    const entries = [
        usageEntry("u1", usageWithCost(12_345, 4_567, 98_000, 1_000, 0.123)),
        assistantEntry("a1", usageWithCost(2_000, 400, 1_500, 0, 0.01)),
    ];

    return baseContext({
        sessionManager: footerSession(entries),
        model: stubModel(),
        getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000, percent: 45 }),
    });
}

function makeFooter(
    context: ExtensionContext,
    data: ReadonlyFooterDataProvider = footerData(),
    options: { runs?: AgentRunSummary[]; todo?: TodoList } = {},
): PiCoderFooter {
    return new PiCoderFooter(
        stubTui(),
        mockTheme,
        data,
        context,
        options.runs ?? [],
        0,
        options.todo,
    );
}

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

function recordingUi(): { ui: ExtensionUIContext; calls: Array<FooterFactory | undefined> } {
    const calls: Array<FooterFactory | undefined> = [];
    const ui = stubUi({
        setFooter(factory) {
            calls.push(factory);
        },
    });
    return { ui, calls };
}

function instantiate(factory: FooterFactory | undefined, data = footerData()): PiCoderFooter {
    if (!factory) {
        throw new Error("expected a footer factory to be registered");
    }

    // pi's factory type erases the concrete component; the registration always builds this class.
    return factory(stubTui(), mockTheme, data) as PiCoderFooter;
}

function registerForContext(): {
    events: ReturnType<typeof createEventBus>;
    trigger: (name: string, context: ExtensionContext) => void;
} {
    const events = createEventBus();
    const stub = createPiStub({ eventBus: events });
    registerStatusFooter(stub.pi);
    return {
        events,
        trigger(name, context) {
            for (const handler of stub.handlersFor(name)) handler({}, context);
        },
    };
}

describe("status footer", () => {
    it("renders one compact TODO line", async () => {
        const footer = makeFooter(baseContext(), footerData(), { todo });

        await expect(snapshotText(renderText(footer, 80))).toMatchFileSnapshot(
            "./__snapshots__/status-footer.todo.txt",
        );
        footer.dispose();
    });

    it("right-aligns usage totals, context, and model when idle", async () => {
        const footer = makeFooter(statusContext(), footerData({ branch: "main" }));

        await expect(snapshotText(renderText(footer, 100))).toMatchFileSnapshot(
            "./__snapshots__/status-footer.info.txt",
        );
        footer.dispose();
    });

    it("drops trailing segments when the line cannot fit", async () => {
        const data = footerData({
            branch: "main",
            statuses: new Map([["alpha", "first"]]),
        });
        const footer = makeFooter(statusContext(), data);

        const line = renderText(footer, 34);
        await expect(snapshotText(line)).toMatchFileSnapshot(
            "./__snapshots__/status-footer.narrow.txt",
        );
        expect(line).toContain("45.0%/200k");
        expect(line).not.toContain("stub-model");
        expect(line).not.toContain("first");
        expect(line).not.toContain("$");
        footer.dispose();
    });

    it("registers at session start and feeds status events into the line", async () => {
        const { ui, calls } = recordingUi();
        const context = baseContext({
            mode: "tui",
            hasUI: true,
            ui,
            model: stubModel(),
            getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
        });
        const { events, trigger } = registerForContext();

        trigger("session_start", context);
        expect(calls).toHaveLength(1);
        const footer = instantiate(calls[0]);

        const run = partialRun({
            runId: "worker-1",
            title: "Implement the feature",
            agent: "worker",
            status: "running",
            task: "Implement the feature",
            startedAt: Date.now(),
            phase: "Thinking",
        });
        emitAgentStatus(events, [run], 0);
        emitTodoStatus(events, todo);

        const rendered = renderText(footer, 160);
        await expect(snapshotText(rendered)).toMatchFileSnapshot(
            "./__snapshots__/status-footer.combined.txt",
        );
        expect(rendered).toContain("worker-1");
        // An active agent owns the line, so TODO progress yields to it.
        expect(rendered).not.toContain("TODO 1/4");
        expect(rendered).not.toContain("\n");

        // Once the run is terminal, the plan comes back.
        emitAgentStatus(events, [{ ...run, status: "completed", updatedAt: run.updatedAt + 1 }], 0);
        expect(renderText(footer, 160)).toContain("TODO 1/4");

        emitAgentStatus(events, [], 0);
        emitTodoStatus(events, undefined);
        expect(renderText(footer, 160)).not.toContain("TODO 1/4");
        expect(calls).toHaveLength(1);
        footer.dispose();
    });

    it("restores the built-in footer on shutdown and re-registers on the next session", () => {
        const { ui, calls } = recordingUi();
        const context = baseContext({ mode: "tui", hasUI: true, ui });
        const { trigger } = registerForContext();

        trigger("session_start", context);
        const footer = instantiate(calls[0]);
        trigger("session_shutdown", context);
        expect(calls.at(-1)).toBeUndefined();

        trigger("session_start", context);
        expect(calls).toHaveLength(3);
        expect(calls.at(-1)).toBeTypeOf("function");
        footer.dispose();
    });

    it("disposes and re-registers when a non-TUI shutdown skips the restore", () => {
        const { ui, calls } = recordingUi();
        const context = baseContext({ mode: "tui", hasUI: true, ui });
        const { events, trigger } = registerForContext();
        trigger("session_start", context);

        trigger("session_shutdown", { ...context, mode: "print", hasUI: false });
        trigger("session_start", context);
        expect(calls).toHaveLength(2);

        emitTodoStatus(events, todo);
        const footer = instantiate(calls.at(-1));
        expect(renderText(footer, 160)).toContain("TODO 1/4");
        footer.dispose();
    });

    it("updates a displayed TODO without replacing the footer", () => {
        const footer = makeFooter(baseContext(), footerData(), { todo });
        footer.setTodo({ ...todo, items: todo.items.slice(0, 2) });

        expect(renderText(footer, 80)).toContain("TODO 1/2");
        footer.dispose();
    });

    it("mutes a completed TODO list and still names the last item", () => {
        const done: TodoList = {
            ...todo,
            items: todo.items.map((item) => ({ ...item, status: "completed" as const })),
        };
        const fg = vi.spyOn(mockTheme, "fg");
        const footer = new PiCoderFooter(
            stubTui(),
            mockTheme,
            footerData(),
            baseContext(),
            [],
            0,
            done,
        );

        const line = renderText(footer, 80);
        expect(line).toContain("TODO 4/4 · Release the change");
        expect(fg).toHaveBeenCalledWith("dim", expect.stringContaining("TODO 4/4"));
        footer.dispose();
    });

    it("hides TODO progress while an agent is active and restores it when it settles", () => {
        const footer = makeFooter(baseContext(), footerData(), { todo });
        const active = partialRun({
            runId: "worker-1",
            title: "Implement the feature",
            task: "Implement the feature",
            status: "waiting_for_permission",
            startedAt: Date.now(),
        });

        footer.setAgents([active]);
        expect(renderText(footer, 160)).not.toContain("TODO");

        footer.setAgents([{ ...active, status: "completed" }]);
        expect(renderText(footer, 160)).toContain("TODO 1/4");
        footer.dispose();
    });

    it("shows the auto badge while the decision model is enabled", () => {
        vi.spyOn(decisionConfig, "current", "get").mockReturnValue({ enabled: true });
        const fg = vi.spyOn(mockTheme, "fg");
        const footer = makeFooter(baseContext());

        expect(renderText(footer, 80)).toContain("» auto");
        expect(fg).toHaveBeenCalledWith("accent", "» auto");

        footer.setDecisionChecking(1);
        const checkingLine = renderText(footer, 80);
        expect(checkingLine).toContain("⠋ auto");
        // One marker at a time: the spinner replaces the arrows while a check runs.
        expect(checkingLine).not.toContain("»");
        footer.setDecisionChecking(0);
        expect(renderText(footer, 80)).not.toContain("⠋");
        footer.dispose();
    });

    it("shows a dim manual badge while the decision model is disabled", () => {
        const fg = vi.spyOn(mockTheme, "fg");
        const footer = makeFooter(baseContext());

        const line = renderText(footer, 80);
        expect(line).toContain("» manual");
        expect(line).not.toContain("auto");
        expect(fg).toHaveBeenCalledWith("dim", "» manual");
        footer.dispose();
    });

    it("renders auto mode beside a completed plan", async () => {
        vi.spyOn(decisionConfig, "current", "get").mockReturnValue({ enabled: true });
        const done: TodoList = {
            ...todo,
            items: todo.items.map((item) => ({ ...item, status: "completed" as const })),
        };
        const footer = makeFooter(statusContext(), footerData({ branch: "main" }), { todo: done });

        await expect(snapshotText(renderText(footer, 140))).toMatchFileSnapshot(
            "./__snapshots__/status-footer.auto.txt",
        );
        footer.dispose();
    });

    it("trims a completed TODO with a muted ellipsis", () => {
        const fg = vi.spyOn(mockTheme, "fg");
        const done: TodoList = {
            ...todo,
            items: todo.items.map((item) => ({ ...item, status: "completed" as const })),
        };
        const footer = makeFooter(baseContext(), footerData(), { todo: done });

        const line = renderText(footer, 60);
        expect(line).toContain("…");
        // The trim follows the segment's own dim state, like the tip's ellipsis.
        expect(fg).toHaveBeenCalledWith("dim", "…");
        footer.dispose();
    });

    it("feeds decision-check events into the auto badge", () => {
        vi.spyOn(decisionConfig, "current", "get").mockReturnValue({ enabled: true });
        const { ui, calls } = recordingUi();
        const context = baseContext({ mode: "tui", hasUI: true, ui });
        const { events, trigger } = registerForContext();

        trigger("session_start", context);
        const footer = instantiate(calls[0]);

        emitDecisionStatus(events, 1);
        expect(renderText(footer, 80)).toContain("⠋ auto");
        expect(renderText(footer, 80)).not.toContain("»");

        emitDecisionStatus(events, 0);
        expect(renderText(footer, 80)).not.toContain("⠋");
        footer.dispose();
    });

    it("shows a help tip instead of the TODO while no agent is active", async () => {
        const footer = makeFooter(statusContext(), footerData({ branch: "main" }), { todo });
        footer.setTip("Say 'remember this' to keep it in project memory");

        const line = renderText(footer, 142);
        await expect(snapshotText(line)).toMatchFileSnapshot(
            "./__snapshots__/status-footer.tip-left.txt",
        );
        expect(line).toContain("tip: Say 'remember this' to keep it in project memory");
        expect(line).not.toContain("TODO");
        // The right cluster keeps its numbers in the left placement.
        expect(line).toContain("120k tok");

        footer.setTip(undefined);
        expect(renderText(footer, 140)).toContain("TODO 1/4");
        footer.dispose();
    });

    it("shows a help tip instead of the usage numbers while an agent is active", async () => {
        const run = partialRun({
            runId: "worker-1",
            title: "Implement the feature",
            task: "Implement the feature",
            status: "running",
            startedAt: Date.now(),
        });
        const footer = makeFooter(statusContext(), footerData({ branch: "main" }), {
            runs: [run],
            todo,
        });
        footer.setTip("/agents lists runs, workspaces, and settings");

        const line = renderText(footer, 140);
        await expect(snapshotText(line)).toMatchFileSnapshot(
            "./__snapshots__/status-footer.tip-right.txt",
        );
        expect(line).toContain("tip: /agents lists runs, workspaces, and settings");
        expect(line).not.toContain("tok");
        expect(line).not.toContain("200k");
        expect(line).toContain("worker-1");
        expect(line).toContain("stub-model");

        footer.setTip(undefined);
        const restored = renderText(footer, 140);
        expect(restored).toContain("120k tok");
        expect(restored).toContain("45.0%/200k");
        footer.dispose();
    });

    it("trims a long tip into the left's remaining width and keeps the badge", () => {
        vi.spyOn(decisionConfig, "current", "get").mockReturnValue({ enabled: true });
        const fg = vi.spyOn(mockTheme, "fg");
        const footer = makeFooter(statusContext(), footerData({ branch: "main" }));
        footer.setTip("x".repeat(200));

        const line = renderText(footer, 120);
        // The tip yields characters instead of vanishing, and the badge stays on the line.
        expect(line).toContain("» auto");
        expect(line).toContain("tip: ");
        expect(line).toContain("…");
        expect(line).not.toContain("x".repeat(60));
        // The layout trim is styled like the tip, so the ellipsis is not left bright.
        expect(fg).toHaveBeenCalledWith("dim", "…");
        footer.dispose();
    });

    it("caps the right-placement tip so it cannot balloon the reserved cluster", () => {
        const run = partialRun({
            runId: "worker-1",
            title: "Implement the feature",
            task: "Implement the feature",
            status: "running",
            startedAt: Date.now(),
        });
        const footer = makeFooter(baseContext(), footerData(), { runs: [run] });
        footer.setTip("x".repeat(200));

        const line = renderText(footer, 200);
        expect(line).not.toContain("x".repeat(60));
        expect(line).toContain("…");
        footer.dispose();
    });

    it("starts the tip rotation with the footer", () => {
        vi.useFakeTimers();
        try {
            const footer = makeFooter(baseContext());
            expect(renderText(footer, 120)).not.toContain("tip: ");

            vi.advanceTimersByTime(19_999);
            expect(renderText(footer, 120)).not.toContain("tip: ");

            vi.advanceTimersByTime(1);
            expect(renderText(footer, 120)).toContain("tip: ");
            footer.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("footer line formatting", () => {
    function segment(
        text: string,
        side: FooterLineSegment["side"],
        dropPriority = 0,
        extras: Partial<FooterLineSegment> = {},
    ): FooterLineSegment {
        return { text, side, dropPriority, ...extras };
    }

    it("shortens a cwd under the home directory", () => {
        expect(formatCwd("/home/dev/project", "/home/dev")).toBe(`~${sep}project`);
        expect(formatCwd("/home/dev", "/home/dev")).toBe("~");
        expect(formatCwd("/tmp/x", "/home/dev")).toBe("/tmp/x");
        expect(formatCwd("/home/developer", "/home/dev")).toBe("/home/developer");
        expect(formatCwd("/tmp/x", undefined)).toBe("/tmp/x");
    });

    it("formats token counts compactly", () => {
        expect(formatTokens(999)).toBe("999");
        expect(formatTokens(1_000)).toBe("1.0k");
        expect(formatTokens(9_999)).toBe("10.0k");
        expect(formatTokens(10_000)).toBe("10k");
        expect(formatTokens(2_500_000)).toBe("2.5M");
        expect(formatTokens(12_000_000)).toBe("12M");
    });

    it("right-aligns a trailing cluster", () => {
        expect(
            layoutFooterLine([segment("left", "left"), segment("context", "right", 0)], 20),
        ).toBe(`left${" ".repeat(9)}context`);
    });

    it("reserves the right cluster and shrinks the left into the remainder", () => {
        const line = layoutFooterLine(
            [
                segment("agent summary", "left", 4),
                segment("TODO 5/10", "left", 5),
                segment("model", "right", 3),
                segment("context", "right", 0),
            ],
            20,
        );

        // right = "model · context" (15), leaving 3 for the left: TODO drops, agent truncates.
        expect(line.endsWith("model · context")).toBe(true);
        expect(line).not.toContain("TODO 5/10");
        expect(line).toContain("ag");
        expect(visibleWidth(line)).toBe(20);
    });

    it("drops left info segments before truncating the agent summary", () => {
        const line = layoutFooterLine(
            [
                segment("agent", "left", 4),
                segment("todo", "left", 5),
                segment("status", "left", 6),
                segment("ctx", "right", 0),
            ],
            10,
        );

        expect(line).toBe("agent  ctx");
    });

    it("drops right segments only when the right cluster alone cannot fit", () => {
        const line = layoutFooterLine(
            [
                segment("usage", "right", 2),
                segment("context", "right", 0),
                segment("model", "right", 3),
            ],
            12,
        );

        // model drops first, then usage; context remains and is right-aligned.
        expect(line).toBe(`${" ".repeat(5)}context`);
    });

    it("truncates the last remaining segment when it alone is too wide", () => {
        const truncated = layoutFooterLine([segment("a long first segment", "left")], 10);
        expect(truncated).toContain("…");
        expect(visibleWidth(truncated)).toBe(10);
    });

    it("shrinks a shrinkToFit segment instead of dropping it", () => {
        const line = layoutFooterLine(
            [
                segment("auto", "left", 4),
                segment("tip: a long help message", "left", 5, { shrinkToFit: true }),
                segment("status", "left", 6),
            ],
            30,
        );

        // status drops first; the tip then shortens into what auto and its separator leave.
        expect(line).toContain("auto · tip:");
        expect(line).toContain("…");
        expect(line).not.toContain("status");
        expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    });

    it("drops a shrinkToFit segment when only a stub would fit", () => {
        const line = layoutFooterLine(
            [
                segment("auto", "left", 4),
                segment("tip: everything", "left", 5, { shrinkToFit: true }),
            ],
            10,
        );

        expect(line).toBe("auto");
    });

    it("trims with the segment's own ellipsis style", () => {
        const dimmed = "\x1b[2m…\x1b[0m";
        const line = layoutFooterLine(
            [segment("tip: a long dim message", "left", 0, { ellipsis: dimmed })],
            12,
        );

        expect(line).toContain(dimmed);
        expect(visibleWidth(line)).toBe(12);
    });
});

describe("usage totals cache", () => {
    it("caches totals until the leaf or entry count changes", () => {
        const entries = [
            usageEntry("u1", usageWithCost(12_345, 4_567, 98_000, 1_000, 0.123)),
            assistantEntry("a1", usageWithCost(2_000, 400, 1_500, 0, 0.01)),
        ];
        let leaf = "u1";
        let entryReads = 0;
        const session: FooterSessionSource & { getEntryCount(): number } = {
            getSessionId: () => "session-1",
            getLeafId: () => leaf,
            getEntries: () => {
                entryReads += 1;
                return entries;
            },
            getEntryCount: () => entries.length,
        };

        const cache = new UsageTotalsCache();
        const first = cache.get(session);
        const second = cache.get(session);

        expect(entryReads).toBe(1);
        expect(second).toBe(first);
        expect(first.cost).toBeCloseTo(0.133);
        expect(first.cacheHitRate).toBeCloseTo(42.857, 3);

        leaf = "a1";
        cache.get(session);
        expect(entryReads).toBe(2);
    });
});
