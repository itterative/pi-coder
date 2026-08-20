/**
 * Multi-Select Component
 *
 * A multi-select UI component with checkbox selection.
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

// An item in the multi-select list
export interface MultiSelectItem<T> {
    value: T;
    label: string;
    disabled?: boolean;
}

// Options for the multi-select component
export interface MultiSelectOptions<T> {
    // Title shown at the top
    title: string;
    // Items to display
    items: MultiSelectItem<T>[];
    // Pre-selected indices
    initialSelected?: Set<number>;
    // Initial cursor position
    initialCursor?: number;
    // Maximum visible items before scrolling
    maxVisible?: number;
    // Custom render function for item content (cursor marker and checkbox are added automatically)
    renderItem?: (
        item: MultiSelectItem<T>,
        options: MultiSelectRenderOptions<T>,
    ) => string;
    // Optional header content rendered after title
    headerContent?: (container: Container, theme: Theme) => void;
    // Optional footer content rendered before help text
    footerContent?: (container: Container, theme: Theme, state: MultiSelectState<T>) => void;
    // Custom help text (defaults to standard navigation help)
    helpText?: string;
}

// Options passed to renderItem callback
export interface MultiSelectRenderOptions<T> {
    index: number;
    isSelected: boolean;
    isCursor: boolean;
    theme: Theme;
    state: MultiSelectState<T>;
}

// Internal state for the multi-select
export interface MultiSelectState<T> {
    items: MultiSelectItem<T>[];
    cursor: number;
    maxVisibleLines: number;
    selected: Set<number>;
}

// Default render for an item's content (just the label)
function defaultRenderItem<T>(
    item: MultiSelectItem<T>,
    options: MultiSelectRenderOptions<T>,
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
 * MultiSelectComponent - A multi-select component with checkboxes.
 *
 * Renders a list of items with checkboxes that can be toggled.
 * Supports multi-line items with proper scrolling.
 */
export class MultiSelectComponent<T> implements Component {
    private container: Container;
    private contentContainer: Box;
    private theme: Theme | null = null;
    private readonly renderItem: (item: MultiSelectItem<T>, options: MultiSelectRenderOptions<T>) => string;
    private readonly helpText: string;
    private readonly paddingX = 2;
    private readonly paddingY = 0;
    private done: ((value: T[]) => void) | null = null;
    private scrollOffset = 0;
    private confirmed = false;

    // Cache built during render: lines per item and start line for each item
    private cachedItemLines: string[][] = [];
    private cachedItemStartLines: number[] = [];
    private cachedTotalLines = 0;

    readonly state: MultiSelectState<T>;

    constructor(
        public readonly options: MultiSelectOptions<T>,
    ) {
        this.renderItem = options.renderItem ?? defaultRenderItem;
        this.helpText = options.helpText ?? "↑/↓ navigate | Space toggle | a all | Enter confirm | Esc cancel";

        this.state = {
            items: options.items,
            cursor: options.initialCursor ?? 0,
            maxVisibleLines: options.maxVisible ?? 10,
            selected: new Set(options.initialSelected ?? []),
        };

        this.container = new Container();
        this.contentContainer = new Box(this.paddingX, this.paddingY);
    }

    /**
     * Set the done callback - called when multi-select should close
     */
    setDoneCallback(done: (value: T[]) => void): void {
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

    /**
     * Get selected values
     */
    getSelectedValues(): T[] {
        return Array.from(this.state.selected)
            .map((i) => this.options.items[i]?.value)
            .filter(Boolean) as T[];
    }

    render(width: number): string[] {
        if (!this.theme) {
            throw new Error("MultiSelectComponent must be initialized with a theme before rendering");
        }
        this.buildCacheAndUpdateScroll();
        this.updateContent();
        return this.container.render(width);
    }

    invalidate(): void {
        this.container.invalidate();
    }

    handleInput(key: string): void {
        // Toggle selection with Space
        if (matchesKey(key, "space")) {
            if (this.state.selected.has(this.state.cursor)) {
                this.state.selected.delete(this.state.cursor);
            } else {
                this.state.selected.add(this.state.cursor);
            }
            this.invalidate();
            return;
        }

        // Toggle all with 'a'
        if (key === "a") {
            if (this.state.selected.size === this.state.items.length) {
                this.state.selected.clear();
            } else {
                for (let i = 0; i < this.state.items.length; i++) {
                    this.state.selected.add(i);
                }
            }
            this.invalidate();
            return;
        }

        // Navigate up
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

        // Navigate down
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

        // Confirm with Enter
        if (matchesKey(key, "enter")) {
            this.confirmed = true;
            this.done?.(this.getSelectedValues());
            return;
        }

        // Cancel with Escape or 'q'
        if (matchesKey(key, "escape") || key === "q") {
            this.done?.([]);
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
            const isSelected = this.state.selected.has(i);

            const multiSelectOptions: MultiSelectRenderOptions<T> = {
                index: i,
                isSelected,
                isCursor,
                theme: this.theme,
                state: this.state,
            };

            const content = this.renderItem(item, multiSelectOptions);

            // Add checkbox prefix
            const checkbox = isSelected ? "[x]" : "[ ]";
            const prefix = isCursor
                ? this.theme.fg("accent", `→ ${checkbox} `)
                : `  ${checkbox} `;

            const indented = indentLines(content, {
                firstLinePrefix: prefix,
                continuationPrefix: "     ", // Align with checkbox
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

        // Selection count
        if (this.state.selected.size > 0) {
            this.contentContainer.addChild(new Spacer(1));
            this.contentContainer.addChild(
                new Text(
                    this.theme.fg("success", `  ${this.state.selected.size} item(s) selected`),
                    1,
                    0,
                ),
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

// Show multi-select UI and return selected values
export async function multiSelect<T>(
    options: MultiSelectOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<T[]> {
    if (!ctx.hasUI) {
        return [];
    }

    if (options.items.length === 0) {
        return [];
    }

    return ctx.ui.custom<T[]>((_tui, theme, _kb, done) => {
        const component = new MultiSelectComponent(options);
        component.setDoneCallback(done);
        component.initialize(theme);

        return component;
    });
}
