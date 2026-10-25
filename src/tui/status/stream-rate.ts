/**
 * Live generation rate for the response currently streaming, feeding the footer's usage slot.
 *
 * The provider's cumulative `usage.output` is the truth, but plenty of endpoints only report it once, in the
 * final chunk (an OpenAI-compatible `stream_options.include_usage` stream does exactly that), so on its own it
 * cannot drive a number that moves. The streamed characters can: every `text_delta`, `thinking_delta` and
 * `toolcall_delta` is counted, and `charsPerToken` turns them into output tokens. That ratio starts at
 * `CHARS_PER_TOKEN_INITIAL` and then follows this provider's own numbers - the characters streamed against the
 * output the provider says they were - each report moving it a token-weighted step toward what it measured, so
 * it converges on the model in use and forgets an old one rather than averaging it in forever. It is held in
 * memory for the life of the process, so a new session starts already calibrated.
 *
 * One sample is recorded per update: the tokens it produced and the time since the previous sample, which is
 * the interval they were produced over. That attribution matters, because a provider reporting once a second
 * would otherwise dump a whole second of output into whichever window it arrived in and read several times too
 * high. The number shown is a weighted average over the samples it keeps, newest heaviest, spanning at most
 * `STREAM_WINDOW_MS` of streaming time, so it reacts across that window and old output falls out of it on its
 * own. The estimate includes time to first token, so it understates a fast model's decode rate by the request's
 * latency.
 */

/** How much streaming time the average spans; older samples fall out of it. */
export const STREAM_WINDOW_MS = 5000;
/** Output below this many tokens reads as noise rather than a rate, so nothing is shown yet. */
export const STREAM_MIN_TOKENS = 8;
/** Characters per output token before this provider has been measured; English prose lands near four. */
export const CHARS_PER_TOKEN_INITIAL = 4;
/** Output tokens that move the measured ratio halfway, so it follows the model without chasing one response. */
const CALIBRATION_HALF_LIFE_TOKENS = 1000;
/** Bounds on a measured ratio, so a response with hidden reasoning or none cannot skew the estimate. */
const CHARS_PER_TOKEN_MIN = 1.5;
const CHARS_PER_TOKEN_MAX = 12;
/** Below this the rate would render as `0.0 tok/s`, which is not worth the slot; the totals keep it. */
const MIN_VISIBLE_RATE = 0.05;

/** One update's contribution: what it produced, and the interval it was produced over. */
interface RateSample {
    tokens: number;
    seconds: number;
}

export class StreamRateTracker {
    private active = false;
    private samples: RateSample[] = [];
    private retainedSeconds = 0;
    private lastSampleAt = 0;
    /** The provider's cumulative output for this response, and the characters streamed for it. */
    private reportedOutput = 0;
    private responseChars = 0;
    /** Characters since the last sample, and since the provider last accounted for them. */
    private sampleChars = 0;
    private unclaimedChars = 0;
    /** Characters per output token, measured from what the provider reports; in memory for the whole process. */
    private charsPerToken = CHARS_PER_TOKEN_INITIAL;

    constructor(private readonly now: () => number = () => performance.now()) {}

    /** An assistant message began: the estimate restarts, while what the provider has taught us carries over. */
    onMessageStart(): void {
        this.active = true;
        this.samples = [];
        this.retainedSeconds = 0;
        this.reportedOutput = 0;
        this.responseChars = 0;
        this.sampleChars = 0;
        this.unclaimedChars = 0;
        this.lastSampleAt = this.now();
    }

    /** Characters streamed for this response: text, thinking, or the arguments of a tool call. */
    observeDelta(characters: number): void {
        if (!this.active || characters <= 0) {
            return;
        }

        this.responseChars += characters;
        this.sampleChars += characters;
        this.unclaimedChars += characters;
    }

