import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * What one background pass does.
 *
 * The pass owns everything it announces and clears, because the runner below never touches the UI itself: a
 * pass that bails on its own preconditions must not clear a status a foreground build is showing.
 */
export type IdlePass = (ctx: ExtensionContext, signal: AbortSignal) => Promise<void>;

export interface IdleRefreshOptions {
    pass: IdlePass;
    /**
     * Report a pass that failed while it was still wanted.
     *
     * Called at most once per pass, and never for a pass this runner aborted — a stop is not a failure. The
     * caller owns the wording, and the call is guarded, because the session can be gone by the time a
     * background pass fails.
     */
    onFailure: (ctx: ExtensionContext, error: unknown) => void;
    /** How long `arm()` waits. */
    delayMs?: number;
}

export interface IdleRefresh {
    /** Run one pass now. Never rejects. */
    run(ctx: ExtensionContext): Promise<void>;
    /** Run one pass after the delay, replacing a timer already armed. */
    arm(ctx: ExtensionContext): void;
    /** Disarm the armed timer. An in-flight pass is left alone. */
    cancel(): void;
    /** Disarm, and abort the in-flight pass: the session that owns it is going away. */
    stop(): void;
}

/** Long enough not to race a follow-up question, short enough to keep a working session warm. */
const DEFAULT_DELAY_MS = 5 * 60_000;

/**
 * A single-flight background pass on an idle timer.
 *
 * Split out from the outline semantic refresh so its lifecycle is testable on its own, because the lifecycle is
 * where it went wrong: the pass ran detached from every handler, and one rejection took the whole process down.
 *
 * **A pass must never reject.** pi exits on an unhandled rejection, and a session whose container was closed —
 * a reload, a session switch, a sandbox restart — rejects every in-flight call, so a scan that nobody awaits is
 * exactly the shape that ends the process. This runner is the boundary that guarantees it, and it is why the
 * abort split matters: those shutdown rejections are expected, but a genuine failure should still be reported.
 *
 * **Activity and shutdown are different.** Activity (`cancel`) only disarms the timer: abandoning a build
 * halfway loses the shards it already wrote, so a user turn lets it finish. Shutdown (`stop`) also aborts,
 * because the filesystem the pass reads is about to disappear underneath it.
 */
export function idleRefresh(options: IdleRefreshOptions): IdleRefresh {
    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    let inFlight: AbortController | undefined;
    let latest: ExtensionContext | undefined;

    const cancel = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const stop = (): void => {
        cancel();
        inFlight?.abort();
    };

    const report = (ctx: ExtensionContext, error: unknown): void => {
        try {
            options.onFailure(ctx, error);
        } catch {
            // Reporting is not the pass's job, and a dead UI must not resurrect the rejection this guards.
        }
    };

    const run = async (ctx: ExtensionContext): Promise<void> => {
        if (running) {
            return;
        }

        latest = ctx;
        running = true;

        const controller = new AbortController();
        inFlight = controller;

        try {
            await options.pass(ctx, controller.signal);
        } catch (error) {
            if (!controller.signal.aborted) {
                report(ctx, error);
            }
        } finally {
            running = false;

            if (inFlight === controller) {
                inFlight = undefined;
            }
        }
    };

    const arm = (ctx: ExtensionContext): void => {
        cancel();
        latest = ctx;
        timer = setTimeout(() => {
            timer = undefined;

            if (latest !== undefined) {
                void run(latest);
            }
        }, delayMs);
        // A pending refresh must not keep pi alive after the last turn.
        timer.unref?.();
    };

    return { run, arm, cancel, stop };
}
