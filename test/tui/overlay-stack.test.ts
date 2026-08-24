import { describe, expect, it } from "vitest";

import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { withOverlayStack } from "../../src/tui/overlay-stack";

type InputListener = (data: string) => unknown;

function fakeHandle(): OverlayHandle & { focusCount: number } {
    let focused = false;
    let focusCount = 0;
    return {
        get focusCount() { return focusCount; },
        focus() {
            focused = true;
            focusCount++;
        },
        unfocus() { focused = false; },
        isFocused() { return focused; },
        isHidden() { return false; },
        setHidden() {},
        hide() { focused = false; },
    };
}

describe("withOverlayStack", () => {
    it("keeps the top participating overlay focused and restores the next one", async () => {
        let listener: InputListener | undefined;
        let removed = false;
        const tui = {
            addInputListener(next: InputListener) {
                listener = next;
                return () => { removed = true; };
            },
        } as unknown as TUI;
        const outer = fakeHandle();
        const inner = fakeHandle();

        await withOverlayStack(async (outerBinding) => {
            outerBinding.bind(tui);
            outerBinding.setHandle(outer);
            expect(outer.isFocused()).toBe(true);

            outer.unfocus();
            listener?.("");
            expect(outer.isFocused()).toBe(true);

            await withOverlayStack(async (innerBinding) => {
                innerBinding.bind(tui);
                innerBinding.setHandle(inner);
                expect(inner.isFocused()).toBe(true);

                outer.unfocus();
                inner.unfocus();
                listener?.("");
                expect(inner.isFocused()).toBe(true);
                expect(outer.isFocused()).toBe(false);
            });

            expect(outer.isFocused()).toBe(true);
        });

        expect(removed).toBe(true);
    });
});
