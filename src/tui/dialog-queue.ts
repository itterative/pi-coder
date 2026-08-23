let dialogQueue: Promise<void> = Promise.resolve();

function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<boolean> {
    if (!signal) return turn.then(() => true, () => true);
    if (signal.aborted) return Promise.resolve(false);

    return new Promise((resolve) => {
        let settled = false;
        let abort = () => {};
        const finish = (acquired: boolean) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            resolve(acquired);
        };
        abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        void turn.then(() => finish(true), () => finish(true));
    });
}

/**
 * Serialize modal TUI dialogs across parent tools and delegated agents.
 * Aborted queued callers return immediately without allowing later dialogs to
 * overtake the currently displayed one.
 */
export async function withDialogQueue<T>(
    signal: AbortSignal | undefined,
    show: () => Promise<T>,
): Promise<T | undefined> {
    if (signal?.aborted) return undefined;

    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    const previous = dialogQueue;
    dialogQueue = previous.catch(() => {}).then(() => completed);

    const acquired = await waitForTurn(previous, signal);
    if (!acquired || signal?.aborted) {
        release();
        return undefined;
    }

    try {
        return await show();
    } finally {
        release();
    }
}
