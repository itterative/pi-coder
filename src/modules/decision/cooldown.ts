/**
 * The circuit breaker under every classifier surface.
 *
 * A single failed request is not evidence that the endpoint is down. It can be one slow request, a cold
 * model, or a payload the endpoint refused for reasons of its own, and pausing every later consult for
 * `cooldownMs` after one of them turns a single bad request into a half-minute blackout in which the gate
 * silently falls back to prompting. So the breaker opens only after {@link CONSECUTIVE_FAILURES_BEFORE_COOLDOWN}
 * consecutive requests failed, and an answer — even an unhelpful one — closes the streak.
 *
 * The cooldown is a pause, not a verdict: it holds no answer, grants nothing, and the first consult after it
 * expires tries the endpoint again from a clean streak. Callers keep their own policy for what a failure
 * means; this class only decides when a run of them is long enough to stop paying the timeout.
 */
export const CONSECUTIVE_FAILURES_BEFORE_COOLDOWN = 2;

export class FailureCooldown {
    private until = 0;
    private streak = 0;

    constructor(
        private readonly now: () => number,
        private readonly threshold: number = CONSECUTIVE_FAILURES_BEFORE_COOLDOWN,
    ) {}

    /** Whether the breaker is open, so the caller should skip the request. */
    get active(): boolean {
        return this.now() < this.until;
    }

    /**
     * The endpoint answered this request.
     *
     * A refusal it produced itself — the deterministic "input too large" — still counts: the endpoint is
     * reachable, and the memo for that payload is what keeps it from being sent again.
     */
    answered(): void {
        this.streak = 0;
    }

    /** The request ended in an error or a timeout; opens the breaker once the streak reaches the threshold. */
    failed(cooldownMs: number): void {
        this.streak += 1;
        if (this.streak < this.threshold) {
            return;
        }

        this.until = this.now() + cooldownMs;
        this.streak = 0;
    }
}
