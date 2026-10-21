/**
 * Shared fixture builders for the `/stats` suites. These mirror the shapes the scanner produces,
 * so aggregate and view tests can start from data instead of JSONL files.
 */

import type { DailyActivity, SessionRecord, UsageTotals } from "../../../src/commands/stats/types";
import { emptyUsageTotals } from "../../../src/commands/stats/usage";

export function usageTotals(
    input: number,
    output: number,
    cost = 0,
    cache: { read?: number; write?: number } = {},
): UsageTotals {
    return {
        input,
        output,
        cacheRead: cache.read ?? 0,
        cacheWrite: cache.write ?? 0,
        cost,
    };
}

export function makeDay(date: string, overrides: Partial<DailyActivity> = {}): DailyActivity {
    return {
        date,
        messages: 0,
        sessions: 0,
        toolCalls: 0,
        hours: Array.from({ length: 24 }, () => 0),
        usageByModel: {},
        usageBySource: { parent: emptyUsageTotals(), child: emptyUsageTotals() },
        ...overrides,
    };
}

export function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        sessionId: "session",
        source: "parent",
        startTimestampMs: 0,
        startDate: "2026-03-10",
        durationMs: 1_000,
        messages: 2,
        toolCalls: 0,
        ...overrides,
    };
}

export function hourAt(hour: number): number[] {
    const hours = Array.from({ length: 24 }, () => 0);
    hours[hour] = 1;
    return hours;
}

/** ISO timestamp for a local wall-clock time, keeping day bucketing timezone-independent. */
export function localIso(
    year: number,
    month: number,
    day: number,
    hour = 9,
    minute = 0,
    second = 0,
): string {
    return new Date(year, month - 1, day, hour, minute, second).toISOString();
}
