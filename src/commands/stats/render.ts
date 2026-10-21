/**
 * Report rendering for `/stats` (pure functions returning styled lines).
 *
 * The dialog renders one item per line through the shared pager, so nothing here needs to know the
 * terminal width: long lines wrap in the list view, and chart widths are fixed for a stable layout.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatTokens } from "../../tui/status/footer-info";
import { addDays, formatShortDate, toLocalDateString } from "./range";
import type { DailyActivity, ModelUsage, PiStats, RangePreset, StatsRange } from "./types";
import { cachedTokens, freshTokens } from "./usage";

/** The theme surface the report uses; `Theme` satisfies it, tests pass an identity double. */
export type ReportTheme = Pick<Theme, "fg" | "bold">;

export const identityReportTheme: ReportTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
};

const COLUMN_WIDTH = 36;
const SEPARATOR_WIDTH = 62;
const HEATMAP_WEEKS = 52;
const CHART_HEIGHT = 4;
const CHART_WIDTH = 52;

const HEAT_SYMBOLS = ["·", "░", "▒", "▓", "█"] as const;
const SPARK_CHARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const MONTH_NAMES = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
] as const;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const PRESET_ORDER: RangePreset[] = ["all", "30d", "7d"];
const PRESET_LABELS: Record<RangePreset, string> = {
    all: "All time",
    "30d": "Last 30 days",
    "7d": "Last 7 days",
};

const BOOKS = [
    { title: "The Little Prince", tokens: 22_000 },
    { title: "The Old Man and the Sea", tokens: 35_000 },
    { title: "Animal Farm", tokens: 39_000 },
    { title: "Fahrenheit 451", tokens: 60_000 },
    { title: "The Great Gatsby", tokens: 62_000 },
    { title: "Brave New World", tokens: 83_000 },
    { title: "The Catcher in the Rye", tokens: 95_000 },
    { title: "The Hobbit", tokens: 123_000 },
    { title: "1984", tokens: 123_000 },
    { title: "To Kill a Mockingbird", tokens: 130_000 },
    { title: "Pride and Prejudice", tokens: 156_000 },
    { title: "Dune", tokens: 244_000 },
    { title: "Moby-Dick", tokens: 268_000 },
    { title: "Crime and Punishment", tokens: 274_000 },
    { title: "A Game of Thrones", tokens: 381_000 },
    { title: "Anna Karenina", tokens: 468_000 },
    { title: "Don Quixote", tokens: 520_000 },
    { title: "The Lord of the Rings", tokens: 576_000 },
    { title: "The Count of Monte Cristo", tokens: 603_000 },
    { title: "Les Misérables", tokens: 689_000 },
    { title: "War and Peace", tokens: 730_000 },
];

const TIMES = [
    { title: "a TED talk", minutes: 18 },
    { title: "an episode of The Office", minutes: 22 },
    { title: "a yoga class", minutes: 60 },
    { title: "a World Cup match", minutes: 90 },
    { title: "a half marathon (avg)", minutes: 120 },
    { title: "the movie Inception", minutes: 148 },
    { title: "watching Titanic", minutes: 195 },
    { title: "a transatlantic flight", minutes: 420 },
    { title: "a full night of sleep", minutes: 480 },
];

/** Build every styled line of the report, in display order. */
export function buildReportLines(
    stats: PiStats,
    allStats: PiStats,
    theme: ReportTheme,
    today: Date,
): string[] {
    const lines: string[] = [];
    lines.push(...heatmapLines(allStats.dailyActivity, theme, today));
    lines.push("");
    lines.push(presetLine(stats.range, theme));
    lines.push("");
    lines.push(...summaryLines(stats, theme));

    const fact = funFact(stats);
    if (fact) {
        lines.push("");
        lines.push(theme.fg("accent", fact));
    }

    lines.push("");
    lines.push(separator(theme));
    lines.push(...modelSectionLines(stats, theme));
    lines.push(separator(theme));
    lines.push(theme.fg("dim", rangeFootnote(stats)));
    return lines;
}

function separator(theme: ReportTheme): string {
    return theme.fg("dim", "─".repeat(SEPARATOR_WIDTH));
}

