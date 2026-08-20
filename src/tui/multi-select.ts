/**
 * Multi-Select Component
 *
 * A multi-select UI component with checkbox selection.
 * Built on ListViewComponent — this file only defines the checkbox prefix,
 * toggle keys (Space / a), the selection-count status line, and the
 * confirm result (array of selected values).
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Box, Container } from "@earendil-works/pi-tui";
import { matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { ItemPrefix, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";

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
export interface MultiSelectState<T> extends ListViewState<T> {
    cursor: number;
    selected: Set<number>;
}

/**
 * MultiSelectComponent - A multi-select component with checkboxes.
 *
 * Renders a list of items with checkboxes that can be toggled.
 * Supports multi-line items with proper scrolling.
 */
export class MultiSelectComponent<T> extends ListViewComponent<T, T[], MultiSelectState<T>> {
    private confirmed = false;

    constructor(
        public readonly options: MultiSelectOptions<T>,
    ) {
        super(
            {
                title: options.title,
                renderItem: options.renderItem
                    ? (item, renderOptions) => options.renderItem!(item, {
                        index: renderOptions.index,
                        isSelected: renderOptions.state.selected.has(renderOptions.index),
                        isCursor: renderOptions.isCursor,
                        theme: renderOptions.theme,
                        state: renderOptions.state,
                    })
                    : undefined,
                headerContent: options.headerContent,
                footerContent: options.footerContent,
                helpText: options.helpText ?? "↑/↓ navigate | Space toggle | a all | Enter confirm | Esc cancel",
            },
            {
                items: options.items,
                cursor: options.initialCursor ?? 0,
                scrollOffset: 0,
                maxVisibleLines: options.maxVisible ?? 10,
                selected: new Set(options.initialSelected ?? []),
            },
        );
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
            .map((i) => this.state.items[i]?.value)
            .filter(Boolean) as T[];
    }

    protected override getItemPrefix(index: number, isCursor: boolean): ItemPrefix {
        const checkbox = this.state.selected.has(index) ? "[x]" : "[ ]";
        return {
            first: isCursor && this.theme
                ? this.theme.fg("accent", `→ ${checkbox} `)
                : `  ${checkbox} `,
            continuation: "     ", // Align with checkbox
        };
    }

    protected override renderStatus(container: Box): void {
        if (!this.theme || this.state.selected.size === 0) return;
        container.addChild(new Spacer(1));
        container.addChild(
            new Text(
                this.theme.fg("success", `  ${this.state.selected.size} item(s) selected`),
                1,
                0,
            ),
        );
    }

    protected override handleAction(key: string): void {
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

        // Confirm with Enter
        if (matchesKey(key, "enter")) {
            this.confirmed = true;
            this.finish(this.getSelectedValues());
            return;
        }

        // Cancel with Escape or 'q'
        if (matchesKey(key, "escape") || key === "q") {
            this.finish([]);
            return;
        }
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
