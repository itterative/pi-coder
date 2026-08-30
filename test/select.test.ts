/**
 * Rendering tests for SelectComponent — driven headlessly with mocked theme,
 * snapshotted via renderText().
 */

import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SelectComponent, type SelectOptions } from "../src/tui/select";
import { KEY, mockTheme, press, renderText, type as typeText } from "./helpers";

function setup<T>(options: SelectOptions<T>) {
    let result: T | undefined | "pending" = "pending";
    const component = new SelectComponent(options);
    component.setDoneCallback((value) => {
        result = value;
    });
    component.initialize(mockTheme);
    return { component, result: () => result };
}

const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }));

describe("SelectComponent", () => {
    it("renders initial state with cursor on first item", async () => {
        const { component } = setup({ title: "Pick one", items: items(3) });
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.initial-cursor.txt",
        );
    });

    it("moves the cursor with arrow keys and j/k", async () => {
        const { component } = setup({ title: "Pick one", items: items(3) });
        press(component, KEY.down);
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.after-down.txt",
        );
        press(component, "k");
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.after-up.txt",
        );
    });

    it("shows a scroll indicator when items exceed maxVisible", async () => {
        const { component } = setup({ title: "Many", items: items(8), maxVisible: 4 });
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.scroll-indicator-initial.txt",
        );
        press(component, KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.scroll-indicator-after-down.txt",
        );
    });

    it("filters items while typing and displays the search at the bottom", async () => {
        const { component, result } = setup({
            title: "Pick a model",
            items: [
                { value: "alpha", label: "Alpha model" },
                { value: "beta", label: "Beta model" },
                { value: "gamma", label: "Gamma model" },
            ],
            enableSearch: true,
        });
        typeText(component, "beta");

        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.search-filtered.txt",
        );
        press(component, KEY.enter);
        expect(result()).toBe("beta");
    });

    it("confirms the cursor item on Enter", () => {
        const { component, result } = setup({ title: "Pick one", items: items(3) });
        press(component, KEY.down, KEY.enter);
        expect(result()).toBe("v1");
    });

    it("cancels on Escape and q", () => {
        const a = setup({ title: "Pick one", items: items(3) });
        press(a.component, KEY.escape);
        expect(a.result()).toBeUndefined();

        const b = setup({ title: "Pick one", items: items(3) });
        press(b.component, "q");
        expect(b.result()).toBeUndefined();
    });

    it("supports custom renderItem and footerContent", async () => {
        const { component } = setup<string>({
            title: "Custom",
            items: items(2),
            renderItem: (item, { isCursor }) => `${item.label}${isCursor ? " <" : ""}`,
            footerContent: (container, _theme, state) => {
                container.addChild(new Text(`  cursor at ${state.cursor}`, 1, 0));
            },
        });
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/select.custom-footer.txt",
        );
    });
});
