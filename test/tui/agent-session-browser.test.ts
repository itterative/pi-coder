import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";

import { AGENT_EVENT_CHANNEL } from "../../src/tools/agent/observability/events";
import {
    AgentSessionBrowserComponent,
    showAgentSessionBrowser,
    type AgentSessionBrowserData,
} from "../../src/tui/agents";
import type { AgentWorkspace } from "../../src/tools/agent/contracts/workspaces";
import { workspaceBrowserItem, type AgentSessionBrowserItem } from "../../src/tools/agent/presentation/browser-models";
import { TODO_SNAPSHOT_TYPE } from "../../src/modules/todolist/persistence";
import { formatAgentSessionTranscripts } from "../../src/tools/agent/presentation/transcript";
import { KEY, interact, mockTheme, press, renderText, snapshotText } from "../helpers";

const current = {
    kind: "current" as const,
    id: "scout-1",
    title: "Project structure audit",
    agent: "scout",
    status: "running",
    task: "Inspect the project structure",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    activity: "Reading files",
    responsePreview: "I found the main entry points and summarized the current architecture.",
    usage: {
        input: 1_200,
        output: 2_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2_001_200,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
};

const workspace: AgentWorkspace = {
    version: 1,
    id: "quiet-lantern-7k3",
    cwd: "/repo/project",
    repositoryRoot: "/repo/project",
    worktreePath: "/state/workspaces/quiet-lantern-7k3",
    slug: "quiet-lantern-7k3",
    baseRevision: "abc123def456",
    setupState: "ready",
    status: "available",
    latestResult: {
        id: "result-1",
        workspaceId: "quiet-lantern-7k3",
        runId: "worker-1",
        baseRevision: "abc123def456",
        workerHead: "abc123def456",
        commitRange: "abc123def456..abc123def456",
        commits: [],
        preparedAt: 1_700_000_001_000,
        status: "prepared",
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
};

const validationWorkspace: AgentWorkspace = {
    version: 1,
    id: "sunlit-lantern-6tk",
    cwd: "/home/sd/Repos/pi-coder/.workspace-validation/repo",
    repositoryRoot: "/home/sd/Repos/pi-coder/.workspace-validation/repo",
    worktreePath: "/home/sd/Repos/pi-coder/.state/workspaces/sunlit-lantern-6tk",
    slug: "sunlit-lantern-6tk",
    baseRevision: "feb634569ddcbd54faac5c270d6ecdf9a97952a5",
    setupState: "ready",
    setupSummary: `Setup complete.

- Inspected \`AGENTS.md\`, \`README.md\`, and \`WORKSPACE-MANUAL-VALIDATION.md\`.
- No dependency manifests, setup scripts, or project-local environment artifacts are present.
- Verified prerequisites:
  - Git 2.55.0
  - pi 0.84.2
- No commands requiring mutation were needed.
- Changed files: none.
- Final Git status: clean.

Later worker can proceed directly; use the manual validation checklist for workspace testing.`,
    leaseOwnerSessionId: "01a03327-5ba3-7301-b185-794ec34c8dbd",
    leaseRunId: "worker-1",
    leaseKind: "task",
    leaseAcquiredAt: 1_787_564_674_474,
    status: "available",
    createdAt: 1_787_564_636_346,
    updatedAt: 1_787_564_662_721,
};

const past = {
    kind: "past" as const,
    id: "child-session-1",
    title: "Previous implementation review",
    agent: "delegated agent",
    status: "completed",
    task: "Review the previous implementation",
    updatedAt: 1_700_000_002_000,
    sessionFile: "/tmp/.state/agent-sessions/--cwd--/parent/child-session-1.jsonl",
    parentSessionId: "parent",
    messageCount: 4,
    firstMessage: "Review the previous implementation",
    responsePreview: "The previous implementation is persisted and can be browsed read-only.",
};

function component() {
    const value = new AgentSessionBrowserComponent({ current: [current], past: [past] });
    value.initialize(mockTheme);
    return value;
}

function liveTranscript(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, index) => `Live transcript line ${index}`).join("\n");
}