function heatmapLines(daily: DailyActivity[], theme: ReportTheme, today: Date): string[] {
    if (daily.length === 0) {
        return [theme.fg("dim", "No activity recorded.")];
    }

    const byDate = new Map(daily.map((day) => [day.date, day.messages]));
    const thresholds = quartileThresholds(daily);

    const anchor = new Date(today);
    anchor.setHours(0, 0, 0, 0);
    const weekStart = addDays(anchor, -anchor.getDay());
    const start = addDays(weekStart, -(HEATMAP_WEEKS - 1) * 7);

    const lines: string[] = [monthHeader(start)];
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
        let row = "";
        for (let week = 0; week < HEATMAP_WEEKS; week++) {
            const date = addDays(start, week * 7 + dayOfWeek);
            if (date.getTime() > anchor.getTime()) {
                row += " ";
                continue;
            }

            const count = byDate.get(toLocalDateString(date)) ?? 0;
            row += intensitySymbol(count, thresholds, theme);
        }

        const dayLabel = DAY_LABELS[dayOfWeek]!;
        lines.push((dayOfWeek % 2 === 1 ? dayLabel : "   ") + " " + row);
    }

    lines.push("");
    lines.push(
        `    Less ${theme.fg("accent", "░")} ${theme.fg("accent", "▒")} ${theme.fg("accent", "▓")} ${theme.fg("accent", "█")} More`,
    );
    return lines;
}

interface IntensityThresholds {
    p25: number;
    p50: number;
    p75: number;
}

function quartileThresholds(daily: DailyActivity[]): IntensityThresholds {
    const counts = daily
        .filter((day) => day.messages > 0)
        .map((day) => day.messages)
        .sort((left, right) => left - right);

    return {
        p25: percentile(counts, 0.25),
        p50: percentile(counts, 0.5),
        p75: percentile(counts, 0.75),
    };
}

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function intensitySymbol(
    count: number,
    thresholds: IntensityThresholds,
    theme: ReportTheme,
): string {
    if (count <= 0) {
        return theme.fg("dim", HEAT_SYMBOLS[0]);
    }

    let level = 1;
    if (count >= thresholds.p75) {
        level = 4;
    } else if (count >= thresholds.p50) {
        level = 3;
    } else if (count >= thresholds.p25) {
        level = 2;
    }

    return theme.fg("accent", HEAT_SYMBOLS[level]!);
}

function monthHeader(start: Date): string {
    const cells = Array.from({ length: HEATMAP_WEEKS }, () => " ");
    let lastMonth = -1;
    let cursor = 0;

    for (let week = 0; week < HEATMAP_WEEKS; week++) {
        const month = addDays(start, week * 7).getMonth();
        if (month === lastMonth) {
            continue;
        }
        lastMonth = month;

        const name = MONTH_NAMES[month]!;
        // A month boundary right after the grid start can leave less than a label's width; slide the
        // label right (or drop it) instead of letting it overwrite the previous one.
        const at = Math.max(week, cursor);
        if (at + name.length > HEATMAP_WEEKS) {
            break;
        }

        for (let offset = 0; offset < name.length; offset++) {
            cells[at + offset] = name[offset]!;
        }
        cursor = at + name.length + 1;
    }

    return "    " + cells.join("");
}

function presetLine(active: StatsRange, theme: ReportTheme): string {
    const parts = PRESET_ORDER.map((preset) => {
        const label = PRESET_LABELS[preset];
        if (active.preset === preset) {
            return theme.bold(label);
        }

        return theme.fg("dim", label);
    });

    return parts.join(theme.fg("dim", " · "));
}

