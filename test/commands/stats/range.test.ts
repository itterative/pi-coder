import { describe, expect, it } from "vitest";

import {
    nextPresetRange,
    parseLocalDate,
    parseRangeArgs,
    presetRange,
    STATS_USAGE,
} from "../../../src/commands/stats/range";

const TODAY = new Date(2026, 2, 15, 12, 0, 0);

describe("parseRangeArgs", () => {
    it("defaults to the last 30 days", () => {
        const result = parseRangeArgs("", TODAY);
        expect(result).toEqual({
            ok: true,
            range: {
                preset: "30d",
                start: "2026-02-14",
                end: "2026-03-15",
                label: "Last 30 days",
            },
        });
    });

    it("parses lookbacks with and without the d suffix", () => {
        for (const raw of ["7d", "7"]) {
            const result = parseRangeArgs(raw, TODAY);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.range.start).toBe("2026-03-09");
                expect(result.range.end).toBe("2026-03-15");
                expect(result.range.label).toBe("Last 7 days");
            }
        }
    });

    it("parses all history", () => {
        const result = parseRangeArgs("all", TODAY);
        expect(result).toEqual({
            ok: true,
            range: { preset: "all", start: null, end: "2026-03-15", label: "All time" },
        });
    });

    it("parses a single date as since-that-day", () => {
        const result = parseRangeArgs("2026-03-01", TODAY);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.range.start).toBe("2026-03-01");
            expect(result.range.end).toBe("2026-03-15");
            expect(result.range.preset).toBe("custom");
        }
    });

    it("parses an explicit inclusive range", () => {
        const result = parseRangeArgs("2026-03-01 2026-03-10", TODAY);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.range.start).toBe("2026-03-01");
            expect(result.range.end).toBe("2026-03-10");
            expect(result.range.label).toBe("Mar 1 – Mar 10");
        }
    });

    it("rejects malformed, reversed, future, and out-of-bounds arguments", () => {
        for (const raw of [
            "bogus",
            "2026-02-30",
            "0d",
            "4000",
            "2026-03-10 2026-03-01",
            "2026-03-01 2026-04-01",
            "2026-04-01",
            "1 2 3",
        ]) {
            const result = parseRangeArgs(raw, TODAY);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.message).toContain(STATS_USAGE);
            }
        }
    });
});

describe("preset ranges", () => {
    it("builds each preset window from the anchor day", () => {
        expect(presetRange("all", TODAY).start).toBeNull();
        expect(presetRange("30d", TODAY).start).toBe("2026-02-14");
        expect(presetRange("7d", TODAY).start).toBe("2026-03-09");
    });

    it("cycles presets and restarts a custom range at all time", () => {
        expect(nextPresetRange(presetRange("7d", TODAY), TODAY).preset).toBe("all");
        expect(nextPresetRange(presetRange("all", TODAY), TODAY).preset).toBe("30d");

        const custom = parseRangeArgs("2026-03-01", TODAY);
        expect(custom.ok).toBe(true);
        if (custom.ok) {
            expect(nextPresetRange(custom.range, TODAY).preset).toBe("all");
        }
    });
});

describe("parseLocalDate", () => {
    it("rejects rollover dates", () => {
        expect(parseLocalDate("2026-02-30")).toBeNull();
        expect(parseLocalDate("2026-13-01")).toBeNull();
        expect(parseLocalDate("2026-02-28")).not.toBeNull();
    });
});
