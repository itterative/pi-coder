/**
 * Rendering tests for PagerComponent — driven headlessly, snapshotted via
 * renderText(). The pager has no cursor; scrolling is driven externally via
 * the onKey hook, which is exercised here.
 */

import { describe, expect, it } from "vitest";
import { PagerComponent, type PagerOptions } from "../src/tui/pager";
import { KEY, mockTheme, press, renderText } from "./helpers";

function setup<T>(options: PagerOptions<T>) {
    let closed = false;
    const component = new PagerComponent(options);
    component.setDoneCallback(() => { closed = true; });
    component.initialize(mockTheme);
    return { component, closed: () => closed };
}

const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Line ${i}` }));

// onKey hook that scrolls with up/down (a typical pager usage)
function scrollKeys(options: PagerOptions<string>): PagerOptions<string> {
    return {
        ...options,
        onKey: (key, state) => {
            if (key === KEY.up || key === "k") {
                state.scrollOffset = Math.max(0, state.scrollOffset - 1);
                return true;
            }
            if (key === KEY.down || key === "j") {
                state.scrollOffset += 1;
                return true;
            }
            return false;
        },
    };
}

describe("PagerComponent", () => {
    it("renders items from the initial scroll offset", async () => {
        const { component } = setup({ title: "Log", items: items(3), scrollOffset: 0 });
        await expect(renderText(component)).toMatchFileSnapshot("__snapshots__/pager.initial-scroll.txt");
    });

    it("scrolls via the onKey hook and shows the scroll indicator", async () => {
        const { component } = setup(scrollKeys({
            title: "Log",
            items: items(8),
            scrollOffset: 0,
            maxVisibleLines: 4,
        }));
        await expect(renderText(component)).toMatchFileSnapshot("__snapshots__/pager.scroll-down.txt");
        press(component, KEY.down, KEY.down, KEY.down);
        await expect(renderText(component)).toMatchFileSnapshot("__snapshots__/pager.after-navigation-down.txt");
        press(component, KEY.up);
        await expect(renderText(component)).toMatchFileSnapshot("__snapshots__/pager.after-navigation-up.txt");
    });

    it("closes on Escape and q", () => {
        const a = setup({ title: "Log", items: items(3), scrollOffset: 0 });
        press(a.component, KEY.escape);
        expect(a.closed()).toBe(true);

        const b = setup({ title: "Log", items: items(3), scrollOffset: 0 });
        press(b.component, "q");
        expect(b.closed()).toBe(true);
    });

    it("supports multi-line items and custom renderItem", async () => {
        const { component } = setup({
            title: "Details",
            items: [
                { value: "a", label: "First" },
                { value: "b", label: "Second" },
            ],
            scrollOffset: 0,
            renderItem: (item) => `${item.label}\n  detail for ${item.value}`,
        });
        await expect(renderText(component)).toMatchFileSnapshot("__snapshots__/pager.multiline-items.txt");
    });
});
