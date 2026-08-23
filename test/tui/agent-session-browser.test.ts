import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    AgentSessionBrowserComponent,
} from "../../src/tui/agent-session-browser";
import { KEY, interact, mockTheme, press, renderText } from "../helpers";

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

function snapshotText(text: string): string {
    return text.replace(/[ \t]+$/gm, "");
}

beforeEach(() => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("Nov 14 2023 22:13");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("AgentSessionBrowserComponent", () => {
    it("renders the current tab", () => {
        const value = component();

        expect(snapshotText(renderText(value, 100))).toMatchInlineSnapshot(`
          "╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
          │   Delegated agent sessions                                                                       │
          │                                                                                                  │
          │ ● Current    ○ Past                                                                              │
          │ Current shows this parent session; Past shows durable child results for this cwd.                │
          │                                                                                                  │
          │   → Project structure audit · scout · running · Nov 14 2023 22:13                                │
          │     Task: Inspect the project structure · Reading files                                          │
          │     Result: I found the main entry points and summarized the current architecture.               │
          │   1 session                                                                                      │
          │                                                                                                  │
          │     ↑/↓ navigate · Tab/←/→ switch tab · Enter open · Esc close                                   │
          │                                                                                                  │
          ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯"
        `);
    });

    it("opens a separate detail view with metadata and transcript", () => {
        const value = component();
        const ui = interact(value, 100);

        ui.press(KEY.enter);

        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
          │   Delegated agent session                                                                        │
          │                                                                                                  │
          │   Project structure audit · scout · running                                                      │
          │   Run ID: scout-1                                                                                │
          │   Task: Inspect the project structure                                                            │
          │   Started: Nov 14 2023 22:13                                                                     │
          │   Updated: Nov 14 2023 22:13                                                                     │
          │   Usage: 1.2k input, 2m output, $0.0300                                                          │
          │                                                                                                  │
          │   Transcript:                                                                                    │
          │   I found the main entry points and summarized the current architecture.                         │
          │                                                                                                  │
          │     ↑/↓ scroll · Esc back                                                                        │
          │                                                                                                  │
          ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯"
        `);
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

    it("switches tabs and renders the past result entry", () => {
        const value = component();
        const ui = interact(value, 100);

        ui.press(KEY.tab);

        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
          │   Delegated agent sessions                                                                       │
          │                                                                                                  │
          │ ○ Current    ● Past                                                                              │
          │ Current shows this parent session; Past shows durable child results for this cwd.                │
          │                                                                                                  │
          │   → Previous implementation review · delegated agent · completed · Nov 14 2023 22:13             │
          │     Task: Review the previous implementation                                                     │
          │     Result: The previous implementation is persisted and can be browsed read-only.               │
          │   1 session                                                                                      │
          │                                                                                                  │
          │     ↑/↓ navigate · Tab/←/→ switch tab · Enter open · Esc close                                   │
          │                                                                                                  │
          ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯"
        `);
    });

    it("uses left and right for directional tab selection", () => {
        const value = component();
        const ui = interact(value, 100);

        ui.press(KEY.right);
        expect(ui.render()).toContain("○ Current    ● Past");
        ui.press(KEY.left);
        expect(ui.render()).toContain("● Current    ○ Past");
    });

    it("renders empty current and past tabs", () => {
        const value = new AgentSessionBrowserComponent({ current: [], past: [] });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
          │   Delegated agent sessions                                                                       │
          │                                                                                                  │
          │ ● Current    ○ Past                                                                              │
          │ Current shows this parent session; Past shows durable child results for this cwd.                │
          │                                                                                                  │
          │     No delegated agents are active in this parent session.                                       │
          │   0 sessions                                                                                     │
          │                                                                                                  │
          │     ↑/↓ navigate · Tab/←/→ switch tab · Enter open · Esc close                                   │
          │                                                                                                  │
          ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯"
        `);
        ui.press(KEY.tab);
        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
          │   Delegated agent sessions                                                                       │
          │                                                                                                  │
          │ ○ Current    ● Past                                                                              │
          │ Current shows this parent session; Past shows durable child results for this cwd.                │
          │                                                                                                  │
          │     No persisted child sessions were found for this cwd.                                         │
          │   0 sessions                                                                                     │
          │                                                                                                  │
          │     ↑/↓ navigate · Tab/←/→ switch tab · Enter open · Esc close                                   │
          │                                                                                                  │
          ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯"
        `);
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
});
