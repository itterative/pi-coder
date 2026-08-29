import { describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";

import { confirm, ConfirmationComponent } from "../../src/tui/confirmation";
import { KEY, interact, mockTheme, renderText, snapshotText } from "../helpers";

function fakeHandle() {
    let focused = false;
    return {
        focus() { focused = true; },
        unfocus() { focused = false; },
        isFocused() { return focused; },
        isHidden() { return false; },
        setHidden() {},
        hide() { focused = false; },
    };
}

describe("ConfirmationComponent", () => {
    it("renders a reusable confirmation dialog", async () => {
        const component = new ConfirmationComponent({
            title: "Cancel delegated agent?",
            message: "Cancel \"Project structure audit\"?",
        });
        component.initialize(mockTheme);

        await expect(snapshotText(renderText(component, 64))).toMatchFileSnapshot(
            "__snapshots__/confirmation.dialog.txt",
        );
    });

    it("returns true for confirmation and false for cancellation", () => {
        const results: boolean[] = [];
        const component = new ConfirmationComponent({ title: "Confirm", message: "Continue?" });
        component.setDoneCallback((result) => results.push(result));
        component.initialize(mockTheme);
        const ui = interact(component, 64);

        ui.press(KEY.enter);
        ui.press(KEY.escape);
        expect(results).toEqual([true]);
    });

    it("shows as a focused overlay through the helper", async () => {
        let component: ConfirmationComponent | undefined;
        const custom = vi.fn((factory: any, options: any) => new Promise<boolean>((resolve) => {
            const tui = {
                addInputListener: () => () => {},
                getFocusedComponent: () => null,
                setFocus: () => {},
            } as unknown as TUI;
            component = factory(tui, mockTheme, {}, resolve);
            options.onHandle(fakeHandle());
        }));
        const resultPromise = confirm({ title: "Confirm", message: "Continue?" }, {
            hasUI: true,
            mode: "tui",
            ui: { custom },
        } as any);

        await vi.waitFor(() => expect(component).toBeDefined());
        expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
            overlay: true,
            overlayOptions: expect.objectContaining({ anchor: "center" }),
        }));
        component!.handleInput(KEY.escape);
        await expect(resultPromise).resolves.toBe(false);
    });
});
