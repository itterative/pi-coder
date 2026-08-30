import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { BORDER_STYLES, BorderBox } from "./border-box";
import { InlineEditor } from "./inline-editor";
import { withOverlayStack } from "./overlay-stack";

const HORIZONTAL_PADDING = 4;

export type NumericInputParseResult<T extends number> = { value: T } | { error: string };

export interface NumericInputOptions<T extends number> {
    title: string;
    initialValue: T;
    description?: string;
    placeholder?: string;
    helpText?: string;
    format?: (value: T) => string;
    parse: (text: string) => NumericInputParseResult<T>;
}

/** Reusable inline numeric editor with caller-provided parsing and validation. */
export class NumericInputComponent<T extends number> implements Component, Focusable {
    private readonly container = new Container();
    private readonly contentBox = new Box(1, 0);
    private readonly editor = new InlineEditor();
    private readonly placeholder: string;
    private readonly helpText: string;
    private borderedContainer: BorderBox | null = null;
    private errorText = "";
    private theme: Theme | null = null;
    private _focused = false;
    private done!: (value: T | undefined) => void;

    constructor(private readonly options: NumericInputOptions<T>) {
        this.placeholder = options.placeholder ?? "enter a number...";
        this.helpText = options.helpText ?? "Enter save · Esc cancel";
        this.editor.setText(options.format?.(options.initialValue) ?? String(options.initialValue));
    }

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.editor.focused = value;
    }

    setDoneCallback(done: (value: T | undefined) => void): void {
        this.done = done;
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        const borderColor = (text: string) => theme.fg("border", text);
        this.container.addChild(
            new Text(theme.fg("accent", theme.bold(`  ${this.options.title}`)), 1, 0),
        );
        this.container.addChild(new Spacer(1));
        this.container.addChild(this.contentBox);
        this.container.addChild(new Spacer(1));
        this.borderedContainer = new BorderBox(this.container, {
            borderColor,
            characters: BORDER_STYLES.rounded,
        });
    }

    render(width: number): string[] {
        if (!this.theme || !this.borderedContainer) {
            throw new Error(
                "NumericInputComponent must be initialized with a theme before rendering",
            );
        }
        this.contentBox.clear();
        if (this.options.description) {
            for (const line of this.options.description.split("\n")) {
                this.contentBox.addChild(new Text(`  ${line}`, 1, 0));
            }
            this.contentBox.addChild(new Spacer(1));
        }
        if (this.errorText) {
            this.contentBox.addChild(new Text(this.theme.fg("error", `  ${this.errorText}`), 1, 0));
            this.contentBox.addChild(new Spacer(1));
        }

        const contentWidth = Math.max(1, width - HORIZONTAL_PADDING);
        const markerPrefix = this.theme.fg("accent", "→ ");
        const label = this.theme.fg("muted", "Value: ");
        const prefixWidth = visibleWidth(markerPrefix) + visibleWidth(label);
        const lines = this.editor.renderLines({
            width: Math.max(1, contentWidth - prefixWidth - 1),
            placeholder: this.theme.fg("dim", this.placeholder),
            firstLinePrefix: label,
            linePrefixFor: (lineIndex) =>
                lineIndex === 0 ? markerPrefix : " ".repeat(prefixWidth),
        });
        for (const line of lines) {
            this.contentBox.addChild(new Text(line, 1, 0));
        }
        this.contentBox.addChild(new Spacer(1));
        this.contentBox.addChild(new Text(this.theme.fg("muted", `  ${this.helpText}`), 1, 0));
        return this.borderedContainer.render(width);
    }

    handleInput(key: string): void {
        const paste = this.editor.handlePasteInput(key, true);
        if (paste.consumed) {
            if (paste.changed) this.invalidate();
            if (paste.remaining) this.handleInput(paste.remaining);
            return;
        }
        const result = this.editor.handleKey(key);
        if (result === "submit") {
            this.submit();
            return;
        }
        if (result === "cancel") {
            this.done(undefined);
            return;
        }
        this.invalidate();
    }

    invalidate(): void {
        this.borderedContainer?.invalidate();
    }

    private submit(): void {
        const result = this.options.parse(this.editor.text.trim());
        if ("error" in result) {
            this.errorText = result.error;
            this.invalidate();
            return;
        }
        this.done(result.value);
    }
}

export function parsePositiveInteger(text: string): NumericInputParseResult<number> {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1) {
        return { error: "Enter a positive whole number." };
    }
    return { value };
}

export async function numericInput<T extends number>(
    options: NumericInputOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<T | undefined> {
    if (!ctx.hasUI || ctx.mode !== "tui") return undefined;

    return withOverlayStack((overlay) =>
        ctx.ui.custom<T | undefined>(
            (tui, theme, _keybindings, done) => {
                const component = new NumericInputComponent(options);
                component.setDoneCallback(done);
                component.initialize(theme);
                overlay.bind(tui);
                return component;
            },
            {
                overlay: true,
                overlayOptions: {
                    width: "50%",
                    minWidth: 48,
                    maxHeight: "50%",
                    anchor: "center",
                    margin: 1,
                },
                onHandle: overlay.setHandle,
            },
        ),
    );
}
