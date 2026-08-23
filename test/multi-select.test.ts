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
    component.setDoneCallback((value) => { result = value; });
    component.initialize(mockTheme);
    return { component, result: () => result };
}

const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }));

describe("MultiSelectComponent", () => {
    it("renders initial state with unchecked boxes", () => {
        const { component } = setup({ title: "Pick many", items: items(3) });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick many                                    │
          │                                                │
          │   → [ ] Item 0                                 │
          │     [ ] Item 1                                 │
          │     [ ] Item 2                                 │
          │                                                │
          │     ↑/↓ navigate | Space toggle | a all |      │
          │   Enter confirm | Esc cancel                   │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });

    it("toggles items with Space and shows the selection count", () => {
        const { component } = setup({ title: "Pick many", items: items(3) });
        press(component, KEY.space);
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick many                                    │
          │                                                │
          │   → [x] Item 0                                 │
          │     [ ] Item 1                                 │
          │     [ ] Item 2                                 │
          │                                                │
          │     1 item(s) selected                         │
          │                                                │
          │     ↑/↓ navigate | Space toggle | a all |      │
          │   Enter confirm | Esc cancel                   │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
        press(component, KEY.down, KEY.space);
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick many                                    │
          │                                                │
          │     [x] Item 0                                 │
          │   → [x] Item 1                                 │
          │     [ ] Item 2                                 │
          │                                                │
          │     2 item(s) selected                         │
          │                                                │
          │     ↑/↓ navigate | Space toggle | a all |      │
          │   Enter confirm | Esc cancel                   │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });

    it("toggles all with 'a'", () => {
        const { component } = setup({ title: "Pick many", items: items(3) });
        press(component, "a");
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick many                                    │
          │                                                │
          │   → [x] Item 0                                 │
          │     [x] Item 1                                 │
          │     [x] Item 2                                 │
          │                                                │
          │     3 item(s) selected                         │
          │                                                │
          │     ↑/↓ navigate | Space toggle | a all |      │
          │   Enter confirm | Esc cancel                   │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
        press(component, "a");
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick many                                    │
          │                                                │
          │   → [ ] Item 0                                 │
          │     [ ] Item 1                                 │
          │     [ ] Item 2                                 │
          │                                                │
          │     ↑/↓ navigate | Space toggle | a all |      │
          │   Enter confirm | Esc cancel                   │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });

    it("confirms selected values on Enter", () => {
        const { component, result } = setup({ title: "Pick many", items: items(3) });
        press(component, KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter);
        expect(result()).toEqual(["v0", "v2"]);
    });

    it("returns empty array on Escape", () => {
        const { component, result } = setup({ title: "Pick many", items: items(3), initialSelected: new Set([1]) });
        press(component, KEY.escape);
        expect(result()).toEqual([]);
    });

    it("respects initialSelected", () => {
        const { component } = setup({ title: "Pick many", items: items(3), initialSelected: new Set([0, 2]) });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick many                                    │
          │                                                │
          │   → [x] Item 0                                 │
          │     [ ] Item 1                                 │
          │     [x] Item 2                                 │
          │                                                │
          │     2 item(s) selected                         │
          │                                                │
          │     ↑/↓ navigate | Space toggle | a all |      │
          │   Enter confirm | Esc cancel                   │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });
});
