import { describe, expect, it } from "vitest";

import { presetRange } from "../../../src/commands/stats/range";
import type { ScanResult } from "../../../src/commands/stats/types";
import { emptyUsageTotals } from "../../../src/commands/stats/usage";
import { StatsReportView } from "../../../src/commands/stats/view";
import { KEY, mockTheme, press, renderText, snapshotText } from "../../helpers";
import { hourAt, makeDay, makeSession, usageTotals } from "./fixtures";

const TODAY = new Date(2026, 2, 15, 12, 0, 0);
const MODEL = "claude-sonnet-4-5-20250929";

const scan: ScanResult = {
    dailyActivity: [
        makeDay("2026-03-01", {
            messages: 20,
            sessions: 3,
            toolCalls: 6,
            hours: hourAt(11),
            usageByModel: {
                [MODEL]: usageTotals(500_000, 120_000, 4.5, { read: 2_000_000, write: 40_000 }),
            },
            usageBySource: {
                parent: usageTotals(500_000, 120_000, 4.5, {
                    read: 2_000_000,
                    write: 40_000,
                }),
                child: emptyUsageTotals(),
            },
        }),
        makeDay("2026-03-09", {
            messages: 12,
            sessions: 2,
            toolCalls: 4,
            hours: hourAt(9),
            usageByModel: {
                [MODEL]: usageTotals(120_000, 40_000, 1.25, { read: 800_000, write: 20_000 }),
            },
            usageBySource: {
                parent: usageTotals(120_000, 40_000, 1.25, {
                    read: 800_000,
                    write: 20_000,
                }),
                child: emptyUsageTotals(),
            },
        }),
        makeDay("2026-03-10", {
            messages: 6,
            sessions: 1,
            hours: hourAt(14),
            usageByModel: { "gpt-5.6-luna": usageTotals(30_000, 12_000, 0.4) },
            usageBySource: {
                parent: usageTotals(30_000, 12_000, 0.4),
                child: emptyUsageTotals(),
            },
        }),
        makeDay("2026-03-12", {
            messages: 3,
            sessions: 1,
            hours: hourAt(10),
            usageByModel: { [MODEL]: usageTotals(8_000, 4_000, 0.12) },
            usageBySource: { parent: emptyUsageTotals(), child: usageTotals(8_000, 4_000, 0.12) },
        }),
        makeDay("2026-03-15", {
            messages: 9,
            sessions: 1,
            hours: hourAt(10),
            usageByModel: { [MODEL]: usageTotals(60_000, 25_000, 0.75) },
            usageBySource: {
                parent: usageTotals(60_000, 25_000, 0.75),
                child: emptyUsageTotals(),
            },
        }),
    ],
    sessions: [
        makeSession({
            sessionId: "parent-early",
            startTimestampMs: 0,
            startDate: "2026-03-01",
            durationMs: 1_800_000,
            messages: 20,
            toolCalls: 6,
        }),
        makeSession({
            sessionId: "parent-1",
            startTimestampMs: 1,
            startDate: "2026-03-09",
            durationMs: 7_200_000,
            messages: 12,
            toolCalls: 4,
        }),
        makeSession({
            sessionId: "child-1",
            startTimestampMs: 2,
            startDate: "2026-03-12",
            durationMs: 300_000,
            messages: 3,
            source: "child",
        }),
        makeSession({
            sessionId: "parent-2",
            startTimestampMs: 3,
            startDate: "2026-03-15",
            durationMs: 60_000,
            messages: 9,
        }),
    ],
    totalFiles: 4,
};

function setup(): StatsReportView {
    const view = new StatsReportView(scan, presetRange("7d", TODAY), TODAY, mockTheme);
    view.initialize(mockTheme);
    return view;
}

describe("StatsReportView", () => {
    it("renders the 7-day report", async () => {
        const view = setup();
        await expect(snapshotText(renderText(view, 80))).toMatchFileSnapshot(
            "__snapshots__/stats.report-7d.txt",
        );
    });

    it("cycles to the all-time report with r", async () => {
        const view = setup();
        renderText(view, 80);
        press(view, "r");

        expect(view.state.items.length).toBeGreaterThan(0);
        await expect(snapshotText(renderText(view, 80))).toMatchFileSnapshot(
            "__snapshots__/stats.report-all.txt",
        );
    });

    it("renders the models section after scrolling", async () => {
        const view = setup();
        renderText(view, 80);
        press(view, KEY.pageDown, KEY.pageDown);
        await expect(snapshotText(renderText(view, 80))).toMatchFileSnapshot(
            "__snapshots__/stats.report-scrolled.txt",
        );
    });

    it("scrolls with arrow and page keys", () => {
        const view = setup();
        renderText(view, 80);

        press(view, KEY.down, KEY.down);
        expect(view.state.scrollOffset).toBe(2);

        press(view, KEY.pageDown);
        expect(view.state.scrollOffset).toBeGreaterThan(2);

        press(view, KEY.pageUp, KEY.up, KEY.up, KEY.up);
        expect(view.state.scrollOffset).toBe(0);
    });
});
