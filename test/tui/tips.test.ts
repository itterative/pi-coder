import { afterEach, describe, expect, it, vi } from "vitest";

import { TipRotator, type FooterTip } from "../../src/tui/status/tips";

afterEach(() => {
    vi.useRealTimers();
});

function recording(): {
    seen: Array<string | undefined>;
    onChange: (tip: FooterTip | undefined) => void;
} {
    const seen: Array<string | undefined> = [];
    return { seen, onChange: (tip) => seen.push(tip?.text) };
}

/** A tip list entry; `options` carries the `when` gate and the `preferFirst` flag. */
function tip(text: string, options: Omit<FooterTip, "text"> = {}): FooterTip {
    return { text, ...options };
}

describe("TipRotator", () => {
    it("shows a tip after the interval for its visible window, then hides it", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: [tip("first"), tip("second")],
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

    it("shows the first tip without the initial delay on an idle line", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: [tip("a")],
            firstDelayMs: 60_000,
            intervalMs: 100,
            visibleMs: 50,
            isLineIdle: () => true,
        });

        rotator.start();
        expect(seen).toEqual([]);

        vi.advanceTimersByTime(0);
        expect(seen).toEqual(["a"]);
        rotator.dispose();
    });

    it("waits for an explicit first delay before the first tip", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            tips: [tip("a")],
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
            tips: [tip("a"), tip("b"), tip("c")],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
        });

        rotator.start();

        const shown: string[] = [];
        for (let cycle = 0; cycle < 3; cycle += 1) {
            vi.advanceTimersByTime(100);
            const text = seen.at(-1);
            if (typeof text === "string") {
                shown.push(text);
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
            tips: [tip("a")],
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
            tips: [tip("a")],
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

    it("defers a conditioned tip until its condition holds", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        let open = false;
        const rotator = new TipRotator(onChange, {
            tips: [tip("gated", { when: () => open }), tip("always")],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
            random: () => 0,
        });

        rotator.start();
        vi.advanceTimersByTime(100);
        expect(seen).toEqual(["always"]);

        // The gated tip is the only one left in the bag: its window is skipped, not consumed.
        vi.advanceTimersByTime(200);
        expect(seen).toEqual(["always", undefined]);

        open = true;
        vi.advanceTimersByTime(50);
        expect(seen).toEqual(["always", undefined, "gated"]);
        rotator.dispose();
    });

    it("holds a tip past its window while idle, and releases it when the line fills up", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        let idle = true;
        const rotator = new TipRotator(onChange, {
            tips: [tip("a"), tip("b")],
            intervalMs: 1_000,
            visibleMs: 50,
            random: () => 0,
            isLineIdle: () => idle,
        });

        rotator.start();
        vi.advanceTimersByTime(0);
        expect(seen).toEqual(["a"]);

        // The window ends, but an idle line keeps its tip...
        vi.advanceTimersByTime(50);
        expect(seen).toEqual(["a"]);

        // ...and the next window replaces it rather than leaving a gap.
        vi.advanceTimersByTime(1_000);
        expect(seen).toEqual(["a", "b"]);

        vi.advanceTimersByTime(50);
        expect(seen).toEqual(["a", "b"]);

        idle = false;
        rotator.recheck();
        expect(seen).toEqual(["a", "b", undefined]);
        rotator.dispose();
    });

    it("picks a tip up when the line becomes idle while waiting", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        let idle = false;
        const rotator = new TipRotator(onChange, {
            tips: [tip("a")],
            firstDelayMs: 60_000,
            intervalMs: 1_000,
            visibleMs: 50,
            isLineIdle: () => idle,
        });

        rotator.start();
        vi.advanceTimersByTime(5_000);
        expect(seen).toEqual([]);

        // The initial wait stops mattering the moment the line has nothing else to show.
        idle = true;
        rotator.recheck();
        expect(seen).toEqual(["a"]);
        rotator.dispose();
    });

    it("puts the initial delay back when the line fills up before the tip arrives", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        let idle = true;
        const rotator = new TipRotator(onChange, {
            tips: [tip("a")],
            firstDelayMs: 500,
            intervalMs: 1_000,
            visibleMs: 50,
            isLineIdle: () => idle,
        });

        rotator.start();
        idle = false;
        rotator.recheck();

        vi.advanceTimersByTime(499);
        expect(seen).toEqual([]);

        vi.advanceTimersByTime(1);
        expect(seen).toEqual(["a"]);
        rotator.dispose();
    });

    it("yields an idle-line tip mid-window when the line fills up", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        let idle = true;
        const rotator = new TipRotator(onChange, {
            tips: [tip("a")],
            intervalMs: 1_000,
            visibleMs: 50,
            isLineIdle: () => idle,
        });

        rotator.start();
        vi.advanceTimersByTime(0);
        expect(seen).toEqual(["a"]);

        idle = false;
        rotator.recheck();
        expect(seen).toEqual(["a", undefined]);

        // The cleared window does not fire its own hide a moment later.
        vi.advanceTimersByTime(50);
        expect(seen).toEqual(["a", undefined]);
        rotator.dispose();
    });

    it("lets a preferred tip jump the shuffled order", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        const rotator = new TipRotator(onChange, {
            // The shuffle below would pop "first" without the preference.
            tips: [tip("first"), tip("second"), tip("preferred", { preferFirst: true })],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
            random: () => 0,
        });

        rotator.start();
        vi.advanceTimersByTime(100);
        expect(seen).toEqual(["preferred"]);

        vi.advanceTimersByTime(150);
        expect(seen).toEqual(["preferred", undefined, "first"]);
        rotator.dispose();
    });

    it("leads with a preferred tip at the first window where it is available", () => {
        vi.useFakeTimers();
        const { seen, onChange } = recording();
        let open = false;
        const preferred = tip("gated", { when: () => open, preferFirst: true });
        const rotator = new TipRotator(onChange, {
            tips: [preferred, tip("a"), tip("b")],
            firstDelayMs: 100,
            intervalMs: 100,
            visibleMs: 50,
            // An identity shuffle keeps the bag order predictable for the assertions.
            random: () => 0.99,
        });

        rotator.start();
        vi.advanceTimersByTime(100);
        // The preferred tip is not available, so the bag's own order shows through.
        expect(seen).toEqual(["b"]);

        open = true;
        vi.advanceTimersByTime(150);
        expect(seen).toEqual(["b", undefined, "gated"]);

        vi.advanceTimersByTime(150);
        // Leading took it out of the bag, so rotation continues with the remaining tips.
        expect(seen).toEqual(["b", undefined, "gated", undefined, "a"]);
        rotator.dispose();
    });
});
