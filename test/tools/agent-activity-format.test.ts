import { describe, expect, it } from "vitest";

import { formatAgentSummary } from "../../src/tui/status";
import { partialRun } from "../helpers/agent-doubles";

describe("agent activity summary", () => {
    it("shows the running run with elapsed time and phase", () => {
        const run = partialRun({
            runId: "scout-1",
            agent: "scout",
            status: "running",
            startedAt: Date.now() - 18_000,
            phase: "Thinking",
        });

        expect(formatAgentSummary([run], 0, "⠋")).toMatch(/^⠋ scout-1 · 00:18 · Thinking$/);
    });

    it("prefers the latest assistant preview over the phase", () => {
        const run = partialRun({
            runId: "scout-1",
            status: "running",
            startedAt: Date.now(),
            phase: "Thinking",
            responsePreview: "I found the entry points.\nThe next section is less relevant.",
        });

        expect(formatAgentSummary([run], 0, "⠋")).toMatch(
            /^⠋ scout-1 · 00:00 · I found the entry points\.$/,
        );
    });

    it("prioritizes waiting runs over running ones", () => {
        const running = partialRun({ runId: "worker-1", status: "running", startedAt: Date.now() });
        const waiting = partialRun({
            runId: "worker-2",
            status: "waiting_for_permission",
            updatedAt: 100,
        });

        expect(formatAgentSummary([running, waiting], 0, "⠋")).toBe(
            "? worker-2 · waiting for permission +1",
        );
    });

    it("distinguishes parent questions and interrupted runs", () => {
        const parent = partialRun({ runId: "worker-1", status: "waiting_for_parent" });
        const interrupted = partialRun({ runId: "worker-2", status: "interrupted", updatedAt: 50 });

        expect(formatAgentSummary([parent], 0, "⠋")).toBe("? worker-1 · waiting for you");
        expect(formatAgentSummary([interrupted], 0, "⠋")).toBe("! worker-2 · interrupted");
    });

    it("summarizes terminal results by severity", () => {
        const completed = partialRun({ runId: "worker-1", status: "completed" });
        const failed = partialRun({ runId: "worker-2", status: "failed", updatedAt: 100 });

        expect(formatAgentSummary([completed, failed], 0, "⠋")).toBe("! worker-2 · failed +1");
        expect(formatAgentSummary([completed], 0, "⠋")).toBe("✓ worker-1 · ready");
    });

    it("counts additional visible and hidden runs", () => {
        const running = partialRun({ runId: "worker-1", status: "running", startedAt: Date.now() });

        expect(formatAgentSummary([running], 2, "⠋")).toMatch(/ \+2$/);
    });

    it("returns nothing when there is no agent to show", () => {
        expect(formatAgentSummary([], 0, "⠋")).toBe("");
        expect(formatAgentSummary([], 3, "⠋")).toBe("… 3 hidden");
    });
});
