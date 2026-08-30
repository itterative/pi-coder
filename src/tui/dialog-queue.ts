import type { EventBus } from "@earendil-works/pi-coding-agent";

export const TUI_DIALOG_EVENT = "pi-coder:tui-dialog";

export interface TuiDialogEvent {
    active: boolean;
}

let dialogQueue: Promise<void> = Promise.resolve();
const dialogActiveStates = new WeakMap<object, boolean>();
const pendingDialogs = new WeakMap<object, number>();

export function isDialogActive(events: EventBus | undefined): boolean {
    return events ? dialogActiveStates.get(events) === true : false;
}

/** Whether another dialog is waiting behind the currently displayed one. */
export function hasQueuedDialog(events: EventBus | undefined): boolean {
    return events ? (pendingDialogs.get(events) ?? 0) > 0 : false;
}

function incrementPending(events: EventBus | undefined): void {
    if (!events) return;
    pendingDialogs.set(events, (pendingDialogs.get(events) ?? 0) + 1);
}

function decrementPending(events: EventBus | undefined): number {
    if (!events) return 0;
    const remaining = Math.max(0, (pendingDialogs.get(events) ?? 1) - 1);
    if (remaining === 0) {
        pendingDialogs.delete(events);
    } else {
        pendingDialogs.set(events, remaining);
    }
    return remaining;
}

function emitDialogState(events: EventBus | undefined, active: boolean): void {
    if (!events || dialogActiveStates.get(events) === active) return;
    dialogActiveStates.set(events, active);
    events.emit(TUI_DIALOG_EVENT, { active } satisfies TuiDialogEvent);
}

function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<boolean> {
    if (!signal)
        return turn.then(
            () => true,
            () => true,
        );
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
        void turn.then(
            () => finish(true),
            () => finish(true),
        );
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
    events?: EventBus,
): Promise<T | undefined> {
    if (signal?.aborted) return undefined;

    incrementPending(events);

    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
        release = resolve;
    });
    const previous = dialogQueue;
    dialogQueue = previous.catch(() => {}).then(() => completed);

    const acquired = await waitForTurn(previous, signal);
    if (!acquired || signal?.aborted) {
        if (decrementPending(events) === 0 && !isDialogActive(events)) {
            emitDialogState(events, false);
        }
        release();
        return undefined;
    }

    decrementPending(events);
    emitDialogState(events, true);
    try {
        return await show();
    } finally {
        const hasPendingSameBus = events !== undefined && pendingDialogs.get(events) !== undefined;
        if (!hasPendingSameBus) {
            emitDialogState(events, false);
        }
        release();
    }
}
