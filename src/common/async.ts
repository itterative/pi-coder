/**
 * A queue that runs one task at a time.
 *
 * Tasks start in the order they were added and only once the task before them has settled, so a caller whose
 * tasks write the same state gets the order it asked for without holding a lock of its own. A task's rejection
 * reaches its own caller and never wedges the queue, which is why the chain is kept separate from the task
 * promises: `idle()` resolves when everything added so far has settled, including what failed.
 */
export class SerialQueue {
    private tail: Promise<void> = Promise.resolve();

    /** Add a task; the returned promise settles with it, and the queue moves on either way. */
    add<T>(task: () => Promise<T>): Promise<T> {
        const run = this.tail.then(task, task);
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Wait for every task added so far to settle. */
    idle(): Promise<void> {
        return this.tail;
    }
}

/** Wait for a duration, rejecting promptly when the optional signal aborts. */
export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line prefer-const
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
            cleanup();
            reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, milliseconds);
        timer.unref?.();
    });
}
