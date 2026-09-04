import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { TUI_DIALOG_EVENT, withDialogQueue } from "../../src/tui/dialog-queue";
import { stubTui } from "../helpers";
import { Spinner } from "../../src/tui/spinner";

describe("Spinner", () => {
    it("starts paused when created during an active dialog", async () => {
        vi.useFakeTimers();
        const tui = stubTui();
        const events = createEventBus();
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
        const tui = stubTui();
        const events = createEventBus();
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
        const tui = stubTui({ requestRender: vi.fn() });
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
