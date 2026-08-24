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
    it("renders title, description, options and custom entry", async () => {
        const { ui } = setup(baseOptions);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.renders-options.txt");
    });

    it("navigates options including the custom entry", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.down, KEY.down);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.navigates-custom-entry.txt");
    });

    it("Tab enters edit mode with placeholder and cursor", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.edit-placeholder.txt");
    });

    it("typing in edit mode renders the message inline", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("only the tests");
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.typed-message.txt");
    });

    it("cursor renders on the character under it when mid-text", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("abc");
        ui.press(KEY.left);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.cursor-mid-text.txt");
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

    it("Escape in edit mode returns to selection, second Escape cancels", async () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("draft");
        ui.press(KEY.escape);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.escape-edit-mode.txt");
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

    it("stacks the label above the edit text when narrow", async () => {
        const { ui } = setup(baseOptions, 30);
        ui.press(KEY.tab);
        ui.type("hi");
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.narrow-label.txt");
    });

    it("large pastes render as an atomic placeholder", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.paste("line one\nline two\nline three");
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.atomic-paste.txt");
        // Backspace removes the whole paste
        ui.press(KEY.backspace);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.atomic-paste-backspace.txt");
    });

    it("long messages truncate to a windowed view with ellipses", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        // 199 chars at an edit width of 38 → 6 visual lines
        ui.type(Array.from({ length: 50 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" "));
        // Move from the last visual line to a middle one so the window
        // truncates on both sides
        ui.press(KEY.up, KEY.up);
        await expect(ui.render()).toMatchFileSnapshot("__snapshots__/ask-user.long-message-window.txt");
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
