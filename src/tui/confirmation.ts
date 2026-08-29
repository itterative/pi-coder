import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { BORDER_STYLES, BorderBox } from "./border-box";
import { withOverlayStack } from "./overlay-stack";

export interface ConfirmationOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
}

export class ConfirmationComponent implements Component {
    private readonly container = new Container();
    private readonly content = new Box(2, 0);
    private borderedContainer: BorderBox | null = null;
    private theme: Theme | null = null;
    private done: ((confirmed: boolean) => void) | null = null;
    private settled = false;

    constructor(private readonly options: ConfirmationOptions) {}

    setDoneCallback(done: (confirmed: boolean) => void): void {
        this.done = done;
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        const borderColor = (text: string) => theme.fg("border", text);

        this.container.addChild(new Text(theme.fg("accent", theme.bold(`  ${this.options.title}`)), 1, 0));
        this.container.addChild(new Spacer(1));

        this.content.clear();
        for (const line of this.options.message.split("\n")) {
            this.content.addChild(new Text(line, 1, 0));
        }
        this.content.addChild(new Spacer(1));
        const confirmLabel = this.options.confirmLabel ?? "y/Enter confirm";
        const cancelLabel = this.options.cancelLabel ?? "n/Esc cancel";
        this.content.addChild(new Text(theme.fg("muted", `${confirmLabel} · ${cancelLabel}`), 1, 0));
        this.container.addChild(this.content);
        this.container.addChild(new Spacer(1));
        this.borderedContainer = new BorderBox(this.container, {
            borderColor,
            characters: BORDER_STYLES.rounded,
        });
    }

    render(width: number): string[] {
        if (!this.theme || !this.borderedContainer) {
            throw new Error("ConfirmationComponent must be initialized with a theme before rendering");
        }
        return this.borderedContainer.render(width);
    }

    handleInput(key: string): void {
        if (this.settled) {
            return;
        }

        if (key === "y" || matchesKey(key, "enter")) {
            this.finish(true);
            return;
        }
        if (key === "n" || matchesKey(key, "escape") || key === "q") {
            this.finish(false);
        }
    }

    invalidate(): void {
        this.container.invalidate();
    }

    private finish(confirmed: boolean): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.done?.(confirmed);
    }
}

export async function confirm(
    options: ConfirmationOptions,
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    if (!ctx.hasUI || ctx.mode !== "tui") {
        return false;
    }

    return withOverlayStack((overlay) => ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
        const component = new ConfirmationComponent(options);
        component.setDoneCallback(done);
        component.initialize(theme);
        overlay.bind(tui);
        return component;
    }, {
        overlay: true,
        overlayOptions: {
            width: "50%",
            minWidth: 48,
            maxHeight: "50%",
            anchor: "center",
            margin: 1,
        },
        onHandle: overlay.setHandle,
    }));
}
