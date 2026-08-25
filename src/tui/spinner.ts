import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { isDialogActive, TUI_DIALOG_EVENT } from "./dialog-queue";

export const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerOptions {
    frames?: readonly string[];
    intervalMs?: number;
    events?: EventBus;
}

/** Small reusable animated spinner for custom TUI components. */
export class Spinner implements Component {
    private readonly ui: TUI;
    private readonly unsubscribeEvents?: () => void;
    private readonly frames: readonly string[];
    private readonly intervalMs: number;
    private frameIndex = 0;
    private intervalId?: ReturnType<typeof setInterval>;
    private active = false;
    private paused = false;
    private disposed = false;

    constructor(ui: TUI, options: SpinnerOptions = {}) {
        this.ui = ui;
        this.frames = options.frames?.length ? [...options.frames] : DEFAULT_SPINNER_FRAMES;
        this.intervalMs = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : 80;
        this.paused = isDialogActive(options.events);
        this.unsubscribeEvents = options.events?.on(TUI_DIALOG_EVENT, (data) => {
            if (!data || typeof data !== "object" || typeof (data as { active?: unknown }).active !== "boolean") return;
            this.paused = (data as { active: boolean }).active;
            this.updateAnimation();
            this.ui.requestRender();
        });
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
        if (this.disposed) return;
        this.active = active;
        this.updateAnimation();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeEvents?.();
        this.stop();
    }

    private updateAnimation(): void {
        if (this.active && !this.paused) {
            this.start();
            return;
        }
        this.stop();
    }
}
