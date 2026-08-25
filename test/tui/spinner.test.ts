import { describe, expect, it, vi } from "vitest";
import { Spinner } from "../../src/tui/spinner";

function fakeTui() {
    return { requestRender: vi.fn() } as any;
}

describe("Spinner", () => {
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
