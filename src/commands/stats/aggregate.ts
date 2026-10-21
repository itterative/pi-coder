/**
 * Aggregation for `/stats`: derive one range's totals from the scan's day buckets and session
 * records. Pure and disk-free, so the dialog can switch ranges instantly after the initial scan.
 */

import { parseLocalDate, toLocalDateString } from "./range";
import type {
    DailyActivity,
    ModelUsage,
    PiStats,
    ScanResult,
    SessionRecord,
    StatsRange,
    StreakInfo,
    UsageTotals,
} from "./types";
import { addUsageTotals, emptyUsageTotals, ensureModelUsage } from "./usage";

const DAY_MS = 86_400_000;

export function aggregateStats(scan: ScanResult, range: StatsRange, today: Date): PiStats {
    const days = scan.dailyActivity.filter((day) => dateInRange(day.date, range));
    const sessions = scan.sessions.filter((session) => dateInRange(session.startDate, range));

    const modelUsage: ModelUsage = {};
    const usageBySource: Record<"parent" | "child", UsageTotals> = {
        parent: emptyUsageTotals(),
        child: emptyUsageTotals(),
    };
    let totalMessages = 0;
    let totalToolCalls = 0;
    let activeDays = 0;

    for (const day of days) {
        totalMessages += day.messages;
        totalToolCalls += day.toolCalls;
        if (day.messages > 0) {
            activeDays++;
        }

        for (const [model, usage] of Object.entries(day.usageByModel)) {
            addUsageTotals(ensureModelUsage(modelUsage, model), usage);
        }
        addUsageTotals(usageBySource.parent, day.usageBySource.parent);
        addUsageTotals(usageBySource.child, day.usageBySource.child);
    }

    return {
        range,
        totalSessions: sessions.length,
        parentSessions: sessions.filter((session) => session.source === "parent").length,
        childSessions: sessions.filter((session) => session.source === "child").length,
        totalMessages,
        totalToolCalls,
        rangeDays: rangeDayCount(days, range),
        activeDays,
        streaks: calculateStreaks(days, today),
        dailyActivity: days,
        longestSession: longestSession(sessions),
        modelUsage,
        usageBySource,
        firstSessionDate: sessions[0]?.startDate ?? null,
        lastSessionDate: sessions.at(-1)?.startDate ?? null,
        peakActivityDay: peakActivityDay(days),
        peakActivityHour: peakActivityHour(days),
    };
}

function dateInRange(date: string, range: StatsRange): boolean {
    if (range.start !== null && date < range.start) {
        return false;
    }

    return date <= range.end;
}

function rangeDayCount(days: DailyActivity[], range: StatsRange): number {
    const start = range.start === null ? firstDate(days) : parseLocalDate(range.start);
    const end = range.start === null ? lastDate(days) : parseLocalDate(range.end);
    if (!start || !end) {
        return 0;
    }

    return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

function firstDate(days: DailyActivity[]): Date | null {
    const day = days[0];
    return day ? parseLocalDate(day.date) : null;
}

function lastDate(days: DailyActivity[]): Date | null {
    const day = days.at(-1);
    return day ? parseLocalDate(day.date) : null;
}

function longestSession(sessions: SessionRecord[]): SessionRecord | null {
    let longest: SessionRecord | null = null;
    for (const session of sessions) {
        if (!longest || session.durationMs > longest.durationMs) {
            longest = session;
        }
    }

    return longest;
}

function peakActivityDay(days: DailyActivity[]): string | null {
    let peak: DailyActivity | null = null;
    for (const day of days) {
        if (day.messages > 0 && (!peak || day.messages > peak.messages)) {
            peak = day;
        }
    }

    return peak?.date ?? null;
}

function peakActivityHour(days: DailyActivity[]): number | null {
    const totals = Array.from({ length: 24 }, () => 0);
    for (const day of days) {
        for (let hour = 0; hour < totals.length; hour++) {
            totals[hour]! += day.hours[hour]!;
        }
    }

    let peak: number | null = null;
    for (let hour = 0; hour < totals.length; hour++) {
        if (totals[hour]! > 0 && (peak === null || totals[hour]! > totals[peak]!)) {
            peak = hour;
        }
    }

    return peak;
}

function calculateStreaks(days: DailyActivity[], today: Date): StreakInfo {
    const active = new Set(days.filter((day) => day.messages > 0).map((day) => day.date));

    let currentStreak = 0;
    let currentStreakStart: string | null = null;
    const cursor = new Date(today);
    cursor.setHours(0, 0, 0, 0);
    while (active.has(toLocalDateString(cursor))) {
        currentStreakStart = toLocalDateString(cursor);
        currentStreak++;
        cursor.setDate(cursor.getDate() - 1);
    }

    const sorted = [...active].sort();
    let longestStreak = 0;
    let longestStreakStart: string | null = null;
    let longestStreakEnd: string | null = null;
    let runStart: string | null = null;
    let previous: string | null = null;
    let run = 0;
    for (const date of sorted) {
        const consecutive = previous !== null && isNextDay(previous, date);
        run = consecutive ? run + 1 : 1;
        runStart = consecutive ? runStart : date;

        if (run > longestStreak) {
            longestStreak = run;
            longestStreakStart = runStart;
            longestStreakEnd = date;
        }
        previous = date;
    }

    return {
        currentStreak,
        longestStreak,
        currentStreakStart,
        longestStreakStart,
        longestStreakEnd,
    };
}

function isNextDay(previous: string, next: string): boolean {
    const previousDate = parseLocalDate(previous);
    const nextDate = parseLocalDate(next);
    if (!previousDate || !nextDate) {
        return false;
    }

    return Math.round((nextDate.getTime() - previousDate.getTime()) / DAY_MS) === 1;
}