beforeEach(() => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("Nov 14 2023 22:13");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("AgentSessionBrowserComponent", () => {
    it("refreshes from agent events while remaining open, including isolated runs", async () => {
        const eventBus = createEventBus();
        const value = new AgentSessionBrowserComponent({
            current: [current],
            past: [past],
            cwd: "/repo/project",
            eventBus,
            onRefresh: async () => ({
                current: [{ ...current, title: "Updated run" }],
                past: [past],
            }),
        });
        value.initialize(mockTheme);

        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project/.state/workspaces/quiet-lantern-7k3",
            parentCwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "progress",
            runId: current.id,
            status: "running",
            workspaceId: "quiet-lantern-7k3",
        });
        for (let index = 0; index < 4; index++) await Promise.resolve();

        expect(renderText(value, 100)).toContain("Updated run");
        value.dispose();
        eventBus.clear();
    });

    it("refreshes an open live detail and follows output until the user scrolls up", async () => {
        const eventBus = createEventBus();
        let transcript = liveTranscript(30);
        let completed = false;
        let refreshes = 0;
        const value = new AgentSessionBrowserComponent({
            current: [{ ...current, transcript }],
            past: [],
            cwd: "/repo/project",
            eventBus,
            fixedHeight: () => 20,
            onRefresh: async () => {
                refreshes++;
                return {
                    current: [{ ...current, transcript, status: completed ? "completed" : "running" }],
                    past: [],
                };
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);
        ui.press(KEY.enter);
        expect(ui.render()).toContain("Live transcript line 29");

        transcript = liveTranscript(60);
        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "progress",
            runId: current.id,
            status: "running",
        });
        await vi.waitFor(() => expect(ui.render()).toContain("Live transcript line 59"));

        ui.press(KEY.up);
        transcript = liveTranscript(90);
        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "progress",
            runId: current.id,
            status: "running",
        });
        await vi.waitFor(() => expect(refreshes).toBe(2));
        expect(ui.render()).not.toContain("Live transcript line 89");

        ui.press("\x1b[F");
        expect(ui.render()).toContain("Live transcript line 89");

        completed = true;
        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "status_changed",
            runId: current.id,
            previousStatus: "running",
            status: "completed",
        });
        await vi.waitFor(() => expect(ui.render()).toContain("[scout] Project structure audit · completed"));
        value.dispose();
        eventBus.clear();
    });

    it("updates an open detail when a live run moves to the past tab", async () => {
        const eventBus = createEventBus();
        const sessionFile = "/tmp/.state/agent-sessions/--cwd--/parent/child-session-1.jsonl";
        let refreshCount = 0;
        const liveWithoutFile = {
            ...current,
            transcript: liveTranscript(30),
            transcriptCollapsed: liveTranscript(30),
        };
        const liveWithFile = {
            ...liveWithoutFile,
            sessionFile,
            transcript: liveTranscript(60),
            transcriptCollapsed: liveTranscript(60),
        };
        const completed = {
            ...past,
            id: "child-session-1",
            sessionFile,
        };
        const value = new AgentSessionBrowserComponent({
            current: [liveWithoutFile],
            past: [],
            cwd: "/repo/project",
            eventBus,
            fixedHeight: () => 20,
            onRefresh: async () => {
                refreshCount++;
                return refreshCount === 1
                    ? { current: [liveWithFile], past: [] }
                    : { current: [], past: [completed] };
            },
            onLoadTranscript: async (item) => ({
                ...item,
                transcript: liveTranscript(90),
                transcriptCollapsed: liveTranscript(90),
            }),
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.enter);
        expect(ui.render()).toContain("Live transcript line 29");

        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "progress",
            runId: current.id,
            status: "running",
        });
        await vi.waitFor(() => expect(ui.render()).toContain("Live transcript line 59"));

        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "status_changed",
            runId: current.id,
            previousStatus: "running",
            status: "completed",
        });
        await vi.waitFor(() => expect(ui.render()).toContain("Live transcript line 89"));

        ui.press(KEY.up);
        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "progress",
            runId: current.id,
            status: "completed",
        });
        await vi.waitFor(() => expect(refreshCount).toBe(3));
        expect(ui.render()).not.toContain("Live transcript line 89");

        ui.press(KEY.tab);
        ui.press(KEY.escape);
        expect(ui.render()).not.toContain("Run ID: child-session-1");
        value.dispose();
        eventBus.clear();
    });

    it("renders a loading state until the initial agent data arrives", async () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            loadingAgents: true,
        });
        value.initialize(mockTheme);

        await expect(snapshotText(renderText(value, 100))).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.loading.txt",
        );

        value.apply({ current: [current], past: [] });

        await expect(snapshotText(renderText(value, 100))).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.loading-complete.txt",
        );
    });

    it("cancels an initial load when the browser closes", async () => {
        let resolveInitial!: (data: AgentSessionBrowserData) => void;
        let initialSignal: AbortSignal | undefined;
        let browser: AgentSessionBrowserComponent | undefined;
        let finish!: () => void;
        const customPromise = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const tui = {
            terminal: { rows: 40 },
            addInputListener: () => () => {},
            requestRender: () => {},
        };
        const notify = vi.fn();
        const custom = (factory: any) => {
            browser = factory(tui, mockTheme, {}, finish);
            return customPromise;
        };
        const show = showAgentSessionBrowser({
            current: [],
            past: [],
            loadingAgents: true,
            onInitialLoad: (signal) => {
                initialSignal = signal;
                return new Promise<AgentSessionBrowserData>((resolve) => {
                    resolveInitial = resolve;
                });
            },
        }, {
            hasUI: true,
            mode: "tui",
            ui: { custom, notify },
        } as any);

        await vi.waitFor(() => expect(browser).toBeDefined());
        browser!.handleInput(KEY.escape);
        await show;
        expect(initialSignal?.aborted).toBe(true);

        resolveInitial({ current: [current], past: [] });
        await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();
    });

    it("shows a loading state for workspaces until the initial data arrives", async () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            workspaces: [],
            loadingWorkspaces: true,
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.workspaces-loading.txt",
        );
    });

    it("defers refresh events until the initial data has been applied", async () => {
        const eventBus = createEventBus();
        let refreshes = 0;
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            workspaces: [],
            cwd: "/repo/project",
            eventBus,
            loadingAgents: true,
            loadingWorkspaces: true,
            onRefresh: async () => {
                refreshes++;
                return {
                    current: [{ ...current, title: "Refreshed run" }],
                    past: [],
                    workspaces: [],
                };
            },
        });
        value.initialize(mockTheme);

        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: "/repo/project",
            timestamp: Date.now(),
            type: "run",
            action: "progress",
            runId: current.id,
            status: "running",
        });
        await Promise.resolve();
        expect(refreshes).toBe(0);

        value.apply({ current: [current], past: [], workspaces: [] });
        await vi.waitFor(() => expect(refreshes).toBe(1));
        await expect(snapshotText(renderText(value, 100))).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.initial-refresh.txt",
        );

        value.dispose();
        eventBus.clear();
    });

    it("renders the current tab", async () => {
        const value = component();

        await expect(snapshotText(renderText(value, 100))).toMatchFileSnapshot("__snapshots__/agent-session-browser.current-tab.txt");
    });

    it("separates multiple session entries with a blank row", () => {
        const value = new AgentSessionBrowserComponent({
            current: [
                current,
                {
                    ...current,
                    id: "scout-2",
                    title: "Dependency audit",
                    task: "Check dependencies",
                    responsePreview: "The dependencies are up to date.",
                },
            ],
            past: [],
        });
        value.initialize(mockTheme);
        const lines = renderText(value, 100).split("\n");
        const first = lines.findIndex((line) => line.includes("Project structure audit"));
        const second = lines.findIndex((line) => line.includes("Dependency audit"));

        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
        expect(lines.slice(first, second).some((line) => /^│\s+│$/.test(line))).toBe(true);
    });

    it("keeps the frame height stable when scrolling wrapped list lines", () => {
        const value = new AgentSessionBrowserComponent({
            current: Array.from({ length: 4 }, (_, index) => ({
                ...current,
                id: `scout-${index}`,
                task: "Inspect this deliberately long delegated-agent task so the list must wrap it across multiple visual lines",
            })),
            past: [],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 60);
        const initialHeight = ui.render().length;

        ui.press(KEY.down);

        expect(ui.render()).toHaveLength(initialHeight);
    });

    it("keeps the help footer visible at the bottom of a scrolling fixed-height list", async () => {
        const value = new AgentSessionBrowserComponent({
            current: Array.from({ length: 6 }, (_, index) => ({
                ...current,
                id: `scout-${index}`,
                title: `Project structure audit ${index}`,
            })),
            past: [],
            fixedHeight: () => 20,
        });
        value.initialize(mockTheme);
        const ui = interact(value, 64);

        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.fixed-height-list-footer.txt",
        );

        ui.press(KEY.down);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.fixed-height-list-footer-after-scroll.txt",
        );
    });

    it("lets the user resume or cancel an interrupted run", async () => {
        const interrupted = { ...current, status: "interrupted" };
        let resumed = false;
        const value = new AgentSessionBrowserComponent({
            current: [interrupted],
            past: [],
            onResume: () => { resumed = true; },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press("r");
        await Promise.resolve();
        expect(resumed).toBe(true);

        let canceled = false;
        const cancelValue = new AgentSessionBrowserComponent({
            current: [{ ...current, status: "waiting_for_parent" }],
            past: [],
            onCancel: () => { canceled = true; },
        });
        cancelValue.initialize(mockTheme);
        const cancelUi = interact(cancelValue, 100);
        cancelUi.press("c");
        await Promise.resolve();
        expect(canceled).toBe(true);
    });

    it("opens a separate detail view with metadata and transcript", async () => {
        const value = component();
        const ui = interact(value, 100);

        ui.press(KEY.enter);

        await expect(snapshotText(ui.render())).toMatchFileSnapshot("__snapshots__/agent-session-browser.session-detail.txt");
    });

    it("renders Markdown in the transcript detail view", async () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [{
                ...past,
                transcript: "# Findings\n\nThe **implementation** is sound.\n\n- Preserves the prompt\n- Renders replies as Markdown\n\n```ts\nconst ready = true;\n```",
            }],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.enter);

        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.session-detail-markdown.txt",
        );
    });

    it("loads a past transcript lazily and redraws the open detail", async () => {
        const loadedItems: AgentSessionBrowserItem[] = [];
        let resolveTranscript!: (item: AgentSessionBrowserItem) => void;
        const transcript = new Promise<AgentSessionBrowserItem>((resolve) => {
            resolveTranscript = resolve;
        });
        let renderedOnInvalidate = "";
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [past],
            onLoadTranscript: (item) => {
                loadedItems.push(item);
                return transcript;
            },
            onInvalidate: () => {
                renderedOnInvalidate = renderText(value, 100);
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.enter);
        // While the transcript is loading, the preview is shown with a hint.
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.session-detail-loading.txt",
        );

        expect(loadedItems).toHaveLength(1);
        expect(loadedItems[0]).toMatchObject({ id: "child-session-1", kind: "past" });
        resolveTranscript({
            ...loadedItems[0]!,
            transcript: "The implementation is sound.",
            messageCount: 4,
        });
        await vi.waitFor(() => expect(renderedOnInvalidate).toContain("The implementation is sound."));
        expect(renderedOnInvalidate).not.toContain("Loading full transcript…");
    });

    it("toggles between collapsed and detailed transcript views", () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [{
                ...past,
                transcript: "The agent inspected the project.\n\n● read src/index.ts\n● read README.md",
                transcriptCollapsed: "The agent inspected the project.\n\n▸ 2 tool calls: read src/index.ts; read README.md",
            }],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab, KEY.enter);
        expect(ui.render()).toContain("Transcript:");
        expect(ui.render()).not.toContain("Transcript (collapsed):");
        expect(ui.render()).toContain("▸ 2 tool calls: read src/index.ts; read README.md");

        ui.press(KEY.tab);
        expect(ui.render()).toContain("Transcript:");
        expect(ui.render()).not.toContain("Transcript (detailed):");
        expect(ui.render()).toContain("● read src/index.ts");
        expect(ui.render()).toContain("● read README.md");

        ui.press(KEY.tab);
        expect(ui.render()).toContain("Transcript:");
        expect(ui.render()).not.toContain("Transcript (collapsed):");
    });

    it("snapshots representative tool-call rendering in both transcript views", async () => {
        const session = SessionManager.inMemory("/repo/project");
        session.appendMessage({
            role: "user",
            content: "Inspect the project and make the requested checks.",
            timestamp: 1,
        });
        session.appendMessage({
            role: "assistant",
            content: [
                { type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/index.ts" } },
                { type: "toolCall", id: "call-find", name: "find", arguments: { pattern: "*.test.ts", path: "test" } },
                { type: "toolCall", id: "call-grep", name: "grep", arguments: { pattern: "AgentSession", path: "src/tui" } },
                { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "npm test" } },
                {
                    type: "toolCall",
                    id: "call-edit",
                    name: "edit",
                    arguments: {
                        path: "src/index.ts",
                        edits: [{ oldText: "const oldValue = **literal**;", newText: "const newValue = **literal**;" }],
                    },
                },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-edit",
            toolName: "edit",
            content: [{ type: "text", text: "Edit failed" }],
            isError: true,
            timestamp: 3,
        });
        session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "The first checks are complete." }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 4,
        });
        session.appendMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-read-2", name: "read", arguments: { path: "README.md" } }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 5,
        });
        const transcript = formatAgentSessionTranscripts(session.getBranch());
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [{
                ...past,
                title: "Tool call rendering review",
                task: "Inspect files, search for a symbol, run tests, and update the implementation",
                transcript: transcript.detailed,
                transcriptCollapsed: transcript.collapsed,
                transcriptParts: transcript.detailedParts,
                transcriptCollapsedParts: transcript.collapsedParts,
            }],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab, KEY.enter);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.tool-calls-collapsed.txt",
        );

        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.tool-calls-detailed.txt",
        );

        ui.press(KEY.pageDown);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.tool-calls-detailed-scrolled.txt",
        );
    });

    it("renders all TODO items in collapsed and detailed transcript views", async () => {
        const todoDocument = `---
version: 1
todos:
  - id: inspect
    title: Inspect the implementation
    status: completed
  - id: implement
    title: Implement the feature
    status: completed
  - id: verify
    title: Verify the result
    status: in_progress
  - id: document
    title: Document the result
    status: pending
  - id: review
    title: Review the result
    status: pending
---

# Notes

Keep the notes with the TODO list.
`;
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "user",
            content: "The agent is working.",
            timestamp: 1,
        });
        session.appendMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/index.ts" } }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
        });
        session.appendCustomEntry(TODO_SNAPSHOT_TYPE, {
            version: 1,
            content: todoDocument,
        });
        const transcripts = formatAgentSessionTranscripts(session.getBranch());
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [{
                ...past,
                transcript: transcripts.detailed,
                transcriptCollapsed: transcripts.collapsed,
            }],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.enter);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.todo-collapsed.txt",
        );

        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.todo-detailed.txt",
        );

        ui.press(KEY.pageDown);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.todo-detailed-scrolled.txt",
        );

    });

    it("shows changed files but omits read files in session details", () => {
        const value = new AgentSessionBrowserComponent({
            current: [{
                ...current,
                readFiles: ["src/index.ts", "src/tools/agent/runtime.ts"],
                changedFiles: ["src/tools/agent/index.ts"],
            }],
            past: [],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.enter);

        expect(ui.render()).not.toContain("Read files (2):");
        expect(ui.render()).not.toContain("  - src/index.ts");
        expect(ui.render()).toContain("Changed files (1):");
        expect(ui.render()).toContain("  - src/tools/agent/index.ts");
    });

    it("scrolls a long transcript in the detail view", () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [{ ...past, transcript: Array.from({ length: 30 }, (_, index) => `Transcript line ${index}`).join("\n") }],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab);
        ui.press(KEY.enter);
        expect(ui.render()).toContain("Transcript line 0");
        ui.press(KEY.pageDown);
        expect(ui.render()).toContain("Transcript line 16");
        expect(ui.render()).not.toContain("Transcript line 0");
    });

    it("restores the collapsed viewport after scrolling detailed output", async () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [{
                ...past,
                transcript: Array.from({ length: 30 }, (_, index) => `Detailed transcript line ${index}`).join("\n"),
                transcriptCollapsed: "Collapsed transcript summary",
            }],
            fixedHeight: () => 20,
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab, KEY.enter, KEY.tab, KEY.pageDown);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.session-detail-scrolled.txt",
        );

        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.session-detail-collapsed-after-scroll.txt",
        );
    });

    it("defaults to this session and toggles to cwd-wide history", async () => {
        const sessionPast = { ...past, id: "same-session", title: "Current session checkpoint" };
        const value = new AgentSessionBrowserComponent({
            current: [current],
            sessionPast: [sessionPast],
            past: [past],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.session-scope.txt",
        );

        ui.press("h");
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.historical-scope.txt",
        );
    });

    it("uses left and right for directional view selection", () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            workspaces: [],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.right);
        expect(ui.render()).toContain("● Workspaces");
        ui.press(KEY.left);
        expect(ui.render()).toContain("● Agents");
    });

    it("allows explicit cancellation of a running current agent", async () => {
        let canceled: string | undefined;
        const value = new AgentSessionBrowserComponent({
            current: [current],
            past: [],
            onCancel: async (item) => {
                canceled = item.id;
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press("c");
        await vi.waitFor(() => expect(canceled).toBe("scout-1"));
    });

    it("merges workspaces into the agents browser", () => {
        let invalidations = 0;
        const workspaceView = workspaceBrowserItem(workspace, {
            gitState: {
                kind: "available",
                dirty: true,
                changedFiles: 2,
                stagedFiles: 1,
                unstagedFiles: 1,
                untrackedFiles: 0,
                headRevision: "abc123def456",
            },
        });
        const value = new AgentSessionBrowserComponent({
            current: [current],
            past: [past],
            workspaces: [workspaceView],
            onWorkspaceInspect: () => "diff text",
            onWorkspaceAction: async () => workspaceView,
            onInvalidate: () => { invalidations++; },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab);
        expect(ui.render()).toContain("● Workspaces");
        expect(ui.render()).toContain("quiet-lantern-7k3 · available");
        expect(ui.render()).toContain("Git: dirty · 2 changed files");

        ui.press(KEY.enter);
        expect(ui.render()).toContain("Workspace: quiet-lantern-7k3");
        expect(ui.render()).toContain("i inspect changes · r reset · d discard · Esc back");
        ui.press("i");
        expect(ui.render()).toContain("diff text");
        expect(invalidations).toBe(1);
        ui.press(KEY.escape);
        expect(ui.render()).toContain("Workspace: quiet-lantern-7k3");
    });

    it("refreshes an open workspace detail and uses the refreshed item for actions", async () => {
        const eventBus = createEventBus();
        const original = workspaceBrowserItem(workspace);
        const refreshed = workspaceBrowserItem({
            ...workspace,
            setupSummary: "Updated setup summary",
            updatedAt: workspace.updatedAt + 1,
        });
        let actionWorkspaceUpdatedAt: number | undefined;
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            workspaces: [original],
            cwd: workspace.cwd,
            eventBus,
            onRefresh: async () => ({ current: [], past: [], workspaces: [refreshed] }),
            onWorkspaceAction: async (selected) => {
                actionWorkspaceUpdatedAt = selected.updatedAt;
                return null;
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);
        ui.press(KEY.tab, KEY.enter);

        eventBus.emit(AGENT_EVENT_CHANNEL, {
            cwd: workspace.cwd,
            timestamp: Date.now(),
            type: "workspace",
            action: "updated",
            workspaceId: workspace.id,
        });
        await vi.waitFor(() => expect(ui.render()).toContain("Updated setup summary"));

        ui.press("d", "y");
        await vi.waitFor(() => expect(actionWorkspaceUpdatedAt).toBe(refreshed.updatedAt));
        value.dispose();
        eventBus.clear();
    });

    it("renders the validation workspace detail from the workspace registry", async () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            workspaces: [workspaceBrowserItem(validationWorkspace)],
            fixedHeight: () => 40,
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab, KEY.enter);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/sunlit-lantern-6tk.txt",
        );
    });

    it("confirms workspace discard and removes the workspace", async () => {
        let discarded = false;
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            workspaces: [workspaceBrowserItem(workspace)],
            fixedHeight: () => 27,
            onWorkspaceAction: async (selected, action) => {
                expect(selected.id).toBe(workspace.id);
                expect(action).toBe("discard");
                discarded = true;
                return null;
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab, KEY.enter);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot("__snapshots__/agent-session-browser.workspace-detail.txt");

        ui.press("d");
        expect(snapshotText(ui.render())).toContain("Confirm discard? y/Enter confirm · n/Esc cancel");
        await expect(snapshotText(ui.render())).toMatchFileSnapshot("__snapshots__/agent-session-browser.workspace-discard-confirmation.txt");

        ui.press("n");
        await expect(snapshotText(ui.render())).toMatchFileSnapshot("__snapshots__/agent-session-browser.workspace-discard-cancelled.txt");
        expect(discarded).toBe(false);

        ui.press("d", "y");
        await vi.waitFor(() => {
            expect(discarded).toBe(true);
            expect(snapshotText(ui.render())).toContain("No isolated workspaces have been created for this cwd.");
        });
        await expect(snapshotText(ui.render())).toMatchFileSnapshot("__snapshots__/agent-session-browser.workspaces-empty-after-discard.txt");
    });

    it("renders empty current and past tabs", async () => {
        const value = new AgentSessionBrowserComponent({ current: [], past: [] });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        await expect(snapshotText(ui.render())).toMatchFileSnapshot("__snapshots__/agent-session-browser.current-empty.txt");
    });

    it("toggles busy worker change notifications in settings", async () => {
        let enabled: boolean | undefined;
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            // TODO: This test should not need to manually provide every production setting just to render the settings view. Use a shared settings fixture or component defaults.
            settings: [
                {
                    id: "notifyBusyWorkerChanges",
                    label: "Busy worker change notifications",
                    description: "Get an immediate update when a worker changes your files while the main assistant is still working. Turn this off to receive the update only when the worker finishes.",
                    enabled: true,
                },
                {
                    id: "advisorEnabled",
                    label: "Advisor availability",
                    description: "Allow the parent agent to consult the read-only senior advisor. Configure its model separately below.",
                    enabled: false,
                },
                {
                    id: "scout",
                    label: "Scout model",
                    description: "Model used when the built-in scout agent runs.",
                },
                {
                    id: "reviewer",
                    label: "Reviewer model",
                    description: "Model used when the built-in reviewer agent runs.",
                },
                {
                    id: "advisor",
                    label: "Advisor model",
                    description: "Model used when the built-in advisor agent runs.",
                },
                {
                    id: "worker",
                    label: "Worker model",
                    description: "Model used when the built-in worker agent runs.",
                },
            ],
            onToggleChange: (_setting, next) => {
                enabled = next;
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.settings-notifications-on.txt",
        );
        ui.press(KEY.enter);
        await vi.waitFor(() => expect(enabled).toBe(false));
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.settings-notifications-off.txt",
        );
    });

    it("uses Enter and Escape for details, then closes the browser", () => {
        const value = component();
        const ui = interact(value, 100);
        let closed = false;
        value.setDoneCallback(() => { closed = true; });

        ui.press(KEY.enter);
        expect(ui.render()).toContain("Run ID: scout-1");
        ui.press(KEY.escape);
        expect(ui.render()).not.toContain("Run ID: scout-1");
        ui.press(KEY.escape);
        expect(closed).toBe(true);
    });

    it("does not open an empty model selector", async () => {
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            settings: [{
                id: "scout",
                label: "Scout model",
                description: "Model used by scout",
            }],
            models: [],
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab, KEY.enter);

        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.empty-model-selector.txt",
        );
    });

    it("shows built-in model settings and edits a model in a nested selector", async () => {
        let changed: { agent: string; model: string | undefined } | undefined;
        const value = new AgentSessionBrowserComponent({
            current: [],
            past: [],
            settings: [{
                id: "scout",
                label: "Scout model",
                description: "Model used by scout",
            }],
            models: [
                { label: "Parent model", description: "Use the current pi model" },
                { id: "openai/gpt-4.1", label: "openai/gpt-4.1", description: "GPT-4.1" },
            ],
            onModelChange: (agent, model) => {
                changed = { agent, model };
            },
        });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.settings-model-initial.txt",
        );
        ui.press(KEY.enter);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.model-selector.txt",
        );
        ui.type("gpt");
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.model-selector-filtered.txt",
        );
        ui.press(KEY.enter);
        await vi.waitFor(() => expect(changed).toEqual({ agent: "scout", model: "openai/gpt-4.1" }));
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/agent-session-browser.settings-model-selected.txt",
        );
    });
});