    /** The provider's cumulative output count, which measures the ratio and stands in for a stream with no deltas. */
    observeOutput(outputTokens: number): void {
        if (!this.active) {
            return;
        }

        const grown = outputTokens - this.reportedOutput;
        this.reportedOutput = Math.max(this.reportedOutput, outputTokens);
        if (grown > 0) {
            this.measure(grown);
        }

        const at = this.now();
        const seconds = (at - this.lastSampleAt) / 1000;
        if (seconds <= 0) {
            return;
        }

        const tokens = this.sampleTokens(grown);
        if (tokens <= 0) {
            return;
        }

        this.sampleChars = 0;
        this.lastSampleAt = at;
        this.samples.push({ tokens, seconds });
        this.retainedSeconds += seconds;
        while (this.retainedSeconds > STREAM_WINDOW_MS / 1000 && this.samples.length > 1) {
            this.retainedSeconds -= this.samples.shift()?.seconds ?? 0;
        }
    }

    /** Tokens per second, or `undefined` until enough output has been produced to mean anything. */
    rate(): number | undefined {
        if (!this.active) {
            return undefined;
        }

        const produced = Math.max(this.reportedOutput, this.responseChars / this.charsPerToken);
        if (produced < STREAM_MIN_TOKENS) {
            return undefined;
        }

        // Oldest sample first, so the list position is its weight: the newest sample counts most.
        let weightedTokens = 0;
        let weightedSeconds = 0;
        for (const [position, sample] of this.samples.entries()) {
            const weight = position + 1;
            weightedTokens += sample.tokens * weight;
            weightedSeconds += sample.seconds * weight;
        }
        if (weightedSeconds <= 0) {
            return undefined;
        }

        const rate = weightedTokens / weightedSeconds;
        return rate < MIN_VISIBLE_RATE ? undefined : rate;
    }

    /**
     * The response ended: drop the estimate so a later response starts from its own first characters. What has
     * been measured survives, because the ratio describes the model and not the session - the next session in
     * this process starts calibrated instead of from the guess.
     */
    reset(): void {
        this.active = false;
        this.samples = [];
        this.retainedSeconds = 0;
        this.reportedOutput = 0;
        this.responseChars = 0;
        this.sampleChars = 0;
        this.unclaimedChars = 0;
    }

    /**
     * What one update produced. Characters are the only signal that moves mid-response, so they carry the
     * number whenever there are any. A stream that reports tokens without deltas has nothing else to show, and
     * its own growth is used instead - but only while no characters have streamed at all, because attributing a
     * whole response's output to the update that finally reported it would spike the number.
     */
    private sampleTokens(grown: number): number {
        if (this.sampleChars > 0) {
            return this.sampleChars / this.charsPerToken;
        }
        if (this.responseChars === 0) {
            return grown;
        }
        return 0;
    }

    /** Fold a provider report into the ratio: the characters it had not accounted for against the tokens it did. */
    private measure(grownTokens: number): void {
        if (this.unclaimedChars <= 0) {
            return;
        }

        const measured = this.unclaimedChars / grownTokens;
        this.unclaimedChars = 0;

        // A token-weighted step: a report of `CALIBRATION_HALF_LIFE_TOKENS` moves the ratio halfway to its
        // measurement, a tenth of that moves it a tenth of the way, and the clamp keeps one strange response
        // out of the far end of the range.
        const weight = grownTokens / (grownTokens + CALIBRATION_HALF_LIFE_TOKENS);
        const next = this.charsPerToken + weight * (measured - this.charsPerToken);
        this.charsPerToken = Math.min(Math.max(next, CHARS_PER_TOKEN_MIN), CHARS_PER_TOKEN_MAX);
    }
}

/** Format a rate for the compact footer slot: slow models keep a decimal, fast ones do not need one. */
export function formatStreamRate(rate: number): string {
    const rounded = rate < 10 ? rate.toFixed(1) : Math.round(rate).toString();
    return `${rounded} tok/s`;
}
