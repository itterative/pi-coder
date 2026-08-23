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
};

const past = {
    kind: "past" as const,
    id: "child-session-1",
    title: "Previous implementation review",
    agent: "delegated agent",
    status: "persisted transcript",
    task: "Review the previous implementation",
    updatedAt: 1_700_000_002_000,
    sessionFile: "/tmp/.state/agent-sessions/--cwd--/parent/child-session-1.jsonl",
    parentSessionId: "parent",
    messageCount: 4,
    firstMessage: "Review the previous implementation",
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
          "────────────────────────────────────────────────────────────────────────────────────────────────────
             Delegated agent sessions

           Current shows this parent session; Past shows durable child transcripts for this cwd.

             → Project structure audit · scout · running · Nov 14 2023 22:13
               Task: Inspect the project structure · Reading files
             [Current]     Past
             1 session

               ↑/↓ navigate · Tab/←/→ switch tab · Enter details · Esc close

          ────────────────────────────────────────────────────────────────────────────────────────────────────"
        `);
    });

    it("expands the selected run with metadata and transcript guidance", () => {
        const value = component();
        const ui = interact(value, 100);

        ui.press(KEY.enter);

        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "────────────────────────────────────────────────────────────────────────────────────────────────────
             Delegated agent sessions

           Current shows this parent session; Past shows durable child transcripts for this cwd.

             → Project structure audit · scout · running · Nov 14 2023 22:13
               Run ID: scout-1
               Task: Inspect the project structure
               Started: Nov 14 2023 22:13
               Updated: Nov 14 2023 22:13
               Transcript: no durable transcript

               This browser is read-only; it does not switch or replay child sessions.
             [Current]     Past
             1 session

               ↑/↓ navigate · Tab/←/→ switch tab · Enter details · Esc close

          ────────────────────────────────────────────────────────────────────────────────────────────────────"
        `);
    });

    it("switches tabs and renders the past transcript entry", () => {
        const value = component();
        const ui = interact(value, 100);

        ui.press(KEY.tab);

        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "────────────────────────────────────────────────────────────────────────────────────────────────────
             Delegated agent sessions

           Current shows this parent session; Past shows durable child transcripts for this cwd.

             → Previous implementation review · delegated agent · persisted transcript · Nov 14 2023 22:13
               Task: Review the previous implementation
              Current     [Past]
             1 session

               ↑/↓ navigate · Tab/←/→ switch tab · Enter details · Esc close

          ────────────────────────────────────────────────────────────────────────────────────────────────────"
        `);
    });

    it("renders empty current and past tabs", () => {
        const value = new AgentSessionBrowserComponent({ current: [], past: [] });
        value.initialize(mockTheme);
        const ui = interact(value, 100);

        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "────────────────────────────────────────────────────────────────────────────────────────────────────
             Delegated agent sessions

           Current shows this parent session; Past shows durable child transcripts for this cwd.

             → No delegated agents are active in this parent session.
             [Current]     Past
             0 sessions

               ↑/↓ navigate · Tab/←/→ switch tab · Enter details · Esc close

          ────────────────────────────────────────────────────────────────────────────────────────────────────"
        `);
        ui.press(KEY.tab);
        expect(snapshotText(ui.render())).toMatchInlineSnapshot(`
          "────────────────────────────────────────────────────────────────────────────────────────────────────
             Delegated agent sessions

           Current shows this parent session; Past shows durable child transcripts for this cwd.

             → No persisted child transcripts were found for this cwd.
              Current     [Past]
             0 sessions

               ↑/↓ navigate · Tab/←/→ switch tab · Enter details · Esc close

          ────────────────────────────────────────────────────────────────────────────────────────────────────"
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
