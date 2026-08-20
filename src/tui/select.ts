/**
 * Select Component
 *
 * A single-select UI component with cursor navigation and scrolling.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
    Box,
    Container,
    matchesKey,
    Spacer,
    Text,
} from "@earendil-works/pi-tui";
import { indentLines } from "../common/text";
import type { PagerItem } from "./pager";

// Options passed to renderItem callback
export interface SelectRenderItemOptions<T> {
    index: number;
    isCursor: boolean;
    theme: Theme;
    state: SelectState<T>;
}

// Options for the select component
export interface SelectOptions<T> {
    // Title shown at the top
    title: string;
    // Items to display
    items: PagerItem<T>[];
    // Initial cursor position
    initialCursor?: number;
    // Maximum visible items before scrolling
    maxVisible?: number;
    // Custom render function for item content (cursor marker is added automatically)
    renderItem?: (
        item: PagerItem<T>,
        options: SelectRenderItemOptions<T>,
    ) => string;
    // Optional header content rendered after title
    headerContent?: (container: Container, theme: Theme) => void;
    // Optional footer content rendered before help text
    footerContent?: (container: Container, theme: Theme, state: SelectState<T>) => void;
    // Custom help text (defaults to standard navigation help)
    helpText?: string;
    // Hook to intercept keys before select handles them. Return true to indicate key was handled, or { done: true } to close.
    onKey?: (key: string, state: SelectState<T>) => boolean | { done: boolean };
}

// Internal state for the select
export interface SelectState<T> {
    items: PagerItem<T>[];
    cursor: number;
    maxVisibleLines: number;
}

// Default render for an item's content (just the label)
function defaultRenderItem<T>(
    item: PagerItem<T>,
    options: SelectRenderItemOptions<T>,
): string {
    if (options.isCursor) {
        return options.theme.fg("accent", item.label);
    }
    return item.label;
}

// Calculate scroll offset: ensure cursor item is visible
function calculateScrollOffset(
    itemStartLines: number[],
    cursor: number,
    totalLines: number,
    maxVisibleLines: number,
): number {
    const cursorStartLine = itemStartLines[cursor] ?? 0;
    const linesAfterCursor = totalLines - cursorStartLine;

    if (linesAfterCursor <= maxVisibleLines) {
        return Math.max(0, totalLines - maxVisibleLines);
    } else {
        return cursorStartLine;
    }
}

/**
 * SelectComponent - A single-select component with cursor navigation.
 *
 * Renders a list of items with a cursor that can be navigated with arrow keys.
 * Supports multi-line items with proper scrolling.
 */
export class SelectComponent<T> implements Component {
    private container: Container;
    private contentContainer: Box;
    private theme: Theme | null = null;
    private readonly renderItem: (item: PagerItem<T>, options: SelectRenderItemOptions<T>) => string;
    private readonly helpText: string;
    private readonly paddingX = 2;
    private readonly paddingY = 0;
    private done: ((value: T | undefined) => void) | null = null;
    private scrollOffset = 0;
    private confirmed = false;

    // Cache built during render: lines per item and start line for each item
    private cachedItemLines: string[][] = [];
    private cachedItemStartLines: number[] = [];
    private cachedTotalLines = 0;

    readonly state: SelectState<T>;

    constructor(
        public readonly options: SelectOptions<T>,
    ) {
        this.renderItem = options.renderItem ?? defaultRenderItem;
        this.helpText = options.helpText ?? "↑/↓ navigate | Enter confirm | Esc cancel";

        this.state = {
            items: options.items,
            cursor: options.initialCursor ?? 0,
            maxVisibleLines: options.maxVisible ?? 10,
        };

        this.container = new Container();
        this.contentContainer = new Box(this.paddingX, this.paddingY);
    }

    /**
     * Set the done callback - called when select should close
     */
    setDoneCallback(done: (value: T | undefined) => void): void {
        this.done = done;
    }

    /**
     * Initialize the component with a theme. Must be called before render.
     */
    initialize(theme: Theme): void {
        this.theme = theme;
        const borderColor = (s: string) => theme.fg("border", s);

        this.container.addChild(new DynamicBorder(borderColor));

        // Header
        this.container.addChild(
            new Text(
                theme.fg("accent", theme.bold(`  ${this.options.title}`)),
                1,
                0,
            ),
        );
        this.container.addChild(new Spacer(1));

        // Custom header content if provided
        if (this.options.headerContent) {
            this.options.headerContent(this.container, theme);
            this.container.addChild(new Spacer(1));
        }

        // Content container for item list and status
        this.container.addChild(this.contentContainer);

        this.container.addChild(new Spacer(1));
        this.container.addChild(new DynamicBorder(borderColor));
    }

    /**
     * Returns true if selection was confirmed (vs cancelled)
     */
    isConfirmed(): boolean {
        return this.confirmed;
    }

    render(width: number): string[] {
        if (!this.theme) {
            throw new Error("SelectComponent must be initialized with a theme before rendering");
        }
        this.buildCacheAndUpdateScroll();
        this.updateContent();
        return this.container.render(width);
    }

