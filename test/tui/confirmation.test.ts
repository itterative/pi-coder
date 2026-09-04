import { describe, expect, it, vi } from "vitest";

import { workspaceActionConfirmation } from "../../src/tools/agent/browser";
import { confirm, ConfirmationComponent } from "../../src/tui/confirmation";
import { KEY, interact, mockTheme, renderText, snapshotText, stubTui } from "../helpers";
import {
    stubCommandContext,
    stubUi,
    type StubComponentFactory,
    type StubDialogOptions,
} from "../helpers/pi-stub";

const workspaceActions = ["apply", "retain", "reset", "discard", "release", "recover"] as const;

function fakeHandle() {
    let focused = false;
    return {
        focus() {
            focused = true;
        },
        unfocus() {
            focused = false;
        },
        isFocused() {
            return focused;
        },
        isHidden() {
            return false;
        },
        setHidden() {},
        hide() {
            focused = false;
        },
    };
}

describe("ConfirmationComponent", () => {
    it("renders a reusable confirmation dialog", async () => {
        const component = new ConfirmationComponent({
            title: "Cancel delegated agent?",
            message: 'Cancel "Project structure audit"?',
        });
        component.initialize(mockTheme);

        await expect(snapshotText(renderText(component, 64))).toMatchFileSnapshot(
            "__snapshots__/confirmation.dialog.txt",
        );
    });

    it.each(workspaceActions)(
        "renders the plain-language workspace %s description",
        async (action) => {
            const component = new ConfirmationComponent(
                workspaceActionConfirmation(action, "quiet-lantern-7k3"),
            );
            component.initialize(mockTheme);

            await expect(snapshotText(renderText(component, 64))).toMatchFileSnapshot(
                `__snapshots__/confirmation.workspace-${action}.txt`,
            );
        },
    );

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
        const custom = vi.fn(
            (factory: StubComponentFactory, options: StubDialogOptions) =>
                // `done` is `(result: unknown) => void`, so the stub promise resolves `unknown`; the
                // boolean the dialog submits still flows through at runtime.
                new Promise<unknown>((resolve) => {
                    // The overlay stack needs these three members: `addInputListener` and `setFocus`
                    // are real `TUI` members, and `getFocusedComponent` is the optional one that
                    // `overlay-stack.ts` feature-detects, which `FocusAwareTui` models.
                    const tui = stubTui({
                        addInputListener: () => () => {},
                        getFocusedComponent: () => null,
                        setFocus: () => {},
                    });
                    // A stub factory returns `unknown`; this one builds the dialog component.
                    component = factory(tui, mockTheme, {}, resolve) as ConfirmationComponent;
                    options.onHandle?.(fakeHandle());
                }),
        );
        const resultPromise = confirm(
            { title: "Confirm", message: "Continue?" },
            stubCommandContext({
                hasUI: true,
                mode: "tui",
                ui: stubUi({ custom }),
            }),
        );

        await vi.waitFor(() => expect(component).toBeDefined());
        expect(custom).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                overlay: true,
                overlayOptions: expect.objectContaining({ anchor: "center" }),
            }),
        );
        component!.handleInput(KEY.escape);
        await expect(resultPromise).resolves.toBe(false);
    });
});
