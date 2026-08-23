import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { BORDER_STYLES, BorderBox } from "../../src/tui/border-box";
import { renderText } from "../helpers";

describe("BorderBox", () => {
    it("wraps child content in a Unicode border and preserves the width", () => {
        const component = new BorderBox(new Text("Hello\nWorld", 0, 0));

        expect(renderText(component, 12)).toMatchInlineSnapshot(`
          "╭──────────╮
          │Hello     │
          │World     │
          ╰──────────╯"
        `);
    });

    it("supports a fixed total height and keeps the bottom border visible", () => {
        const component = new BorderBox(new Text("Hello", 0, 0), { height: 6 });
        const lines = component.render(12);

        expect(lines).toHaveLength(6);
        expect(lines.at(-1)).toBe("╰──────────╯");
    });

    it("provides the standard border style presets", () => {
        const expectedTop = {
            rounded: "╭",
            light: "┌",
            heavy: "┏",
            double: "╔",
            mixed: "┍",
            block: "▛",
        } as const;

        for (const [name, characters] of Object.entries(BORDER_STYLES)) {
            const rendered = renderText(new BorderBox(new Text("x", 0, 0), { characters }), 8);
            expect(rendered, name).toContain(expectedTop[name as keyof typeof expectedTop]);
        }
    });

    it("supports custom border characters and colors", () => {
        const component = new BorderBox(new Text("Hi", 0, 0), {
            borderColor: (text) => `[${text}]`,
            characters: {
                topLeft: "+",
                topRight: "+",
                bottomLeft: "+",
                bottomRight: "+",
                horizontal: "-",
                vertical: "|",
            },
        });

        expect(renderText(component, 6)).toMatchInlineSnapshot(`
          "[+----+]
          [|]Hi  [|]
          [+----+]"
        `);
    });
});