function summaryLines(stats: PiStats, theme: ReportTheme): string[] {
    const allModels = Object.values(stats.modelUsage);
    const input = sumBy(allModels, (usage) => usage.input);
    const output = sumBy(allModels, (usage) => usage.output);
    const cached = sumBy(allModels, (usage) => cachedTokens(usage));
    const cost = sumBy(allModels, (usage) => usage.cost);
    const favorite = favoriteModel(stats.modelUsage);

    const lines: string[] = [];
    lines.push(
        statRow(
            ["Sessions", sessionCountLabel(stats)],
            [
                "Longest session",
                stats.longestSession ? formatDuration(stats.longestSession.durationMs) : "—",
            ],
            theme,
        ),
    );
    lines.push(
        statRow(
            ["Messages", formatTokens(stats.totalMessages)],
            ["Tool calls", formatTokens(stats.totalToolCalls)],
            theme,
        ),
    );
    lines.push(
        statRow(
            ["Active days", `${stats.activeDays}/${stats.rangeDays}`],
            ["Longest streak", pluralizeDays(stats.streaks.longestStreak)],
            theme,
        ),
    );
    lines.push(
        statRow(
            ["Current streak", pluralizeDays(stats.streaks.currentStreak)],
            [
                "Most active day",
                stats.peakActivityDay ? formatShortDate(stats.peakActivityDay) : "—",
            ],
            theme,
        ),
    );
    lines.push(
        statRow(
            [
                "Peak hour",
                stats.peakActivityHour === null
                    ? "—"
                    : `${stats.peakActivityHour}:00–${stats.peakActivityHour + 1}:00`,
            ],
            ["Favorite model", favorite ? modelDisplayName(favorite) : "—"],
            theme,
        ),
    );
    lines.push(
        statRow(
            ["Fresh in/out", `${formatTokens(input)} / ${formatTokens(output)}`],
            ["Cached tokens", cached > 0 ? formatTokens(cached) : "—"],
            theme,
        ),
    );

    if (cost > 0) {
        const childTokens = freshTokens(stats.usageBySource.child);
        const totalTokens = freshTokens(stats.usageBySource.parent) + childTokens;
        const childShare = totalTokens > 0 ? Math.round((childTokens / totalTokens) * 100) : 0;
        lines.push(
            statRow(["Total cost", formatCost(cost)], ["Child tokens", `${childShare}%`], theme),
        );
    } else if (stats.childSessions > 0) {
        lines.push(statRow(["Sessions", sessionCountLabel(stats)], ["Child tokens", "—"], theme));
    }

    return lines;
}

function statRow(left: [string, string], right: [string, string], theme: ReportTheme): string {
    const leftCell = `${left[0]}: ${left[1]}`.padEnd(COLUMN_WIDTH);
    return theme.fg("dim", leftCell) + `${right[0]}: ${theme.fg("accent", right[1])}`;
}

function sessionCountLabel(stats: PiStats): string {
    if (stats.childSessions === 0) {
        return `${stats.totalSessions}`;
    }

    return `${stats.totalSessions} (${stats.parentSessions} main · ${stats.childSessions} child)`;
}

function favoriteModel(modelUsage: ModelUsage): string | null {
    let favorite: string | null = null;
    let best = -1;

    for (const [model, usage] of Object.entries(modelUsage)) {
        const tokens = usage.input + usage.output;
        if (tokens > best) {
            best = tokens;
            favorite = model;
        }
    }

    return favorite;
}

function funFact(stats: PiStats): string {
    const tokens = sumBy(Object.values(stats.modelUsage), (usage) => freshTokens(usage));
    const facts: string[] = [];

    for (const book of BOOKS) {
        if (tokens < book.tokens) {
            continue;
        }
        const ratio = tokens / book.tokens;
        if (ratio >= 2) {
            facts.push(`You've used ~${Math.floor(ratio)}× more tokens than ${book.title}`);
        } else {
            facts.push(`You've used about as many tokens as ${book.title}`);
        }
    }

    if (stats.longestSession) {
        const minutes = stats.longestSession.durationMs / 60_000;
        for (const time of TIMES) {
            const ratio = minutes / time.minutes;
            if (ratio >= 2) {
                facts.push(
                    `Your longest session is ~${Math.floor(ratio)}× longer than ${time.title}`,
                );
            }
        }
    }

    // Deterministic: the last applicable fact is the most impressive, and it must not change as the
    // user cycles ranges or reopens the dialog.
    return facts.at(-1) ?? "";
}

