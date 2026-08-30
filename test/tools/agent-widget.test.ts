import { describe, expect, it } from "vitest";
import { AgentActivityWidget, firstLinePreview, formatToolCounts } from "../../src/tui/status";

const runningRun = {
    runId: "scout-1",
    title: "Inspect the project",
    agent: "scout",
    status: "running",
    background: true,
    task: "Inspect the project",
    startedAt: Date.now() - 18_000,
    updatedAt: Date.now(),
    phase: "Thinking",
    responsePreview: "I found the entry points.\nThe next section is less relevant.",
    activity: 'Searching "widget" in src',
    lastToolActivity: "Reading src/index.ts",
    todo: { completed: 2, total: 5, current: "Implement the feature" },
    toolCounts: { read: 4, grep: 2 },
    usage: {},
} as any;

describe("agent activity widget", () => {
    it("formats grouped tool counts", () => {
        expect(formatToolCounts({ read: 4, grep: 1, find: 1, bash: 2 })).toBe(
            "4 reads · 2 searches · 2 commands",
        );
    });

    it("uses only the first assistant line", () => {
        expect(firstLinePreview("First line\nsecond line", 20)).toBe("First line");
    });

    it("renders a spinner, assistant preview, and tool summary", () => {
        const widget = new AgentActivityWidget({ requestRender() {} } as any, [runningRun]);

        expect(widget.render(200)).toEqual([
            expect.stringMatching(/^ ⠋ scout-1 · 00:18 · I found the entry points\. $/),
            '   4 reads · 2 searches · Searching "widget" in src · TODO 2/5 · Implement the feature ',
        ]);

        widget.dispose();
    });
});
