/**
 * Headless test helpers for TUI components.
 *
 * Components under test are driven without a TUI runtime: initialize() with
 * the identity mockTheme, feed raw keys via press()/type()/paste(), and
 * snapshot renderText() output.
 *
 * renderText() normalizes non-printable sequences so snapshots stay
 * readable:
 * - CURSOR_MARKER (hardware cursor) is stripped — position is already shown
 *   by the visual cursor
 * - inverse-video chars (\x1b[7mX\x1b[27m) become [X] — so "ab[c]" means the
 *   cursor is on "c" and "abc[ ]" means the cursor is at the end
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

// Identity theme: no ANSI styling, snapshots show pure layout and text.
export const mockTheme = {
    fg: (_color: ThemeColor, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

// Raw key sequences matching pi-tui's matchesKey
export const KEY = {
    enter: "\r",
    escape: "\x1b",
    tab: "\t",
    space: " ",
    backspace: "\x7f",
    delete: "\x1b[3~",
    left: "\x1b[D",
    right: "\x1b[C",
    up: "\x1b[A",
    down: "\x1b[B",
    pageUp: "\x1b[5~",
    pageDown: "\x1b[6~",
    ctrlW: "\x17",
    altD: "\x1bd",
    altB: "\x1bb",
    altF: "\x1bf",
} as const;

interface InputHandler {
    handleInput(data: string): void;
}

/** Send raw keys to a component. */
export function press(component: InputHandler, ...keys: string[]): void {
    for (const key of keys) {
        component.handleInput(key);
    }
}

/** Type printable text one character at a time. */
export function type(component: InputHandler, text: string): void {
    press(component, ...text.split(""));
}

/** Send a bracketed paste. */
export function paste(component: InputHandler, text: string): void {
    component.handleInput(`\x1b[200~${text}\x1b[201~`);
}

/** Render a component and normalize output into snapshot-friendly text. */
export function renderText(component: Component, width = 50): string {
    return component
        .render(width)
        .map((line) =>
            line
                .replaceAll(CURSOR_MARKER, "")
                .replace(/\x1b\[7m([\s\S])\x1b\[27m/g, "[$1]"),
        )
        .join("\n");
}

/** Remove terminal padding from rendered snapshots while preserving layout lines. */
export function snapshotText(text: string): string {
    return text.replace(/[ \t]+$/gm, "");
}

/**
 * Interaction helper that emulates the real TUI loop: a render happens
 * after every keypress. This matters for components whose input handling
 * reads render-computed state (e.g. the InlineEditor's visual-line map for
 * up/down movement) — with plain press(), two ups in a row would both
 * compute from the same stale render state.
 */
export function interact(component: Component, width = 50) {
    const render = () => renderText(component, width);
    return {
        press: (...keys: string[]) => {
            for (const key of keys) {
                component.handleInput(key);
                component.render(width);
            }
        },
        type: (text: string) => {
            for (const ch of text) {
                component.handleInput(ch);
                component.render(width);
            }
        },
        paste: (text: string) => {
            component.handleInput(`\x1b[200~${text}\x1b[201~`);
            component.render(width);
        },
        render,
    };
}
