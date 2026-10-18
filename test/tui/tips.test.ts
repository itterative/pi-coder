import { afterEach, describe, expect, it, vi } from "vitest";

import { TipRotator } from "../../src/tui/status/tips";

afterEach(() => {
    vi.useRealTimers();
});

function recording(): {
    seen: Array<string | undefined>;
    onChange: (tip: string | undefined) => void;
} {
    const seen: Array<string | undefined> = [];
    return { seen, onChange: (tip) => seen.push(tip) };
}

describe("TipRotator", () => {
    it("shows a tip after the interval for its visible window, then hides it", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: ["first", "second"],
            firstDelayMs: 1_000,
            intervalMs: 1_000,
            visibleMs: 400,
            random: () => 0,
        });

        rotator.start();
        expect(seen).toEqual([]);

        vi.advanceTimersByTime(999);
        expect(seen).toEqual([]);

        vi.advanceTimersByTime(1);
        expect(seen).toEqual(["first"]);

        vi.advanceTimersByTime(399);
        expect(seen).toEqual(["first"]);

        vi.advanceTimersByTime(1);
        expect(seen).toEqual(["first", undefined]);

        vi.advanceTimersByTime(1_000);
        expect(seen).toEqual(["first", undefined, "second"]);
        rotator.dispose();
    });

    it("waits for the first delay before the first tip", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: ["a"],
            firstDelayMs: 500,
            intervalMs: 1_000,
            visibleMs: 50,
        });

        rotator.start();
        vi.advanceTimersByTime(499);
        expect(seen).toEqual([]);

        vi.advanceTimersByTime(1);
        expect(seen).toEqual(["a"]);
        rotator.dispose();
    });

    it("does not repeat a tip until every tip has been shown", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: ["a", "b", "c"],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
        });

        rotator.start();

        const shown: string[] = [];
        for (let cycle = 0; cycle < 3; cycle += 1) {
            vi.advanceTimersByTime(100);
            const tip = seen.at(-1);
            if (typeof tip === "string") {
                shown.push(tip);
            }
            vi.advanceTimersByTime(50);
        }

        expect(shown).toHaveLength(3);
        expect(shown.toSorted()).toEqual(["a", "b", "c"]);
        rotator.dispose();
    });

    it("stops once disposed", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: ["a"],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
        });

        rotator.start();
        vi.advanceTimersByTime(100);
        expect(seen).toEqual(["a"]);

        rotator.dispose();
        vi.advanceTimersByTime(10_000);
        expect(seen).toEqual(["a"]);
    });

    it("ignores a second start while a window is scheduled", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: ["a"],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
        });

        rotator.start();
        rotator.start();
        vi.advanceTimersByTime(100);
        expect(seen).toEqual(["a"]);
        rotator.dispose();
    });
});
