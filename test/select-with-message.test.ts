/**
 * Rendering tests for SelectWithMessageComponent — scrollable content area
 * plus inline message editing through the composed InlineEditor.
 */

import { describe, expect, it } from "vitest";
import {
    SelectWithMessageComponent,
    selectWithMessage,
    type SelectWithMessageOptions,
    type SelectWithMessageResult,
} from "../src/tui/select-with-message";
import { interact, KEY, mockTheme } from "./helpers";

function setup<T>(options: SelectWithMessageOptions<T>, width = 50) {
    let result: SelectWithMessageResult<T> | undefined | "pending" = "pending";
    const component = new SelectWithMessageComponent(options);
    component.setDoneCallback((value) => { result = value; });
    component.initialize(mockTheme);
    component.focused = true;
    const ui = interact(component, width);
    return { component, ui, result: () => result };
}

const baseOptions: SelectWithMessageOptions<string> = {
    title: "Apply command?",
    contentLines: ["git rebase -i HEAD~3", "# pick abc123 fix typo"],
    items: [
        { value: "apply", label: "Apply", description: "run it now" },
        { value: "edit", label: "Edit" },
        { value: "cancel", label: "Cancel" },
    ],
};

describe("SelectWithMessageComponent", () => {
    it("renders numbered content lines above the items", () => {
        const { ui } = setup(baseOptions);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            1 │ git rebase -i HEAD~3                        
            2 │ # pick abc123 fix typo                      
                                                            
            → Apply - run it now                            
              Edit                                          
              Cancel                                        
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | PgUp/PgDn scroll | Esc cancel         

          ──────────────────────────────────────────────────"
        `);
    });

    it("scrolls the content area with PageUp/PageDown", () => {
        const { ui } = setup({
            ...baseOptions,
            contentLines: Array.from({ length: 8 }, (_, i) => `content line ${i + 1}`),
            maxContentLines: 3,
        });
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            1 │ content line 1                              
            2 │ content line 2                              
            3 │ content line 3                              
                                                            
              Showing lines 1-3 of 8 (PgUp/PgDn to scroll)  
                                                            
            → Apply - run it now                            
              Edit                                          
              Cancel                                        
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | PgUp/PgDn scroll | Esc cancel         

          ──────────────────────────────────────────────────"
        `);
        ui.press(KEY.pageDown);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            4 │ content line 4                              
            5 │ content line 5                              
            6 │ content line 6                              
                                                            
              Showing lines 4-6 of 8 (PgUp/PgDn to scroll)  
                                                            
            → Apply - run it now                            
              Edit                                          
              Cancel                                        
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | PgUp/PgDn scroll | Esc cancel         

          ──────────────────────────────────────────────────"
        `);
        ui.press(KEY.pageUp);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            1 │ content line 1                              
            2 │ content line 2                              
            3 │ content line 3                              
                                                            
              Showing lines 1-3 of 8 (PgUp/PgDn to scroll)  
                                                            
            → Apply - run it now                            
              Edit                                          
              Cancel                                        
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | PgUp/PgDn scroll | Esc cancel         

          ──────────────────────────────────────────────────"
        `);
    });

    it("Enter selects an item without a message", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.down, KEY.enter);
        expect(result()).toEqual({ value: "edit", message: undefined, displayText: "Edit" });
    });

    it("Tab enters edit mode; typed message is included in the result", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.tab);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            1 │ git rebase -i HEAD~3                        
            2 │ # pick abc123 fix typo                      
                                                            
            → Apply, [ ]type a message...                     
              Edit                                          
              Cancel                                        
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
        ui.type("with care");
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            1 │ git rebase -i HEAD~3                        
            2 │ # pick abc123 fix typo                      
                                                            
            → Apply, with care[ ]                             
              Edit                                          
              Cancel                                        
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
        ui.press(KEY.enter);
        expect(result()).toEqual({
            value: "apply",
            message: "with care",
            displayText: "Apply, with care",
        });
    });

    it("Escape in edit mode returns to selection with buffer cleared", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("draft");
        ui.press(KEY.escape);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Apply command?                                 

            1 │ git rebase -i HEAD~3                        
            2 │ # pick abc123 fix typo                      
                                                            
            → Apply - run it now                            
              Edit                                          
              Cancel                                        
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | PgUp/PgDn scroll | Esc cancel         

          ──────────────────────────────────────────────────"
        `);
    });

    it("Escape in selection mode cancels", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.escape);
        expect(result()).toBeUndefined();
    });

    it("supports a dynamic title function", () => {
        let mode = "select";
        const { component, ui } = setup({
            ...baseOptions,
            title: () => `Mode: ${mode}`,
        });
        expect(ui.render()).toContain("Mode: select");
        mode = "review";
        component.invalidate();
        expect(ui.render()).toContain("Mode: review");
    });
});

describe("selectWithMessage", () => {
    it("closes an active dialog when its operation is aborted", async () => {
        const controller = new AbortController();
        const workingVisibility: boolean[] = [];
        const ctx = {
            hasUI: true,
            ui: {
                setWorkingVisible(visible: boolean) {
                    workingVisibility.push(visible);
                },
                custom(factory: any) {
                    return new Promise<SelectWithMessageResult<string> | undefined>((resolve, reject) => {
                        void Promise.resolve(factory(undefined, mockTheme, undefined, resolve))
                            .then(() => controller.abort(), reject);
                    });
                },
            },
        } as any;

        const result = await selectWithMessage(baseOptions, ctx, controller.signal);

        expect(result).toBeUndefined();
        expect(workingVisibility).toEqual([false, true]);
    });
});
