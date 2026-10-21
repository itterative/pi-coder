/**
 * Shared types for the `/stats` command.
 *
 * A scan keeps per-day buckets and per-session records, so every supported range can be aggregated
 * from memory without touching disk again.
 */

/** Where a transcript came from. */
export type StatsSource = "parent" | "child";

/** Built-in range presets, also the `r` cycle order. */
export type RangePreset = "all" | "30d" | "7d";

/** A closed local-date window; `start: null` means unbounded. */
export interface StatsRange {
    preset: RangePreset | "custom";
    /** Inclusive local `YYYY-MM-DD` lower bound, or null for all history. */
    start: string | null;
    /** Inclusive local `YYYY-MM-DD` upper bound. */
    end: string;
    /** Human-readable label for the dialog title and report footer. */
    label: string;
}

/** Token and cost totals: the subset of pi's `Usage` that stats reports. */
export interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

export type ModelUsage = Record<string, UsageTotals>;

/** One local calendar day of activity, accumulated across parent and child sessions. */
export interface DailyActivity {
    date: string;
    messages: number;
    /** Sessions whose first message landed on this day. */
    sessions: number;
    toolCalls: number;
    /** Sessions started in each local hour, indexed 0-23. */
    hours: number[];
    usageByModel: ModelUsage;
    usageBySource: Record<StatsSource, UsageTotals>;
}

/** Per-transcript totals used for session counts, the longest session, and streaks. */
export interface SessionRecord {
    sessionId: string;
    source: StatsSource;
    startTimestampMs: number;
    startDate: string;
    durationMs: number;
    messages: number;
    toolCalls: number;
}

/** Everything one scan collected; every range is aggregated from this. */
export interface ScanResult {
    dailyActivity: DailyActivity[];
    sessions: SessionRecord[];
    /** JSONL files considered by the scan. */
    totalFiles: number;
}

export interface ScanProgress {
    scanned: number;
    total: number;
}

export interface ScanOptions {
    parentRoot: string;
    childRoot: string;
    signal?: AbortSignal;
    onProgress?: (progress: ScanProgress) => void;
}

export interface StreakInfo {
    currentStreak: number;
    longestStreak: number;
    currentStreakStart: string | null;
    longestStreakStart: string | null;
    longestStreakEnd: string | null;
}

/** Aggregated stats for one range. */
export interface PiStats {
    range: StatsRange;
    totalSessions: number;
    parentSessions: number;
    childSessions: number;
    totalMessages: number;
    totalToolCalls: number;
    /** Inclusive day count of the range; for all-time this spans first to last activity. */
    rangeDays: number;
    activeDays: number;
    streaks: StreakInfo;
    /** Days inside the range, sorted ascending. */
    dailyActivity: DailyActivity[];
    longestSession: SessionRecord | null;
    modelUsage: ModelUsage;
    usageBySource: Record<StatsSource, UsageTotals>;
    firstSessionDate: string | null;
    lastSessionDate: string | null;
    peakActivityDay: string | null;
    peakActivityHour: number | null;
}
