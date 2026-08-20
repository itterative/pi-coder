/**
 * Select Component
 *
 * A single-select UI component with cursor navigation and scrolling.
 * Built on ListViewComponent — this file only defines selection semantics
 * (Enter/Escape, confirm result) and the select-specific options.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Container } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";
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
export interface SelectState<T> extends ListViewState<T> {
    cursor: number;
}

/**
 * SelectComponent - A single-select component with cursor navigation.
 *
 * Renders a list of items with a cursor that can be navigated with arrow keys.
 * Supports multi-line items with proper scrolling.
 */
export class SelectComponent<T> extends ListViewComponent<T, T | undefined, SelectState<T>> {
    private confirmed = false;

    constructor(
        public readonly options: SelectOptions<T>,
    ) {
        super(
            {
                title: options.title,
                renderItem: options.renderItem,
                headerContent: options.headerContent,
                footerContent: options.footerContent,
                helpText: options.helpText ?? "↑/↓ navigate | Enter confirm | Esc cancel",
                onKey: options.onKey,
            },
            {
                items: options.items,
                cursor: options.initialCursor ?? 0,
                scrollOffset: 0,
                maxVisibleLines: options.maxVisible ?? 10,
            },
        );
    }

    /**
     * Returns true if selection was confirmed (vs cancelled)
     */
    isConfirmed(): boolean {
        return this.confirmed;
    }

    protected override handleAction(key: string): void {
        if (matchesKey(key, "enter")) {
            this.confirmed = true;
            this.finish(this.state.items[this.state.cursor]?.value);
            return;
        }

        if (matchesKey(key, "escape") || key === "q") {
            this.finish(undefined);
            return;
        }
    }

    protected override onExternalDone(): void {
        this.confirmed = true;
        this.finish(this.state.items[this.state.cursor]?.value);
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
