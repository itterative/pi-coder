import { describe, expect, it } from "vitest";

import { aggregateStats } from "../../../src/commands/stats/aggregate";
import { presetRange } from "../../../src/commands/stats/range";
import type { ScanResult, StatsRange } from "../../../src/commands/stats/types";
import { emptyUsageTotals } from "../../../src/commands/stats/usage";
import { hourAt, makeDay, makeSession, usageTotals } from "./fixtures";

const TODAY = new Date(2026, 2, 10, 12, 0, 0);

function customRange(start: string, end: string): StatsRange {
    return { preset: "custom", start, end, label: "test range" };
}

const scan: ScanResult = {
    dailyActivity: [
        makeDay("2026-03-08", { messages: 5, sessions: 1, toolCalls: 2, hours: hourAt(9) }),
        makeDay("2026-03-09", { messages: 3, sessions: 1, hours: hourAt(9) }),
        makeDay("2026-03-10", { messages: 7, sessions: 1, toolCalls: 1, hours: hourAt(10) }),
        makeDay("2026-03-11", { messages: 1, sessions: 1, hours: hourAt(14) }),
    ],
    sessions: [
        makeSession({
            sessionId: "a",
            startTimestampMs: 1,
            startDate: "2026-03-08",
            durationMs: 1_000,
        }),
        makeSession({
            sessionId: "b",
            startTimestampMs: 2,
            startDate: "2026-03-09",
            durationMs: 9_000,
            source: "child",
        }),
        makeSession({
            sessionId: "c",
            startTimestampMs: 3,
            startDate: "2026-03-10",
            durationMs: 4_000,
        }),
        makeSession({
            sessionId: "d",
            startTimestampMs: 4,
            startDate: "2026-03-11",
            durationMs: 100,
        }),
    ],
    totalFiles: 4,
};

describe("aggregateStats", () => {
    it("filters days and sessions to the range", () => {
        const stats = aggregateStats(scan, customRange("2026-03-09", "2026-03-10"), TODAY);

        expect(stats.totalSessions).toBe(2);
        expect(stats.parentSessions).toBe(1);
        expect(stats.childSessions).toBe(1);
        expect(stats.totalMessages).toBe(10);
        expect(stats.totalToolCalls).toBe(1);
        expect(stats.rangeDays).toBe(2);
        expect(stats.activeDays).toBe(2);
        expect(stats.longestSession?.sessionId).toBe("b");
        expect(stats.peakActivityDay).toBe("2026-03-10");
        expect(stats.peakActivityHour).toBe(9);
        expect(stats.firstSessionDate).toBe("2026-03-09");
        expect(stats.lastSessionDate).toBe("2026-03-10");
        expect(stats.dailyActivity.map((day) => day.date)).toEqual(["2026-03-09", "2026-03-10"]);
    });

    it("computes streaks bounded by the range", () => {
        const bounded = aggregateStats(scan, customRange("2026-03-09", "2026-03-10"), TODAY);
        expect(bounded.streaks).toEqual({
            currentStreak: 2,
            longestStreak: 2,
            currentStreakStart: "2026-03-09",
            longestStreakStart: "2026-03-09",
            longestStreakEnd: "2026-03-10",
        });

        const all = aggregateStats(scan, presetRange("all", TODAY), TODAY);
        expect(all.streaks.currentStreak).toBe(3);
        expect(all.streaks.longestStreak).toBe(3);
        // The all-time window still ends at the anchor day, so the future fixture day is cut.
        expect(all.rangeDays).toBe(3);
    });

    it("sums model and source usage only from days inside the range", () => {
        const usageScan: ScanResult = {
            dailyActivity: [
                makeDay("2026-03-09", {
                    usageByModel: { "model-a": usageTotals(10, 5, 0.1, { read: 1, write: 2 }) },
                    usageBySource: {
                        parent: usageTotals(10, 5, 0.1, { read: 1, write: 2 }),
                        child: emptyUsageTotals(),
                    },
                }),
                makeDay("2026-03-10", {
                    usageByModel: {
                        "model-a": usageTotals(1, 1, 0.01),
                        "model-b": usageTotals(2, 3, 0.02),
                    },
                    usageBySource: {
                        parent: emptyUsageTotals(),
                        child: usageTotals(3, 4, 0.03),
                    },
                }),
            ],
            sessions: [
                makeSession({ startDate: "2026-03-09", startTimestampMs: 1, source: "parent" }),
                makeSession({ startDate: "2026-03-10", startTimestampMs: 2, source: "child" }),
            ],
            totalFiles: 2,
        };

        const stats = aggregateStats(usageScan, customRange("2026-03-10", "2026-03-10"), TODAY);

        expect(stats.modelUsage).toEqual({
            "model-a": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            "model-b": { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
        });
        expect(stats.usageBySource.parent).toEqual(emptyUsageTotals());
        expect(stats.usageBySource.child).toEqual({
            input: 3,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.03,
        });
    });

    it("keeps an explicit range width even with no activity", () => {
        const stats = aggregateStats(
            { dailyActivity: [], sessions: [], totalFiles: 0 },
            customRange("2026-03-01", "2026-03-10"),
            TODAY,
        );

        expect(stats.rangeDays).toBe(10);
        expect(stats.activeDays).toBe(0);
        expect(stats.totalSessions).toBe(0);
        expect(stats.longestSession).toBeNull();
        expect(stats.streaks.currentStreak).toBe(0);
        expect(stats.peakActivityDay).toBeNull();
        expect(stats.peakActivityHour).toBeNull();
    });
});
