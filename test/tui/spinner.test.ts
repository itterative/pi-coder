import { describe, expect, it, vi } from "vitest";
import { TUI_DIALOG_EVENT, withDialogQueue } from "../../src/tui/dialog-queue";
import { Spinner } from "../../src/tui/spinner";

function fakeTui() {
    return { requestRender: vi.fn() } as any;
}

function fakeEvents() {
    const listeners = new Map<string, (data: unknown) => void>();
    return {
        on(channel: string, listener: (data: unknown) => void) {
            listeners.set(channel, listener);
            return () => listeners.delete(channel);
        },
        emit(channel: string, data: unknown) {
            listeners.get(channel)?.(data);
        },
    } as any;
}

describe("Spinner", () => {
    it("starts paused when created during an active dialog", async () => {
        vi.useFakeTimers();
        const tui = fakeTui();
        const events = fakeEvents();
        let finish!: () => void;
        const dialog = withDialogQueue(
            undefined,
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
            events,
        );
        for (let index = 0; index < 4; index++) await Promise.resolve();

        const spinner = new Spinner(tui, { frames: ["a", "b"], intervalMs: 10, events });
        spinner.setActive(true);
        vi.advanceTimersByTime(10);
        expect(spinner.render(10)).toEqual(["a"]);

        finish();
        await dialog;
        vi.advanceTimersByTime(10);
        expect(spinner.render(10)).toEqual(["b"]);

        spinner.dispose();
        vi.useRealTimers();
    });

    it("pauses while a dialog event is active", () => {
        vi.useFakeTimers();
        const tui = fakeTui();
        const events = fakeEvents();
        const spinner = new Spinner(tui, { frames: ["a", "b"], intervalMs: 10, events });
        spinner.setActive(true);

        vi.advanceTimersByTime(10);
        events.emit(TUI_DIALOG_EVENT, { active: true });
        vi.advanceTimersByTime(20);
        expect(spinner.render(10)).toEqual(["b"]);

        events.emit(TUI_DIALOG_EVENT, { active: false });
        vi.advanceTimersByTime(10);
        expect(spinner.render(10)).toEqual(["a"]);

        spinner.dispose();
        vi.useRealTimers();
    });

    it("renders frames and requests renders while active", () => {
        vi.useFakeTimers();
        const tui = fakeTui();
        const spinner = new Spinner(tui, { frames: ["a", "b"], intervalMs: 10 });

        expect(spinner.render(10)).toEqual(["a"]);
        spinner.start();
        vi.advanceTimersByTime(10);

        expect(spinner.render(10)).toEqual(["b"]);
        expect(tui.requestRender).toHaveBeenCalledTimes(1);

        spinner.dispose();
        vi.advanceTimersByTime(20);
        expect(tui.requestRender).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});
