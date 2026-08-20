/**
 * List View Component
 *
 * A composable base for framed, scrollable item-list dialogs (pager, select,
 * multi-select). It owns everything the list dialogs used to copy-paste:
 *
 * - the frame scaffolding (DynamicBorder, title, header/footer content slots)
 * - per-item render caching with first-line/continuation prefixes
 * - cursor-follow scrolling for multi-line items
 * - the scroll indicator and help text
 * - ↑/↓/j/k navigation and the onKey interception hook
 *
 * Subclasses only define what makes them different:
 * - getItemPrefix()   — e.g. "→ " for select, "→ [x] " for multi-select
 * - handleAction()    — confirm/cancel/extra keys (Enter, Space, ...)
 * - onExternalDone()  — what { done: true } from the onKey hook means
 * - renderStatus()    — optional status lines above the footer
 *
 * Type parameters:
 * - T: item value type
 * - R: result type passed to the done callback
 * - S: state shape (must extend ListViewState<T>); subclasses may add fields
 *      (e.g. MultiSelectState adds `selected`)
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
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

// An item in the list
export interface ListItem<T> {
    value: T;
    label: string;
    disabled?: boolean;
}

// Base state for list views. Subclass states may narrow `cursor` (number for
// cursor-driven lists, null for externally-scrolled lists) and add fields.
export interface ListViewState<T> {
    items: ListItem<T>[];
    // Current cursor index, or null for lists without a cursor (pager mode —
    // scrolling is then driven externally via state.scrollOffset)
    cursor: number | null;
    scrollOffset: number;
    maxVisibleLines: number;
}

// Options passed to the renderItem callback
export interface ListViewRenderItemOptions<T, S extends ListViewState<T> = ListViewState<T>> {
    index: number;
    isCursor: boolean;
    theme: Theme;
    state: S;
}

// Prefixes rendered before an item's content
export interface ItemPrefix {
    // Prefix for the first line (e.g. "→ ")
    first: string;
    // Prefix for continuation lines of multi-line items
    continuation: string;
}

// Options for the list view
export interface ListViewOptions<T, S extends ListViewState<T> = ListViewState<T>> {
    // Title shown at the top
    title: string;
    // Custom render function for item content (prefix is added automatically)
    renderItem?: (item: ListItem<T>, options: ListViewRenderItemOptions<T, S>) => string;
    // Optional header content rendered after title
    headerContent?: (container: Container, theme: Theme) => void;
    // Optional footer content rendered before help text
    footerContent?: (container: Container, theme: Theme, state: S) => void;
    // Help text shown at the bottom
    helpText: string;
    // Hook to intercept keys before built-in handling. Return true to indicate
    // the key was handled, or { done: true } to close (see onExternalDone).
    onKey?: (key: string, state: S) => boolean | { done: boolean };
    // Horizontal padding for content (default: 2)
    paddingX?: number;
    // Vertical padding for content (default: 0)
    paddingY?: number;
}

// Calculate scroll offset: ensure cursor item is visible
export function calculateScrollOffset(
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
 * ListViewComponent - base class for framed scrollable list dialogs.
 */
export class ListViewComponent<
    T,
    R,
    S extends ListViewState<T> = ListViewState<T>,
