import { describe, expect, it } from "vitest";

import { CallTiming, describeTiming, type CodeTiming } from "../../../src/tools/code/timing";

function timingOf(overrides: Partial<CodeTiming> = {}): CodeTiming {
    return {
        totalMs: 0,
        sourceMs: 0,
        semanticMs: 0,
        discoverMs: 0,
        parseMs: 0,
        searchMs: 0,
        tailMs: 0,
        workMs: 0,
        files: 0,
        cached: 0,
        parsed: 0,
        tooLarge: 0,
        parseErrors: 0,
        ...overrides,
    };
}

describe("outline call timing", () => {
    it("leaves phases it never measured at zero", () => {
        const timing = new CallTiming().snapshot();

        expect(timing.parseMs).toBe(0);
        expect(timing.searchMs).toBe(0);
        expect(timing.tailMs).toBe(0);
        expect(timing.files).toBe(0);
    });

    it("measures a phase and reports the rest as work", async () => {
        const timing = new CallTiming();

        await timing.measure("parse", () => new Promise((resolve) => setTimeout(resolve, 5)));

        const snapshot = timing.snapshot();

        expect(snapshot.parseMs).toBeGreaterThanOrEqual(4);
        expect(snapshot.totalMs).toBeGreaterThanOrEqual(snapshot.parseMs);
        expect(snapshot.workMs).toBeGreaterThanOrEqual(0);
        expect(snapshot.workMs).toBeLessThan(1000);
    });

    it("accumulates a phase measured more than once", async () => {
        const timing = new CallTiming();

        await timing.measure("discover", () => new Promise((resolve) => setTimeout(resolve, 3)));
        await timing.measure("discover", () => new Promise((resolve) => setTimeout(resolve, 3)));

        expect(timing.snapshot().discoverMs).toBeGreaterThanOrEqual(5);
    });

    it("merges load counts, cached and parsed separately", () => {
        const timing = new CallTiming();

        timing.recordLoad({ cached: 6, fresh: 2, tooLarge: 1, errors: ["broken"] }, 9);
        timing.recordLoad({ cached: 1, fresh: 0, tooLarge: 0, errors: [] }, 1);

        const snapshot = timing.snapshot();

        expect(snapshot.files).toBe(10);
        expect(snapshot.cached).toBe(7);
        expect(snapshot.parsed).toBe(2);
        expect(snapshot.tooLarge).toBe(1);
        expect(snapshot.parseErrors).toBe(1);
    });

    it("describes the phases that took a millisecond, largest first", () => {
        const text = describeTiming(
            timingOf({
                totalMs: 120,
                parseMs: 30,
                tailMs: 70,
                workMs: 20,
                files: 700,
                cached: 690,
                parsed: 10,
            }),
        );

        expect(text).toBe(
            "timing: 120 ms · tail 70 · parse 30 · work 20 · files 700 · cached 690 · parsed 10",
        );
    });

    it("drops sub-millisecond phases and names a fully cached load", () => {
        const text = describeTiming(
            timingOf({ totalMs: 12.4, workMs: 12.4, discoverMs: 0.4, files: 4, cached: 4 }),
        );

        expect(text).toBe("timing: 12 ms · work 12 · files 4 · all cached");
    });

    it("reports skipped and unparsable files when they happen", () => {
        const text = describeTiming(
            timingOf({
                totalMs: 40,
                parseMs: 30,
                workMs: 10,
                files: 3,
                parsed: 2,
                tooLarge: 1,
                parseErrors: 2,
            }),
        );

        expect(text).toBe(
            "timing: 40 ms · parse 30 · work 10 · files 3 · parsed 2 · too large 1 · parse errors 2",
        );
    });
});
