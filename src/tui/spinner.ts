import type { Component, TUI } from "@earendil-works/pi-tui";

export const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerOptions {
    frames?: readonly string[];
    intervalMs?: number;
}

/** Small reusable animated spinner for custom TUI components. */
export class Spinner implements Component {
    private readonly frames: readonly string[];
    private readonly intervalMs: number;
    private readonly ui: TUI;
    private frameIndex = 0;
    private intervalId?: ReturnType<typeof setInterval>;

    constructor(ui: TUI, options: SpinnerOptions = {}) {
        this.ui = ui;
        this.frames = options.frames?.length ? [...options.frames] : DEFAULT_SPINNER_FRAMES;
        this.intervalMs = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : 80;
    }

    getFrame(): string {
        return this.frames[this.frameIndex] ?? "";
    }

    render(_width: number): string[] {
        return [this.getFrame()];
    }

    invalidate(): void {
        // The spinner has no render cache.
    }

    start(): void {
        if (this.intervalId || this.frames.length <= 1) return;

        this.intervalId = setInterval(() => {
            this.frameIndex = (this.frameIndex + 1) % this.frames.length;
            this.ui.requestRender();
        }, this.intervalMs);
    }

    stop(): void {
        if (!this.intervalId) return;
        clearInterval(this.intervalId);
        this.intervalId = undefined;
    }

    setActive(active: boolean): void {
        if (active) {
            this.start();
            return;
        }
        this.stop();
    }

    dispose(): void {
        this.stop();
    }
}
