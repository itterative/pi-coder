import { describe, expect, it } from "vitest";

import {
    STREAM_MIN_TOKENS,
    STREAM_WINDOW_MS,
    StreamRateTracker,
    formatStreamRate,
} from "../../src/tui/status/stream-rate";

/** A clock the test advances by hand, so every report interval is explicit. */
function clockAt(start = 0): { advance(ms: number): void; now(): number } {
    let at = start;
    return {
        now: () => at,
        advance(ms: number) {
            at += ms;
        },
    };
}

describe("StreamRateTracker", () => {
    it("reads a steady report interval as its rate", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // 15 tokens every 250 ms is 60 tok/s, and averaging reports does not move it.
        clock.advance(250);
        tracker.observeOutput(15);
        expect(tracker.rate()).toBe(60);

        clock.advance(250);
        tracker.observeOutput(30);
        expect(tracker.rate()).toBe(60);
    });

    it("spreads a report over the interval it covers instead of spiking", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // One report covering two seconds of output is 60 tok/s, not 480.
        clock.advance(2_000);
        tracker.observeOutput(120);
        expect(tracker.rate()).toBe(60);
    });

    it("ignores a report that added no output, so the number cannot slide to zero", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // A report before any output is known says nothing, and it does not split the interval either.
        clock.advance(250);
        tracker.observeOutput(0);
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeOutput(100);
        expect(tracker.rate()).toBe(200);

        // The trailing no-growth report - the usual final chunk - leaves the average where it was, rather
        // than folding in an empty interval and printing `0.0 tok/s`.
        clock.advance(250);
        tracker.observeOutput(100);
        expect(tracker.rate()).toBe(200);
    });

    it("shows nothing rather than a rate that would round to zero", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // 8 tokens over 200 s is 0.04 tok/s, which the slot would print as `0.0 tok/s`.
        clock.advance(200_000);
        tracker.observeOutput(STREAM_MIN_TOKENS);
        expect(tracker.rate()).toBeUndefined();
    });

    it("spans at most the configured window of reported time", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // A burst: 100 tokens in the first 250 ms, i.e. 400 tok/s.
        clock.advance(250);
        tracker.observeOutput(100);
        expect(tracker.rate()).toBe(400);

        // Steady 60 tok/s after it. The burst decays as newer reports outweigh it, and is gone for good once
        // the retained history covers the whole window without it.
        const windowReports = STREAM_WINDOW_MS / 250;
        const decay: number[] = [];
        for (let index = 1; index <= windowReports; index++) {
            clock.advance(250);
            tracker.observeOutput(100 + index * 15);
            decay.push(tracker.rate() ?? 0);
        }

        expect(decay).toEqual(decay.toSorted((left, right) => right - left));
        expect(tracker.rate()).toBe(60);
    });

    it("holds no rate until enough output has been reported", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        clock.advance(250);
        tracker.observeOutput(STREAM_MIN_TOKENS - 4);
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeOutput(STREAM_MIN_TOKENS);
        expect(tracker.rate()).toBeDefined();
    });

    it("restarts at the next message instead of averaging in the previous response", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeOutput(100);
        expect(tracker.rate()).toBe(400);

        tracker.onMessageStart();
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeOutput(15);
        expect(tracker.rate()).toBe(60);
    });

    it("drops the estimate on reset and ignores later reports", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeOutput(100);
        expect(tracker.rate()).toBe(400);

        tracker.reset();
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeOutput(200);
        expect(tracker.rate()).toBeUndefined();
    });

    it("ignores reports that arrive before any message started", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);

        clock.advance(250);
        tracker.observeOutput(100);
        expect(tracker.rate()).toBeUndefined();
    });
});

describe("formatStreamRate", () => {
    it("keeps one decimal for slow models and drops it for fast ones", () => {
        expect(formatStreamRate(0.4)).toBe("0.4 tok/s");
        expect(formatStreamRate(3.24)).toBe("3.2 tok/s");
        expect(formatStreamRate(9.94)).toBe("9.9 tok/s");
        expect(formatStreamRate(62.4)).toBe("62 tok/s");
        expect(formatStreamRate(119.6)).toBe("120 tok/s");
    });
});
