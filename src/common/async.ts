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
