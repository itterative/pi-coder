/**
 * Rendering tests for SelectWithMessageComponent — scrollable content area
 * plus inline message editing through the composed InlineEditor.
 */

import { describe, expect, it, vi } from "vitest";
import {
    SelectWithMessageComponent,
    selectWithMessage,
    type SelectWithMessageOptions,
    type SelectWithMessageResult,
} from "../src/tui/select-with-message";
import { interact, KEY, mockTheme, snapshotText } from "./helpers";

function setup<T>(options: SelectWithMessageOptions<T>, width = 50) {
    let result: SelectWithMessageResult<T> | undefined | "pending" = "pending";
    const component = new SelectWithMessageComponent(options);
    component.setDoneCallback((value) => {
        result = value;
    });
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
    it("renders numbered content lines above the items", async () => {
        const { ui } = setup(baseOptions);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/select-with-message.initial-content.txt",
        );
    });

    it("scrolls the content area with j/k", async () => {
        const { ui, result } = setup({
            ...baseOptions,
            contentLines: Array.from({ length: 8 }, (_, i) => `content line ${i + 1}`),
            maxContentLines: 3,
        });
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/select-with-message.content-page-down.txt",
        );
        ui.press("j");
        const pageDown = ui.render();
        expect(pageDown).toContain("content line 4");
        expect(pageDown).toContain("→ Apply - run it now");
        expect(pageDown).not.toContain("→ Edit");
        await expect(snapshotText(pageDown)).toMatchFileSnapshot(
            "__snapshots__/select-with-message.content-page-up.txt",
        );
        ui.press("k");
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/select-with-message.content-page-up-restored.txt",
        );

        ui.press(KEY.enter);
        expect(result()).toMatchObject({ value: "apply" });
    });

    it("Enter selects an item without a message", () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.down, KEY.enter);
        expect(result()).toEqual({ value: "edit", message: undefined, displayText: "Edit" });
    });

    it("ignores Enter during the configured initial delay but accepts other input", () => {
        vi.useFakeTimers();
        try {
            const { ui, result } = setup({ ...baseOptions, confirmationDelayMs: 250 });

            ui.press(KEY.enter);
            expect(result()).toBe("pending");

            ui.press(KEY.down);
            expect(ui.render()).toContain("→ Edit");

            vi.advanceTimersByTime(249);
            ui.press(KEY.enter);
            expect(result()).toBe("pending");

            vi.advanceTimersByTime(1);
            ui.press(KEY.enter);
            expect(result()).toEqual({ value: "edit", message: undefined, displayText: "Edit" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("Tab enters edit mode; typed message is included in the result", async () => {
        const { ui, result } = setup(baseOptions);
        ui.press(KEY.tab);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/select-with-message.edit-mode.txt",
        );
        ui.type("with care");
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/select-with-message.typed-message.txt",
        );
        ui.press(KEY.enter);
        expect(result()).toEqual({
            value: "apply",
            message: "with care",
            displayText: "Apply, with care",
        });
    });

    it("Escape in edit mode returns to selection with buffer cleared", async () => {
        const { ui } = setup(baseOptions);
        ui.press(KEY.tab);
        ui.type("draft");
        ui.press(KEY.escape);
        await expect(snapshotText(ui.render())).toMatchFileSnapshot(
            "__snapshots__/select-with-message.escape-edit-mode.txt",
        );
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
                    return new Promise<SelectWithMessageResult<string> | undefined>(
                        (resolve, reject) => {
                            void Promise.resolve(
                                factory(undefined, mockTheme, undefined, resolve),
                            ).then(() => controller.abort(), reject);
                        },
                    );
                },
            },
        } as any;

        const result = await selectWithMessage(baseOptions, ctx, controller.signal);

        expect(result).toBeUndefined();
        expect(workingVisibility).toEqual([false, true]);
    });
});
