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
    it("renders items from the initial scroll offset", () => {
        const { component } = setup({ title: "Log", items: items(3), scrollOffset: 0 });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Log                                            

             Line 0                                         
             Line 1                                         
             Line 2                                         
                                                            
               Esc close                                    

          ──────────────────────────────────────────────────"
        `);
    });

    it("scrolls via the onKey hook and shows the scroll indicator", () => {
        const { component } = setup(scrollKeys({
            title: "Log",
            items: items(8),
            scrollOffset: 0,
            maxVisibleLines: 4,
        }));
        expect(renderText(component)).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Log                                            

             Line 0                                         
             Line 1                                         
             Line 2                                         
             Line 3                                         
                                                            
               Showing lines 1-4 of 8                       
                                                            
               Esc close                                    

          ──────────────────────────────────────────────────"
        `);
        press(component, KEY.down, KEY.down, KEY.down);
        expect(renderText(component)).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Log                                            

             Line 3                                         
             Line 4                                         
             Line 5                                         
             Line 6                                         
                                                            
               Showing lines 4-7 of 8                       
                                                            
               Esc close                                    

          ──────────────────────────────────────────────────"
        `);
        press(component, KEY.up);
        expect(renderText(component)).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Log                                            

             Line 2                                         
             Line 3                                         
             Line 4                                         
             Line 5                                         
                                                            
               Showing lines 3-6 of 8                       
                                                            
               Esc close                                    

          ──────────────────────────────────────────────────"
        `);
    });

    it("closes on Escape and q", () => {
        const a = setup({ title: "Log", items: items(3), scrollOffset: 0 });
        press(a.component, KEY.escape);
        expect(a.closed()).toBe(true);

        const b = setup({ title: "Log", items: items(3), scrollOffset: 0 });
        press(b.component, "q");
        expect(b.closed()).toBe(true);
    });

    it("supports multi-line items and custom renderItem", () => {
        const { component } = setup({
            title: "Details",
            items: [
                { value: "a", label: "First" },
                { value: "b", label: "Second" },
            ],
            scrollOffset: 0,
            renderItem: (item) => `${item.label}\n  detail for ${item.value}`,
        });
        expect(renderText(component)).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Details                                        

             First                                          
               detail for a                                 
             Second                                         
               detail for b                                 
                                                            
               Esc close                                    

          ──────────────────────────────────────────────────"
        `);
    });
});