function modelSectionLines(stats: PiStats, theme: ReportTheme): string[] {
    const entries = Object.entries(stats.modelUsage)
        .map(([model, usage]) => ({ model, usage, tokens: usage.input + usage.output }))
        .sort((left, right) => right.tokens - left.tokens);

    if (entries.length === 0) {
        return [theme.fg("dim", "No model usage in this range.")];
    }

    const total = sumBy(entries, (entry) => entry.tokens);
    const lines: string[] = [theme.bold("Models"), ""];

    if (stats.dailyActivity.length >= 2) {
        const first = stats.dailyActivity[0]!.date;
        const last = stats.dailyActivity.at(-1)!.date;
        lines.push(theme.bold("Tokens per Day"));
        lines.push(theme.fg("dim", `${formatShortDate(first)} – ${formatShortDate(last)}`));
        lines.push("");

        for (const entry of entries.slice(0, 3)) {
            const values = stats.dailyActivity.map((day) =>
                freshTokens(day.usageByModel[entry.model]),
            );
            if (!values.some((value) => value > 0)) {
                continue;
            }

            lines.push(theme.fg("dim", modelDisplayName(entry.model)));
            lines.push(...sparkLines(values, theme));
            lines.push("");
        }
    }

    for (const entry of entries) {
        const share = total > 0 ? ((entry.tokens / total) * 100).toFixed(1) : "0.0";
        lines.push(
            `• ${theme.bold(modelDisplayName(entry.model))} ${theme.fg("dim", `(${share}%)`)}`,
        );
        lines.push(
            theme.fg(
                "dim",
                `  In: ${formatTokens(entry.usage.input)} · Out: ${formatTokens(entry.usage.output)}`,
            ),
        );
        if (entry.usage.cacheRead || entry.usage.cacheWrite) {
            lines.push(
                theme.fg(
                    "dim",
                    `  Cache read: ${formatTokens(entry.usage.cacheRead)} · Cache write: ${formatTokens(entry.usage.cacheWrite)}`,
                ),
            );
        }
        if (entry.usage.cost > 0) {
            lines.push(theme.fg("dim", `  Cost: ${formatCost(entry.usage.cost)}`));
        }
    }

    lines.push("");
    lines.push(
        `${theme.fg("accent", "★")} Favorite: ${theme.bold(modelDisplayName(entries[0]!.model))} · Total: ${theme.fg("accent", formatTokens(total))} tokens`,
    );
    return lines;
}

function sparkLines(values: number[], theme: ReportTheme): string[] {
    if (values.length < 2) {
        return [];
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const levels = resample(values, CHART_WIDTH).map(
        (value) => ((value - min) / span) * CHART_HEIGHT,
    );

    const lines: string[] = [];
    for (let row = CHART_HEIGHT; row >= 1; row--) {
        let chart = "";
        for (const level of levels) {
            chart += sparkCell(level, row);
        }

        const label = yAxisLabel(row, min, max);
        lines.push(theme.fg("dim", label.padStart(6)) + " " + theme.fg("accent", chart));
    }

    return lines;
}

function sparkCell(level: number, row: number): string {
    if (level >= row) {
        return "█";
    }
    if (level <= row - 1) {
        return " ";
    }

    const partial = Math.round((level - (row - 1)) * 7);
    return SPARK_CHARS[partial + 1] ?? "█";
}

function resample(values: number[], width: number): number[] {
    return Array.from({ length: width }, (_, index) => {
        const source = Math.min(values.length - 1, Math.floor((index * values.length) / width));
        return values[source]!;
    });
}

function yAxisLabel(row: number, min: number, max: number): string {
    if (row === CHART_HEIGHT) {
        return formatTokens(max);
    }
    if (row === 1) {
        return formatTokens(min);
    }

    return "";
}

function rangeFootnote(stats: PiStats): string {
    if (stats.range.preset === "all") {
        return `Stats across ${stats.rangeDays} day${stats.rangeDays === 1 ? "" : "s"} of history`;
    }

    return `Stats from ${stats.range.label}`;
}

const MODEL_NAME_REWRITES: Array<[RegExp, string]> = [
    [/claude-sonnet-4-5-/, "sonnet-4.5-"],
    [/claude-sonnet-4-/, "sonnet-4-"],
    [/claude-opus-4-/, "opus-4-"],
    [/claude-haiku-3-5-/, "haiku-3.5-"],
    [/claude-3-5-sonnet/, "sonnet-3.5"],
    [/claude-3-5-haiku/, "haiku-3.5"],
    [/claude-3-opus/, "opus-3"],
    [/gpt-4o-mini/, "4o-mini"],
    [/gpt-4o/, "4o"],
    [/gpt-4-turbo/, "4-turbo"],
    [/gpt-4-/, "4-"],
    [/gpt-3.5-turbo/, "3.5-turbo"],
];

function modelDisplayName(model: string): string {
    let display = model;
    for (const [pattern, replacement] of MODEL_NAME_REWRITES) {
        if (pattern.test(display)) {
            display = display.replace(pattern, replacement);
            break;
        }
    }

    return display.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${totalSeconds % 60}s`;
    }

    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function formatCost(cost: number): string {
    if (cost === 0) {
        return "$0";
    }
    if (cost < 0.01) {
        return `$${cost.toFixed(4)}`;
    }

    return `$${cost.toFixed(2)}`;
}

function pluralizeDays(count: number): string {
    return `${count} day${count === 1 ? "" : "s"}`;
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
    let total = 0;
    for (const item of items) {
        total += pick(item);
    }

    return total;
}
