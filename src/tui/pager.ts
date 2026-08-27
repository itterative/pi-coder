/**
 * Pager Component
 *
 * A read-only scrollable list. Unlike select/multi-select it has no cursor —
 * scrolling is driven externally (via state.scrollOffset and the onKey hook).
 * Built on ListViewComponent.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Container } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ItemPrefix, ListItem, ListViewRenderItemOptions, ListViewState } from "./list-view";
import { ListViewComponent } from "./list-view";

// An item in the pager
export type PagerItem<T> = ListItem<T>;

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
    // Optional fixed total frame height, evaluated on each render
    fixedHeight?: () => number;
    // Called after the visual-line cache is rebuilt.
    onCacheBuilt?: (totalLines: number) => void;
    // Remove the blank rows around the help footer
    compactFooter?: boolean;
    // Hook to intercept keys. Return true to indicate key was handled, or { done: true } to close the pager.
    onKey?: (key: string, state: PagerState<T>) => boolean | { done: boolean };
}

// Internal state for the pager
export interface PagerState<T> extends ListViewState<T> {
    // Pagers have no cursor — scrolling is externally driven
    cursor: null;
}

/**
 * PagerComponent - A scrollable list display component.
 *
 * Renders a list of items with scrolling support, title, help text,
 * and optional header/footer content.
 */
export class PagerComponent<T> extends ListViewComponent<T, void, PagerState<T>> {
    constructor(
        public readonly options: PagerOptions<T>,
    ) {
        super(
            {
                title: options.title,
                renderItem: options.renderItem
                    ? (item, renderOptions: ListViewRenderItemOptions<T, PagerState<T>>) =>
                        options.renderItem!(item, {
                            index: renderOptions.index,
                            theme: renderOptions.theme,
                            state: renderOptions.state,
                        })
                    : undefined,
                headerContent: options.headerContent,
                footerContent: options.footerContent,
                helpText: options.helpText ?? "Esc close",
                onKey: options.onKey,
                paddingX: options.paddingX,
                paddingY: options.paddingY,
                fixedHeight: options.fixedHeight,
                onCacheBuilt: options.onCacheBuilt,
                compactFooter: options.compactFooter,
            },
            {
                items: options.items,
                cursor: null,
                scrollOffset: options.scrollOffset,
                maxVisibleLines: options.maxVisibleLines ?? 10,
            },
        );
    }

    // Pager items render without any cursor/prefix decoration
    protected override getItemPrefix(_index: number, _isCursor: boolean): ItemPrefix {
        return { first: "", continuation: "" };
    }

    protected override handleAction(key: string): void {
        if (matchesKey(key, "escape") || key === "q") {
            this.finish(undefined);
            return;
        }
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