> implements Component {
    protected theme: Theme | null = null;
    private readonly container: Container;
    private readonly contentContainer: Box;
    private done: ((result: R) => void) | null = null;

    // Cache built during render: lines per item and start line for each item
    private cachedItemLines: string[][] = [];
    private cachedItemStartLines: number[] = [];
    private cachedTotalLines = 0;

    constructor(
        protected readonly listOptions: ListViewOptions<T, S>,
        readonly state: S,
    ) {
        this.container = new Container();
        this.contentContainer = new Box(
            listOptions.paddingX ?? 2,
            listOptions.paddingY ?? 0,
        );
    }

    /**
     * Set the done callback - called when the dialog should close
     */
    setDoneCallback(done: (result: R) => void): void {
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
                theme.fg("accent", theme.bold(`  ${this.listOptions.title}`)),
                1,
                0,
            ),
        );
        this.container.addChild(new Spacer(1));

        // Custom header content if provided
        if (this.listOptions.headerContent) {
            this.listOptions.headerContent(this.container, theme);
            this.container.addChild(new Spacer(1));
        }

        // Content container for item list and status
        this.container.addChild(this.contentContainer);

        this.container.addChild(new Spacer(1));
        this.container.addChild(new DynamicBorder(borderColor));
    }

    render(width: number): string[] {
        if (!this.theme) {
            throw new Error("ListViewComponent must be initialized with a theme before rendering");
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
        if (this.listOptions.onKey) {
            const result = this.listOptions.onKey(key, this.state);
            if (result === true) {
                this.updateScrollOffset();
                this.invalidate();
                return;
            }
            if (typeof result === "object" && result.done) {
                this.onExternalDone();
                return;
            }
        }

        // Cursor navigation
        if (this.state.cursor !== null) {
            if (matchesKey(key, "up") || key === "k") {
                this.moveCursor(-1);
                return;
            }
            if (matchesKey(key, "down") || key === "j") {
                this.moveCursor(1);
                return;
            }
        }

        this.handleAction(key);
    }

    // ── Extension points for subclasses ──────────────────────────────

    /**
     * Prefixes rendered before an item's content. Default: accent arrow on
     * the cursor line, spaces elsewhere. Override for checkboxes, no
     * prefix (pager), etc.
     */
    protected getItemPrefix(_index: number, isCursor: boolean): ItemPrefix {
        return {
            first: isCursor && this.theme ? this.theme.fg("accent", "→ ") : "  ",
            continuation: "  ",
        };
    }

    /**
     * Handle keys not consumed by the onKey hook or built-in navigation
     * (confirm, cancel, toggles, ...). Default: ignore.
     */
    protected handleAction(_key: string): void {
        // Default: no action keys
    }

    /**
     * Called when the onKey hook returns { done: true }. Subclasses decide
     * what result to finish with. Default: close with no result.
     */
    protected onExternalDone(): void {
        this.finish(undefined as R);
    }

    /**
     * Optional status lines rendered between the scroll indicator and the
     * footer content (e.g. "N item(s) selected"). Default: none.
     */
    protected renderStatus(_container: Box): void {
        // Default: no status lines
    }

    /** Finish the dialog with a result. */
    protected finish(result: R): void {
        this.done?.(result);
    }

    /** Move the cursor by delta, clamped to the item range. */
    protected moveCursor(delta: number): void {
        if (this.state.cursor === null) return;
        const next = this.state.cursor + delta;
        if (next < 0 || next > this.state.items.length - 1) return;
        this.state.cursor = next;
        this.updateScrollOffset();
        this.invalidate();
    }

    // ── Internals ────────────────────────────────────────────────────

    /** Recompute scroll offset from the cursor (no-op in cursor-less mode). */
    private updateScrollOffset(): void {
        if (this.state.cursor === null) return;
        this.state.scrollOffset = calculateScrollOffset(
            this.cachedItemStartLines,
            this.state.cursor,
            this.cachedTotalLines,
            this.state.maxVisibleLines,
        );
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
            const renderOptions: ListViewRenderItemOptions<T, S> = {
                index: i,
                isCursor,
                theme: this.theme,
                state: this.state,
            };

            const renderItem = this.listOptions.renderItem ?? defaultRenderItem;
            const content = renderItem(item, renderOptions);

            const prefix = this.getItemPrefix(i, isCursor);
            const indented = indentLines(content, {
                firstLinePrefix: prefix.first,
                continuationPrefix: prefix.continuation,
            });
            const lines = indented.split("\n");

            this.cachedItemStartLines.push(totalLines);
            this.cachedItemLines.push(lines);
            totalLines += lines.length;
        }

        this.cachedTotalLines = totalLines;
        this.updateScrollOffset();
    }

    private updateContent(): void {
        if (!this.theme) return;

        this.contentContainer.clear();

        // Flatten cached lines
        const allLines = this.cachedItemLines.flat();
        const totalLines = this.cachedTotalLines;
        const visibleLines = allLines.slice(
            this.state.scrollOffset,
            this.state.scrollOffset + this.state.maxVisibleLines,
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
            const endLine = this.state.scrollOffset + visibleLines.length;
            const showing = `  Showing lines ${this.state.scrollOffset + 1}-${endLine} of ${totalLines}`;
            this.contentContainer.addChild(new Spacer(1));
            this.contentContainer.addChild(
                new Text(this.theme.fg("dim", showing), 1, 0),
            );
        }

        // Status lines (e.g. selection count)
        this.renderStatus(this.contentContainer);

        // Custom footer content if provided
        if (this.listOptions.footerContent) {
            this.listOptions.footerContent(this.contentContainer, this.theme, this.state);
        }

        this.contentContainer.addChild(new Spacer(1));

        // Help text
        this.contentContainer.addChild(
            new Text(this.theme.fg("muted", `  ${this.listOptions.helpText}`), 1, 0),
        );
    }
}

// Default render for an item's content: accent-highlighted on the cursor
// line, plain label elsewhere.
function defaultRenderItem<T, S extends ListViewState<T>>(
    item: ListItem<T>,
    options: ListViewRenderItemOptions<T, S>,
): string {
    if (options.isCursor) {
        return options.theme.fg("accent", item.label);
    }
    return item.label;
}
