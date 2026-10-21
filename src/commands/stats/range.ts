/**
 * Range parsing and local-date helpers for `/stats`.
 *
 * Argument grammar:
 * - no argument          -> last 30 days
 * - `Nd` or bare `N`     -> last N days
 * - `all`                -> all history
 * - `YYYY-MM-DD`         -> that date through today
 * - `YYYY-MM-DD HH..`    -> an inclusive explicit range
 *
 * All dates are local, matching what a person means by "today" in the heatmap.
 */

import type { RangePreset, StatsRange } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOOKBACK = /^(\d{1,4})d?$/;
const MAX_LOOKBACK_DAYS = 3650;

export const STATS_USAGE =
    "Usage: /stats [all | <days>d | <from YYYY-MM-DD> | <from YYYY-MM-DD> <to YYYY-MM-DD>]";

export type ParsedRange = { ok: true; range: StatsRange } | { ok: false; message: string };

/** Format a Date as a local `YYYY-MM-DD` string. */
export function toLocalDateString(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** Parse `YYYY-MM-DD` as local midnight, rejecting rollovers like February 30. */
export function parseLocalDate(value: string): Date | null {
    if (!ISO_DATE.test(value)) {
        return null;
    }

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year!, month! - 1, day!);
    if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day) {
        return null;
    }

    return date;
}

export function addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

export function formatShortDate(value: string): string {
    const date = parseLocalDate(value);
    if (!date) {
        return value;
    }

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function presetRange(preset: RangePreset, today: Date): StatsRange {
    const end = toLocalDateString(today);

    switch (preset) {
        case "all":
            return { preset, start: null, end, label: "All time" };
        case "30d":
            return {
                preset,
                start: toLocalDateString(addDays(today, -29)),
                end,
                label: "Last 30 days",
            };
        case "7d":
            return {
                preset,
                start: toLocalDateString(addDays(today, -6)),
                end,
                label: "Last 7 days",
            };
    }
}

const PRESET_ORDER: RangePreset[] = ["all", "30d", "7d"];

/** Next preset in the `r` cycle; a custom argument range restarts the cycle at all-time. */
export function nextPresetRange(range: StatsRange, today: Date): StatsRange {
    const index = range.preset === "custom" ? -1 : PRESET_ORDER.indexOf(range.preset);
    return presetRange(PRESET_ORDER[(index + 1) % PRESET_ORDER.length]!, today);
}

export function parseRangeArgs(raw: string, today: Date): ParsedRange {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const todayString = toLocalDateString(today);

    if (tokens.length === 0) {
        return { ok: true, range: presetRange("30d", today) };
    }

    if (tokens.length > 2) {
        return invalidRange();
    }

    if (tokens.length === 1) {
        return parseSingleToken(tokens[0]!, today, todayString);
    }

    return parseExplicitRange(tokens[0]!, tokens[1]!, today);
}

function parseSingleToken(token: string, today: Date, todayString: string): ParsedRange {
    if (token.toLowerCase() === "all") {
        return { ok: true, range: presetRange("all", today) };
    }

    const lookback = LOOKBACK.exec(token);
    if (lookback) {
        const days = Number(lookback[1]);
        if (days < 1 || days > MAX_LOOKBACK_DAYS) {
            return invalidRange(`Lookback must be between 1 and ${MAX_LOOKBACK_DAYS} days.`);
        }

        return {
            ok: true,
            range: {
                preset: "custom",
                start: toLocalDateString(addDays(today, -(days - 1))),
                end: todayString,
                label: `Last ${days} days`,
            },
        };
    }

    const from = parseLocalDate(token);
    if (!from) {
        return invalidRange();
    }
    if (from.getTime() > today.getTime()) {
        return invalidRange("Start date is in the future.");
    }

    return {
        ok: true,
        range: {
            preset: "custom",
            start: token,
            end: todayString,
            label: `${formatShortDate(token)} – today`,
        },
    };
}

function parseExplicitRange(from: string, to: string, today: Date): ParsedRange {
    const fromDate = parseLocalDate(from);
    const toDate = parseLocalDate(to);
    if (!fromDate || !toDate) {
        return invalidRange("Dates must use YYYY-MM-DD.");
    }
    if (fromDate.getTime() > toDate.getTime()) {
        return invalidRange("Start date must not be after end date.");
    }
    if (toDate.getTime() > today.getTime()) {
        return invalidRange("End date is in the future.");
    }

    return {
        ok: true,
        range: {
            preset: "custom",
            start: from,
            end: to,
            label: `${formatShortDate(from)} – ${formatShortDate(to)}`,
        },
    };
}

function invalidRange(detail?: string): ParsedRange {
    return { ok: false, message: detail ? `${detail} ${STATS_USAGE}` : STATS_USAGE };
}
