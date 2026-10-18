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
import { describe, expect, it } from "vitest";

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
        expect(rendered.indexOf("worker-1")).toBeLessThan(rendered.indexOf("TODO 1/4"));
        expect(rendered).toContain("TODO 1/4");
        expect(rendered).not.toContain("\n");

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
});

describe("footer line formatting", () => {
    function segment(
        text: string,
        side: FooterLineSegment["side"],
        dropPriority = 0,
    ): FooterLineSegment {
        return { text, side, dropPriority };
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
