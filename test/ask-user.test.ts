/**
 * Rendering tests for AskUserComponent — the composed InlineEditor is
 * exercised through interaction: Tab enters edit mode, typing renders with
 * a visual cursor ([ ] = at end, [c] = on char "c").
 *
 * Interaction goes through interact(), which renders after every keypress
 * like the real TUI loop (the editor's up/down movement depends on
 * render-computed visual-line state).
 */

import { describe, expect, it } from "vitest";
import {
    AskUserComponent,
    askUser,
    type AskUserOptions,
    type AskUserResult,
} from "../src/tui/ask-user";
import { interact, KEY, mockTheme } from "./helpers";

function setup(options: AskUserOptions, width = 50) {
    let result: AskUserResult | undefined | "pending" = "pending";
    const component = new AskUserComponent(options);
    component.setDoneCallback((value) => { result = value; });
    component.initialize(mockTheme);
    component.focused = true;
    const ui = interact(component, width);
    return { ui, result: () => result };
}

const baseOptions: AskUserOptions = {
    title: "Proceed?",
    description: "This will modify files.",
    options: [
        { label: "Yes", description: "apply changes" },
        { label: "No" },
    ],
};

describe("AskUserComponent", () => {
    it("renders title, description, options and custom entry", () => {
        const { ui } = setup(baseOptions);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes - apply changes                           
              No                                            
              Type a custom reply                           
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | Esc cancel                            

          ──────────────────────────────────────────────────"
        `);
    });

    it("navigates options including the custom entry", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.down, KEY.down);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
              Yes - apply changes                           
              No                                            
            → Type a custom reply                           
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | Esc cancel                            

          ──────────────────────────────────────────────────"
        `);
    });

    it("Tab enters edit mode with placeholder and cursor", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes: [ ]type your reply...                      
              No                                            
              Type a custom reply                           
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
    });

    it("typing in edit mode renders the message inline", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("only the tests");
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes: only the tests[ ]                          
              No                                            
              Type a custom reply                           
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
    });

    it("cursor renders on the character under it when mid-text", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("abc");
        ui.press(KEY.left);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes: ab[c]                                      
              No                                            
              Type a custom reply                           
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
    });

    it("Enter confirms the option with attached message", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("  but check first  ");
        ui.press(KEY.enter);
        expect(result()).toEqual({
            answer: "Yes: but check first",
            isCustom: false,
            optionIndex: 0,
        });
    });

    it("Escape in edit mode returns to selection, second Escape cancels", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("draft");
        ui.press(KEY.escape);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes - apply changes                           
              No                                            
              Type a custom reply                           
                                                            
              ↑/↓ navigate | Enter select | Tab add         
            message | Esc cancel                            

          ──────────────────────────────────────────────────"
        `);
        ui.press(KEY.escape);
        expect(result()).toBeUndefined();
    });

    it("selecting the custom entry submits a custom reply", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.down, KEY.down, KEY.enter); // enters edit mode
        ui.type("roll back instead");
        ui.press(KEY.enter);
        expect(result()).toEqual({
            answer: "roll back instead",
            isCustom: true,
            optionIndex: -1,
        });
    });

    it("stacks the label above the edit text when narrow", () => {
        const { ui } = setup(baseOptions, 30);
        ui.press(KEY.tab);
        ui.type("hi");
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────
             Proceed?                   

              This will modify files.   
                                        
            → Yes:                      
                hi[ ]                     
              No                        
              Type a custom reply       
                                        
              Enter confirm | Esc back  

          ──────────────────────────────"
        `);
    });

    it("large pastes render as an atomic placeholder", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.paste("line one\nline two\nline three");
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes: [Pasted 3 lines][ ]                        
              No                                            
              Type a custom reply                           
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
        // Backspace removes the whole paste
        ui.press(KEY.backspace);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes: [ ]type your reply...                      
              No                                            
              Type a custom reply                           
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
    });

    it("long messages truncate to a windowed view with ellipses", () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        // 199 chars at an edit width of 38 → 6 visual lines
        ui.type(Array.from({ length: 50 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" "));
        // Move from the last visual line to a middle one so the window
        // truncates on both sides
        ui.press(KEY.up, KEY.up);
        expect(ui.render()).toMatchInlineSnapshot(`
          "──────────────────────────────────────────────────
             Proceed?                                       

              This will modify files.                       
                                                            
            → Yes: …18 w19 w20 w21 w22 w23 w24 w25 w26      
                   w27 w28 w29 w30 w31[ ]w32 w33 w34 w35      
                   w36 w37 w38 w39 w40 w41 w42 w43 w44…     
              No                                            
              Type a custom reply                           
                                                            
              Enter confirm | Esc back                      

          ──────────────────────────────────────────────────"
        `);
    });
});

describe("askUser", () => {
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
                    return new Promise<AskUserResult | undefined>((resolve, reject) => {
                        void Promise.resolve(factory(undefined, mockTheme, undefined, resolve))
                            .then(() => controller.abort(), reject);
                    });
                },
            },
        } as any;

        const result = await askUser(baseOptions, ctx, controller.signal);

        expect(result).toBeUndefined();
        expect(workingVisibility).toEqual([false, true]);
    });
});
