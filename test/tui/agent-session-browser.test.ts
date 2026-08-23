import { describe, expect, it } from "vitest";

import {
    AgentSessionBrowserComponent,
} from "../../src/tui/agent-session-browser";
import { KEY, mockTheme, press, renderText } from "../helpers";

const current = {
    kind: "current" as const,
    id: "scout-1",
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

describe("AgentSessionBrowserComponent", () => {
    it("shows current runs and expands selected metadata", () => {
        const value = component();
        expect(renderText(value, 100)).toContain("[Current]");
        expect(renderText(value, 100)).toContain("scout · running");

        press(value, KEY.enter);
        const rendered = renderText(value, 100);
        expect(rendered).toContain("Transcript: no durable transcript");
        expect(rendered).toContain("This browser is read-only");
    });

    it("switches to past transcripts and closes in two escape presses when expanded", () => {
        const value = component();
        let closed = false;
        value.setDoneCallback(() => { closed = true; });

        press(value, KEY.tab);
        expect(renderText(value, 100)).toContain("[Past]");
        expect(renderText(value, 100)).toContain("persisted transcript");

        press(value, KEY.enter, KEY.escape);
        expect(renderText(value, 100)).toContain("Review the previous implementation");
        press(value, KEY.escape);
        expect(closed).toBe(true);
    });
});