    invalidate(): void {
        this.container.invalidate();
    }

    handleInput(key: string): void {
        // Allow external key handler to intercept first
        if (this.options.onKey) {
            const result = this.options.onKey(key, this.state);
            if (result === true) {
                this.scrollOffset = calculateScrollOffset(
                    this.cachedItemStartLines,
                    this.state.cursor,
                    this.cachedTotalLines,
                    this.state.maxVisibleLines,
                );
                this.invalidate();
                return;
            }
            if (typeof result === "object" && result.done) {
                this.confirmed = true;
                this.done?.(this.options.items[this.state.cursor]?.value);
                return;
            }
        }

        if (matchesKey(key, "up") || key === "k") {
            if (this.state.cursor > 0) {
                this.state.cursor--;
                this.scrollOffset = calculateScrollOffset(
                    this.cachedItemStartLines,
                    this.state.cursor,
                    this.cachedTotalLines,
                    this.state.maxVisibleLines,
                );
                this.invalidate();
            }
            return;
        }

        if (matchesKey(key, "down") || key === "j") {
            if (this.state.cursor < this.options.items.length - 1) {
                this.state.cursor++;
                this.scrollOffset = calculateScrollOffset(
                    this.cachedItemStartLines,
                    this.state.cursor,
                    this.cachedTotalLines,
                    this.state.maxVisibleLines,
                );
                this.invalidate();
            }
            return;
        }

        if (matchesKey(key, "enter")) {
            this.confirmed = true;
            this.done?.(this.options.items[this.state.cursor]?.value);
            return;
        }

        if (matchesKey(key, "escape") || key === "q") {
            this.done?.(undefined);
            return;
        }
    }

    /**
     * Build cache of rendered lines per item. Called once per render.
     */
    private buildCacheAndUpdateScroll(): void {
        if (!this.theme) return;

        this.cachedItemLines = [];
        this.cachedItemStartLines = [];
        let totalLines = 0;

        for (let i = 0; i < this.state.items.length; i++) {
            const item = this.state.items[i];
            if (!item) {
                this.cachedItemLines.push([]);
                this.cachedItemStartLines.push(totalLines);
                continue;
            }

            const isCursor = i === this.state.cursor;
            const selectOptions: SelectRenderItemOptions<T> = {
                index: i,
                isCursor,
                theme: this.theme,
                state: this.state,
            };

            const content = this.renderItem(item, selectOptions);

            // Add cursor marker and indent multi-line content
            const cursorMarker = isCursor ? "→ " : "  ";
            const prefix = isCursor
                ? this.theme.fg("accent", cursorMarker)
                : cursorMarker;

            const indented = indentLines(content, {
                firstLinePrefix: prefix,
                continuationPrefix: "  ",
            });
            const lines = indented.split("\n");

            this.cachedItemStartLines.push(totalLines);
            this.cachedItemLines.push(lines);
            totalLines += lines.length;
        }

        this.cachedTotalLines = totalLines;
        this.scrollOffset = calculateScrollOffset(
            this.cachedItemStartLines,
            this.state.cursor,
            totalLines,
            this.state.maxVisibleLines,
        );
    }

    private updateContent(): void {
        if (!this.theme) return;

        this.contentContainer.clear();

        // Flatten cached lines
        const allLines = this.cachedItemLines.flat();
        const totalLines = this.cachedTotalLines;
        const visibleLines = allLines.slice(
            this.scrollOffset,
            this.scrollOffset + this.state.maxVisibleLines,
        );

        // Render visible lines
        for (const line of visibleLines) {
            // Use Spacer for blank lines to ensure they take up space
            if (line.trim() === "") {
                this.contentContainer.addChild(new Spacer(1));
            } else {
                this.contentContainer.addChild(new Text(line, 1, 0));
            }
        }

        // Scroll indicator
        if (totalLines > this.state.maxVisibleLines) {
            const endLine = this.scrollOffset + visibleLines.length;
            const showing = `  Showing lines ${this.scrollOffset + 1}-${endLine} of ${totalLines}`;
            this.contentContainer.addChild(new Spacer(1));
            this.contentContainer.addChild(
                new Text(this.theme.fg("dim", showing), 1, 0),
            );
        }

        // Custom footer content if provided
        if (this.options.footerContent) {
            this.options.footerContent(this.contentContainer, this.theme, this.state);
        }

        this.contentContainer.addChild(new Spacer(1));

        // Help text
        this.contentContainer.addChild(
            new Text(this.theme.fg("muted", `  ${this.helpText}`), 1, 0),
        );
    }
}

// Show select UI and return selected value (or undefined if cancelled)
export async function select<T>(
    options: SelectOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<T | undefined> {
    if (!ctx.hasUI) {
        return undefined;
    }

    if (options.items.length === 0) {
        return undefined;
    }

    return ctx.ui.custom<T | undefined>((_tui, theme, _kb, done) => {
        const component = new SelectComponent(options);
        component.setDoneCallback(done);
        component.initialize(theme);

        return component;
    });
}

// Re-export types from pager for convenience
export type { PagerItem } from "./pager";
