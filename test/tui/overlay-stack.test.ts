import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TuiMainScreen } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, Terminal, TUI } from "@earendil-works/pi-tui";
import { AgentWorkspaceDetailComponent } from "../../src/tui/agent-workspace-browser";
import type { AgentWorkspace } from "../../src/tools/agent/workspaces";
import { withOverlayStack } from "../../src/tui/overlay-stack";
import { mockTheme, renderText } from "../helpers";

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

function fakeTerminal(): Terminal {
    return {
        columns: 100,
        rows: 40,
        kittyProtocolActive: false,
        start() {},
        stop() {},
        drainInput: async () => {},
        write() {},
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
    };
}

const workspace: AgentWorkspace = {
    version: 1,
    id: "quiet-lantern-7k3",
    cwd: "/repo/project",
    repositoryRoot: "/repo/project",
    worktreePath: "/state/workspaces/quiet-lantern-7k3",
    slug: "quiet-lantern-7k3",
    baseRevision: "abc123def456",
    setupState: "ready",
    status: "available",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
};

beforeEach(() => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("Nov 14 2023 22:13");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("withOverlayStack", () => {
    it("keeps workspace actions reachable after another component steals focus", async () => {
        const tui = new TuiMainScreen(fakeTerminal());
        const permissionDialog: Component = {
            render: () => [],
            invalidate() {},
            handleInput: () => {},
        };
        const detail = new AgentWorkspaceDetailComponent(
            workspace,
            () => 27,
            undefined,
            {
                onAction: async (action) => {
                    expect(action).toBe("discard");
                    return null;
                },
            },
        );
        detail.initialize(mockTheme);

        let overlayHandle: OverlayHandle | undefined;
        let closed = false;
        await withOverlayStack(async (binding) => {
            tui.setFocus(permissionDialog);
            binding.bind(tui);
            overlayHandle = tui.showOverlay(detail);
            binding.setHandle(overlayHandle);
            detail.setDoneCallback(() => {
                closed = true;
                overlayHandle?.hide();
            });

            tui.setFocus(permissionDialog);
            (tui as TUI & { handleTerminalInput(data: string): void }).handleTerminalInput("d");
            expect(tui.getFocusedComponent()).toBe(detail);
            await expect(renderText(detail, 100)).toMatchFileSnapshot("__snapshots__/overlay-stack.workspace-discard-confirmation.txt");

            (tui as TUI & { handleTerminalInput(data: string): void }).handleTerminalInput("y");
            await vi.waitFor(() => expect(closed).toBe(true));
        });
    });

    it("keeps the top participating overlay focused and restores the next one", async () => {
        let listener: InputListener | undefined;
        let removed = false;
        let focusedComponent: object = {};
        const tui = {
            addInputListener(next: InputListener) {
                listener = next;
                return () => { removed = true; };
            },
            getFocusedComponent() { return focusedComponent; },
            setFocus(component: object) { focusedComponent = component; },
        } as unknown as TUI;
        const outer = fakeHandle();
        const inner = fakeHandle();
        const permissionDialog = focusedComponent;

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
        expect(focusedComponent).toBe(permissionDialog);
    });
});
