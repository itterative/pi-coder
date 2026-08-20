/**
 * Pager Component
 *
 * A base component for scrolling through a list of items.
 * Does not manage cursor state or scrolling logic - that's handled by select.
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

// An item in the pager
export interface PagerItem<T> {
    value: T;
    label: string;
    disabled?: boolean;
}

// Options passed to renderItem callback
export interface RenderItemOptions<T> {
    index: number;
    theme: Theme;
    state: PagerState<T>;
}

// Options for the pager component
export interface PagerOptions<T> {
    // Title shown at the top
    title: string;
    // Items to display
    items: PagerItem<T>[];
    // Which line to start displaying from (scroll offset)
    scrollOffset: number;
    // Maximum visible lines before scrolling
    maxVisibleLines?: number;
    // Horizontal padding for content (default: 2)
    paddingX?: number;
    // Vertical padding for content (default: 0)
    paddingY?: number;
    // Custom render function for item content
    renderItem?: (item: PagerItem<T>, options: RenderItemOptions<T>) => string;
    // Optional header content rendered after title
    headerContent?: (container: Container, theme: Theme) => void;
    // Optional footer content rendered before help text
    footerContent?: (container: Container, theme: Theme, state: PagerState<T>) => void;
    // Custom help text
    helpText?: string;
    // Hook to intercept keys. Return true to indicate key was handled, or { done: true } to close the pager.
    onKey?: (key: string, state: PagerState<T>) => boolean | { done: boolean };
}

// Internal state for the pager
export interface PagerState<T> {
    items: PagerItem<T>[];
    scrollOffset: number;
    maxVisibleLines: number;
}

// Default render for an item's content (just the label)
function defaultRenderItem<T>(
    item: PagerItem<T>,
    _options: RenderItemOptions<T>,
): string {
    return item.label;
}

/**
 * PagerComponent - A scrollable list display component.
 *
 * Renders a list of items with scrolling support, title, help text,
 * and optional header/footer content.
 */
export class PagerComponent<T> implements Component {
    private container: Container;
    private contentContainer: Box;
    private theme: Theme | null = null;
    private readonly renderItem: (item: PagerItem<T>, options: RenderItemOptions<T>) => string;
    private readonly helpText: string;
    private readonly paddingX: number;
    private readonly paddingY: number;
    private done: (() => void) | null = null;

    readonly state: PagerState<T>;

    constructor(
        public readonly options: PagerOptions<T>,
    ) {
        this.paddingX = options.paddingX ?? 2;
        this.paddingY = options.paddingY ?? 0;
        this.renderItem = options.renderItem ?? defaultRenderItem;
        this.helpText = options.helpText ?? "Esc close";

        this.state = {
            items: options.items,
            scrollOffset: options.scrollOffset,
            maxVisibleLines: options.maxVisibleLines ?? 10,
        };

        this.container = new Container();
        this.contentContainer = new Box(this.paddingX, this.paddingY);
    }

    /**
     * Set the done callback - called when pager should close
     */
    setDoneCallback(done: () => void): void {
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

    render(width: number): string[] {
        if (!this.theme) {
            throw new Error("PagerComponent must be initialized with a theme before rendering");
        }
        this.updateContent();
        return this.container.render(width);
    }

    invalidate(): void {
        this.container.invalidate();
    }

    handleInput(data: string): void {
        // Allow external key handler to intercept first
        if (this.options.onKey) {
            const result = this.options.onKey(data, this.state);
            if (result === true) {
                this.invalidate();
                return;
            }
            if (typeof result === "object" && result.done) {
                this.done?.();
                return;
            }
        }

        if (matchesKey(data, "escape") || data === "q") {
            this.done?.();
            return;
        }
    }

    private updateContent(): void {
        if (!this.theme) return;

        this.contentContainer.clear();

        // Render all items to in-memory lines
        const allLines: string[] = [];

        for (let i = 0; i < this.state.items.length; i++) {
            const item = this.state.items[i];
            if (!item) continue;

            const renderOptions: RenderItemOptions<T> = {
                index: i,
                theme: this.theme,
                state: this.state,
            };
            const content = this.renderItem(item, renderOptions);
            allLines.push(...content.split("\n"));
        }

        const totalLines = allLines.length;
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

// Show pager UI and return when closed
export async function pager<T>(
    options: PagerOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI) {
        return;
    }

    if (options.items.length === 0) {
        return;
    }

    await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        const component = new PagerComponent(options);
        component.setDoneCallback(() => done());
        component.initialize(theme);

        return component;
    });
}
