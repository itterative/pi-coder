/**
 * Live generation rate for the response currently streaming, feeding the footer's usage slot.
 *
 * The transcript's `durationMs` only exists once a message is persisted, and the number is not estimated from
 * streamed characters, so it comes from the provider's own cumulative `usage.output` while it streams. One
 * sample is recorded per report: the output it added and the time since the previous report - the interval
 * those tokens were produced over. That attribution matters: a provider reporting once a second would otherwise
 * dump a whole second of output into whichever 250 ms window it arrived in and read several times too high.
 *
 * The number shown is a weighted average over the reports it keeps, newest heaviest, spanning at most
 * `STREAM_WINDOW_MS` of reported time, so it reacts across that window and old output falls out of it on its
 * own. The estimate includes time to first token, so it understates a fast model's decode rate by the
 * request's latency. A provider that reports nothing while streaming produces no rate at all and the totals
 * simply stay in the slot.
 */

/** How much reported time the average spans; older reports fall out of it. */
export const STREAM_WINDOW_MS = 5000;
/** Output below this many tokens reads as noise rather than a rate, so nothing is shown yet. */
export const STREAM_MIN_TOKENS = 8;
/** Below this the rate would render as `0.0 tok/s`, which is not worth the slot; the totals keep it. */
const MIN_VISIBLE_RATE = 0.05;

/** One provider report: what it added, and the interval it was produced over. */
interface RateSample {
    tokens: number;
    seconds: number;
}

export class StreamRateTracker {
    private active = false;
    private samples: RateSample[] = [];
    private retainedSeconds = 0;
    private reportedOutput = 0;
    private lastReportAt = 0;

    constructor(private readonly now: () => number = () => performance.now()) {}

    /** An assistant message began, so the estimate restarts rather than averaging in the previous response. */
    onMessageStart(): void {
        this.active = true;
        this.samples = [];
        this.retainedSeconds = 0;
        this.reportedOutput = 0;
        this.lastReportAt = this.now();
    }

    /** The provider's cumulative output count for this response; a report that added output is one sample. */
    observeOutput(outputTokens: number): void {
        if (!this.active) return;

        const at = this.now();
        const seconds = (at - this.lastReportAt) / 1000;
        const grown = outputTokens - this.reportedOutput;
        this.reportedOutput = Math.max(this.reportedOutput, outputTokens);
        if (seconds <= 0) return;

        // Only intervals that produced output are kept. A report that added nothing is the common trailing
        // chunk and the noise between them while a tool runs; recording one would drag the average to zero and
        // print `0.0 tok/s` at the end of a response whose rate was never zero. Not advancing the clock here
        // also means the first real report covers everything since the response started.
        if (grown <= 0) return;

        this.lastReportAt = at;
        this.samples.push({ tokens: grown, seconds });
        this.retainedSeconds += seconds;
        while (this.retainedSeconds > STREAM_WINDOW_MS / 1000 && this.samples.length > 1) {
            this.retainedSeconds -= this.samples.shift()?.seconds ?? 0;
        }
    }

    /** The current estimate in tokens per second, or `undefined` until enough output has been reported. */
    rate(): number | undefined {
        if (!this.active || this.reportedOutput < STREAM_MIN_TOKENS) {
            return undefined;
        }

        // Oldest sample first, so the list position is its weight: the newest report counts most.
        let weightedTokens = 0;
        let weightedSeconds = 0;
        for (const [position, sample] of this.samples.entries()) {
            const weight = position + 1;
            weightedTokens += sample.tokens * weight;
            weightedSeconds += sample.seconds * weight;
        }
        if (weightedSeconds <= 0) return undefined;

        const rate = weightedTokens / weightedSeconds;
        return rate < MIN_VISIBLE_RATE ? undefined : rate;
    }

    /** The response ended: drop the estimate so a later response starts from its own first report. */
    reset(): void {
        this.active = false;
        this.samples = [];
        this.retainedSeconds = 0;
        this.reportedOutput = 0;
    }
}

/** Format a rate for the compact footer slot: slow models keep a decimal, fast ones do not need one. */
export function formatStreamRate(rate: number): string {
    const rounded = rate < 10 ? rate.toFixed(1) : Math.round(rate).toString();
    return `${rounded} tok/s`;
}
