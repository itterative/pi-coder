/**
 * Rendering tests for MultiSelectComponent — driven headlessly, snapshotted
 * via renderText().
 */

import { describe, expect, it } from "vitest";
import { MultiSelectComponent, type MultiSelectOptions } from "../src/tui/multi-select";
import { KEY, mockTheme, press, renderText } from "./helpers";

function setup<T>(options: MultiSelectOptions<T>) {
    let result: T[] | "pending" = "pending";
    const component = new MultiSelectComponent(options);
    component.setDoneCallback((value) => {
        result = value;
    });
    component.initialize(mockTheme);
    return { component, result: () => result };
}

const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }));

describe("MultiSelectComponent", () => {
    it("renders initial state with unchecked boxes", async () => {
        const { component } = setup({ title: "Pick many", items: items(3) });
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/multi-select.initial-unchecked.txt",
        );
    });

    it("toggles items with Space and shows the selection count", async () => {
        const { component } = setup({ title: "Pick many", items: items(3) });
        press(component, KEY.space);
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/multi-select.space-first.txt",
        );
        press(component, KEY.down, KEY.space);
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/multi-select.space-second.txt",
        );
    });

    it("toggles all with 'a'", async () => {
        const { component } = setup({ title: "Pick many", items: items(3) });
        press(component, "a");
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/multi-select.toggle-all.txt",
        );
        press(component, "a");
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/multi-select.toggle-all-off.txt",
        );
    });

    it("confirms selected values on Enter", () => {
        const { component, result } = setup({ title: "Pick many", items: items(3) });
        press(component, KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter);
        expect(result()).toEqual(["v0", "v2"]);
    });

    it("returns empty array on Escape", () => {
        const { component, result } = setup({
            title: "Pick many",
            items: items(3),
            initialSelected: new Set([1]),
        });
        press(component, KEY.escape);
        expect(result()).toEqual([]);
    });

    it("respects initialSelected", async () => {
        const { component } = setup({
            title: "Pick many",
            items: items(3),
            initialSelected: new Set([0, 2]),
        });
        await expect(renderText(component)).toMatchFileSnapshot(
            "__snapshots__/multi-select.initial-selected.txt",
        );
    });
});
