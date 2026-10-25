import { describe, expect, it } from "vitest";

import {
    CHARS_PER_TOKEN_INITIAL,
    STREAM_MIN_TOKENS,
    STREAM_WINDOW_MS,
    StreamRateTracker,
    formatStreamRate,
} from "../../src/tui/status/stream-rate";

/** A clock the test advances by hand, so every sample interval is explicit. */
function clockAt(start = 0): { advance(ms: number): void; now(): number } {
    let at = start;
    return {
        now: () => at,
        advance(ms: number) {
            at += ms;
        },
    };
}

/** Characters streamed for a steady rate: `tokens` at the initial four characters per token, per 250 ms. */
function charsFor(tokens: number): number {
    return tokens * CHARS_PER_TOKEN_INITIAL;
}

describe("StreamRateTracker", () => {
    it("reads a steady stream of characters as its rate, before the provider reports anything", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // 40 characters per 250 ms is 10 tokens at the initial four characters per token: 40 tok/s.
        clock.advance(250);
        tracker.observeDelta(charsFor(10));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(40);

        // The next interval averages in rather than replacing the answer.
        clock.advance(250);
        tracker.observeDelta(charsFor(10));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(40);
    });

    it("spreads one update's characters over the interval they cover instead of spiking", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // A single update covering two seconds of output is 60 tok/s, not 480.
        clock.advance(2_000);
        tracker.observeDelta(charsFor(120));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(60);
    });

    it("learns characters per token from the provider's own totals", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // A response of 4000 characters that the provider reports as 500 output tokens, at the end.
        for (let index = 0; index < 10; index++) {
            clock.advance(250);
            tracker.observeDelta(400);
            tracker.observeOutput(0);
        }
        tracker.observeOutput(500);

        // The measurement outweighs the guess of four: a report of 500 tokens moves the ratio a third of the way
        // from 4 to the 8 it measured, so 16/3 characters per token.
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(120);
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(90);

        clock.advance(250);
        tracker.observeDelta(120);
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(90);
    });

    it("bounds a measurement that cannot describe characters per token", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(1_000);
        tracker.observeOutput(0);

        // 1000 characters for 10 000 tokens is under the floor, so it is clamped to 1.5 rather than trusted.
        clock.advance(250);
        tracker.observeOutput(10_000);

        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(120);
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(320);
    });

    it("falls back to the provider's count for a stream that reports tokens without characters", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        clock.advance(250);
        tracker.observeOutput(20);
        expect(tracker.rate()).toBe(80);

        clock.advance(250);
        tracker.observeOutput(40);
        expect(tracker.rate()).toBe(80);
    });

    it("holds the number rather than recording an update that produced nothing", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        clock.advance(250);
        tracker.observeDelta(charsFor(10));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(40);

        // Neither characters nor growth: the update is ignored, so the average cannot slide toward `0.0 tok/s`.
        clock.advance(250);
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(40);

        // The provider's sole report of the response is the measurement, not a whole response attributed to the
        // update that carried it, which would spike the number.
        clock.advance(250);
        tracker.observeOutput(500);
        expect(tracker.rate()).toBe(40);
    });

    it("holds no rate until enough output has been produced", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        clock.advance(250);
        tracker.observeDelta(charsFor(STREAM_MIN_TOKENS) - 4);
        tracker.observeOutput(0);
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeDelta(charsFor(STREAM_MIN_TOKENS));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBeDefined();
    });

    it("spans at most the configured window of streaming time", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // A burst: 120 tokens in the first 250 ms, i.e. 480 tok/s.
        clock.advance(250);
        tracker.observeDelta(charsFor(120));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(480);

        // Steady 60 tok/s after it. The burst decays as newer samples outweigh it, and is gone for good once the
        // retained history covers the whole window without it.
        const windowUpdates = STREAM_WINDOW_MS / 250;
        const decay: number[] = [];
        for (let index = 0; index < windowUpdates; index++) {
            clock.advance(250);
            tracker.observeDelta(charsFor(15));
            tracker.observeOutput(0);
            decay.push(tracker.rate() ?? 0);
        }

        expect(decay).toEqual(decay.toSorted((left, right) => right - left));
        expect(tracker.rate()).toBe(60);
    });

    it("restarts at the next message instead of averaging in the previous response", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(charsFor(30));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(120);

        tracker.onMessageStart();
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeDelta(charsFor(10));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(40);
    });

    it("drops the estimate on reset and ignores later reports", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(charsFor(30));
        tracker.observeOutput(0);
        expect(tracker.rate()).toBe(120);

        tracker.reset();
        expect(tracker.rate()).toBeUndefined();

        clock.advance(250);
        tracker.observeDelta(charsFor(40));
        tracker.observeOutput(200);
        expect(tracker.rate()).toBeUndefined();
    });

    it("keeps the ratio in memory across a session clear", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(4_000);
        tracker.observeOutput(500);

        tracker.reset();
        tracker.onMessageStart();
        clock.advance(250);
        tracker.observeDelta(120);
        tracker.observeOutput(0);
        // Still measured at 16/3 characters per token: 22.5 tokens over 250 ms, not the guess's 30 tokens.
        expect(tracker.rate()).toBe(90);
    });

    it("ignores reports that arrive before any message started", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);

        clock.advance(250);
        tracker.observeDelta(charsFor(30));
        tracker.observeOutput(100);
        expect(tracker.rate()).toBeUndefined();
    });

    it("shows nothing rather than a rate that would round to zero", () => {
        const clock = clockAt();
        const tracker = new StreamRateTracker(clock.now);
        tracker.onMessageStart();

        // 8 tokens over 200 s is 0.04 tok/s, which the slot would print as `0.0 tok/s`.
        clock.advance(200_000);
        tracker.observeDelta(charsFor(STREAM_MIN_TOKENS));
        tracker.observeOutput(0);
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
