/**
 * Rendering tests for SelectComponent — driven headlessly with mocked theme,
 * snapshotted via renderText().
 */

import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SelectComponent, type SelectOptions } from "../src/tui/select";
import { KEY, mockTheme, press, renderText } from "./helpers";

function setup<T>(options: SelectOptions<T>) {
    let result: T | undefined | "pending" = "pending";
    const component = new SelectComponent(options);
    component.setDoneCallback((value) => { result = value; });
    component.initialize(mockTheme);
    return { component, result: () => result };
}

const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }));

describe("SelectComponent", () => {
    it("renders initial state with cursor on first item", () => {
        const { component } = setup({ title: "Pick one", items: items(3) });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick one                                     │
          │                                                │
          │   → Item 0                                     │
          │     Item 1                                     │
          │     Item 2                                     │
          │                                                │
          │     ↑/↓ navigate | Enter confirm | Esc         │
          │   cancel                                       │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });

    it("moves the cursor with arrow keys and j/k", () => {
        const { component } = setup({ title: "Pick one", items: items(3) });
        press(component, KEY.down);
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick one                                     │
          │                                                │
          │     Item 0                                     │
          │   → Item 1                                     │
          │     Item 2                                     │
          │                                                │
          │     ↑/↓ navigate | Enter confirm | Esc         │
          │   cancel                                       │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
        press(component, "k");
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Pick one                                     │
          │                                                │
          │   → Item 0                                     │
          │     Item 1                                     │
          │     Item 2                                     │
          │                                                │
          │     ↑/↓ navigate | Enter confirm | Esc         │
          │   cancel                                       │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });

    it("shows a scroll indicator when items exceed maxVisible", () => {
        const { component } = setup({ title: "Many", items: items(8), maxVisible: 4 });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Many                                         │
          │                                                │
          │   → Item 0                                     │
          │     Item 1                                     │
          │     Item 2                                     │
          │     Item 3                                     │
          │                                                │
          │     Showing lines 1-4 of 8                     │
          │                                                │
          │     ↑/↓ navigate | Enter confirm | Esc         │
          │   cancel                                       │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
        press(component, KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Many                                         │
          │                                                │
          │     Item 4                                     │
          │   → Item 5                                     │
          │     Item 6                                     │
          │     Item 7                                     │
          │                                                │
          │     Showing lines 5-8 of 8                     │
          │                                                │
          │     ↑/↓ navigate | Enter confirm | Esc         │
          │   cancel                                       │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
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

    it("supports custom renderItem and footerContent", () => {
        const { component } = setup<string>({
            title: "Custom",
            items: items(2),
            renderItem: (item, { isCursor }) => `${item.label}${isCursor ? " <" : ""}`,
            footerContent: (container, _theme, state) => {
                container.addChild(new Text(`  cursor at ${state.cursor}`, 1, 0));
            },
        });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "╭────────────────────────────────────────────────╮
          │   Custom                                       │
          │                                                │
          │   → Item 0 <                                   │
          │     Item 1                                     │
          │     cursor at 0                                │
          │                                                │
          │     ↑/↓ navigate | Enter confirm | Esc         │
          │   cancel                                       │
          │                                                │
          ╰────────────────────────────────────────────────╯"
        `);
    });
});
