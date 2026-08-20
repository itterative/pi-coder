/**
 * Tests for the InlineEditor engine extracted from the dialog components.
 *
 * The editor is theme-free and returns plain strings from renderLines(),
 * so it can be tested without a TUI.
 */

import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { InlineEditor } from "../src/tui/inline-editor";

// Raw key sequences matching pi-tui's matchesKey
const KEY = {
    enter: "\r",
    escape: "\x1b",
    backspace: "\x7f",
    delete: "\x1b[3~",
    left: "\x1b[D",
    right: "\x1b[C",
    up: "\x1b[A",
    down: "\x1b[B",
    ctrlW: "\x17",
    altD: "\x1bd",
    altB: "\x1bb",
    altF: "\x1bf",
};

function type(editor: InlineEditor, text: string): void {
    for (const ch of text) {
        editor.handleKey(ch);
    }
}

function paste(editor: InlineEditor, text: string, active = true) {
    return editor.handlePasteInput(`\x1b[200~${text}\x1b[201~`, active);
}

describe("InlineEditor — basic editing", () => {
    it("starts empty and reports isEmpty", () => {
        const ed = new InlineEditor();
        expect(ed.isEmpty).toBe(true);
        expect(ed.text).toBe("");
    });

    it("inserts typed characters", () => {
        const ed = new InlineEditor();
        type(ed, "hello");
        expect(ed.text).toBe("hello");
        expect(ed.isEmpty).toBe(false);
    });

    it("inserts at the cursor position after moving left", () => {
        const ed = new InlineEditor();
        type(ed, "helo");
        ed.handleKey(KEY.left);
        ed.handleKey(KEY.left);
        type(ed, "l");
        expect(ed.text).toBe("hello");
    });

    it("backspace deletes before cursor", () => {
        const ed = new InlineEditor();
        type(ed, "abc");
        ed.handleKey(KEY.backspace);
        expect(ed.text).toBe("ab");
    });

    it("forward delete removes char at cursor", () => {
        const ed = new InlineEditor();
        type(ed, "abc");
        ed.handleKey(KEY.left);
        ed.handleKey(KEY.delete);
        expect(ed.text).toBe("ab");
    });

    it("clear() resets buffer", () => {
        const ed = new InlineEditor();
        type(ed, "abc");
        ed.clear();
        expect(ed.text).toBe("");
        expect(ed.isEmpty).toBe(true);
    });

    it("setText() sets buffer with cursor at end", () => {
        const ed = new InlineEditor();
        ed.setText("abc");
        type(ed, "d");
        expect(ed.text).toBe("abcd");
    });

    it("enter and escape are reported, not consumed", () => {
        const ed = new InlineEditor();
        expect(ed.handleKey(KEY.enter)).toBe("submit");
        expect(ed.handleKey(KEY.escape)).toBe("cancel");
        expect(ed.handleKey("x")).toBe("consumed");
    });
});

describe("InlineEditor — word movement & deletion", () => {
    it("alt+f / alt+b move by word", () => {
        const ed = new InlineEditor();
        type(ed, "foo bar baz");
        ed.handleKey(KEY.altB);
        type(ed, "X");
        // alt+b stops before "baz" (after the preceding space)
        expect(ed.text).toBe("foo bar Xbaz");
        ed.handleKey(KEY.altB);
        type(ed, "Y");
        expect(ed.text).toBe("foo bar YXbaz");
    });

    it("word movement stops at punctuation boundaries", () => {
        const ed = new InlineEditor();
        type(ed, "foo.bar");
        ed.handleKey(KEY.altB);
        type(ed, "X");
        // stops after the dot: foo.Xbar
        expect(ed.text).toBe("foo.Xbar");
    });

    it("ctrl+w deletes the word before the cursor", () => {
        const ed = new InlineEditor();
        type(ed, "foo bar");
        ed.handleKey(KEY.ctrlW);
        expect(ed.text).toBe("foo ");
        ed.handleKey(KEY.ctrlW);
        expect(ed.text).toBe("");
    });

    it("alt+d deletes the word after the cursor", () => {
        const ed = new InlineEditor();
        type(ed, "foo bar");
        for (let i = 0; i < 7; i++) ed.handleKey(KEY.left);
        ed.handleKey(KEY.altD);
        expect(ed.text).toBe(" bar");
    });
});

describe("InlineEditor — paste handling", () => {
    it("small pastes are inserted as plain text", () => {
        const ed = new InlineEditor();
        const result = paste(ed, "short");
        expect(result.consumed).toBe(true);
        expect(result.changed).toBe(true);
        expect(ed.text).toBe("short");
    });

    it("multi-line pastes become atomic placeholder segments", () => {
        const ed = new InlineEditor();
        type(ed, "ab");
        paste(ed, "line1\nline2\nline3");
        expect(ed.text).toBe("abline1\nline2\nline3");

        // Placeholder renders instead of content
        const lines = ed.renderLines({ width: 80 });
        expect(lines.join("\n")).toContain("[Pasted 3 lines]");

        // Backspace removes the whole paste atomically
        ed.handleKey(KEY.backspace);
        expect(ed.text).toBe("ab");
    });

    it("cursor movement skips over paste segments", () => {
        const ed = new InlineEditor();
        paste(ed, "x".repeat(200)); // large single-line paste
        type(ed, "end");
        // Move left past "end" — next left should jump over the whole paste
        ed.handleKey(KEY.left);
        ed.handleKey(KEY.left);
        ed.handleKey(KEY.left);
        ed.handleKey(KEY.left);
        type(ed, "start");
        expect(ed.text).toBe("start" + "x".repeat(200) + "end");
    });

    it("pastes while inactive are consumed but discarded", () => {
        const ed = new InlineEditor();
        const result = paste(ed, "discarded", false);
        expect(result.consumed).toBe(true);
        expect(result.changed).toBe(false);
        expect(ed.text).toBe("");
    });

    it("paste split across chunks is buffered", () => {
        const ed = new InlineEditor();
        expect(ed.handlePasteInput("\x1b[200~hel", true).consumed).toBe(true);
        expect(ed.text).toBe("");
        const done = ed.handlePasteInput("lo\x1b[201~", true);
        expect(done.changed).toBe(true);
        expect(ed.text).toBe("hello");
    });

    it("input after the paste end marker is returned as remaining", () => {
        const ed = new InlineEditor();
        const result = ed.handlePasteInput("\x1b[200~hi\x1b[201~x", true);
        expect(result.remaining).toBe("x");
        expect(ed.text).toBe("hi");
    });

    it("non-paste input is not consumed", () => {
        const ed = new InlineEditor();
        expect(ed.handlePasteInput("a", true).consumed).toBe(false);
    });
});

describe("InlineEditor — rendering", () => {
    it("empty buffer renders placeholder with visual cursor", () => {
        const ed = new InlineEditor();
        const lines = ed.renderLines({
            width: 20,
            placeholder: "<placeholder>",
            firstLinePrefix: "Label: ",
            linePrefixFor: (i) => (i === 0 ? "→ " : "  "),
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("→ ");
        expect(lines[0]).toContain("Label: ");
        expect(lines[0]).toContain("<placeholder>");
        expect(lines[0]).toContain("\x1b[7m"); // visual cursor
        expect(lines[0]).not.toContain(CURSOR_MARKER); // not focused
    });

    it("emits CURSOR_MARKER when focused", () => {
        const ed = new InlineEditor();
        ed.focused = true;
        const lines = ed.renderLines({ width: 20, placeholder: "p" });
        expect(lines[0]).toContain(CURSOR_MARKER);
    });

    it("wraps long text to the given width", () => {
        const ed = new InlineEditor();
        type(ed, "aaaa bbbb cccc dddd");
        const lines = ed.renderLines({ width: 10, maxLines: 10 });
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            // strip ANSI for width check
            const plain = line.replace(/\x1b\[[0-9;]*m/g, "").replace(CURSOR_MARKER, "");
            expect(plain.length).toBeLessThanOrEqual(11); // width + cursor char
        }
    });

    it("truncates to maxLines with ellipsis indicators", () => {
        const ed = new InlineEditor();
        type(ed, "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj");
        // 50 chars at width 10 → 5 visual lines; put cursor in the middle
        // line so the window truncates on both sides
        for (let i = 0; i < 25; i++) ed.handleKey(KEY.left);
        const lines = ed.renderLines({ width: 10, maxLines: 3 });
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain("…");
        expect(lines[2]).toContain("…");
    });

    it("highlights the character under the cursor mid-line", () => {
        const ed = new InlineEditor();
        type(ed, "abc");
        ed.handleKey(KEY.left);
        const lines = ed.renderLines({ width: 20 });
        expect(lines[0]).toContain("\x1b[7mc\x1b[27m");
    });

    it("renders firstLinePrefix only on the first visible line", () => {
        const ed = new InlineEditor();
        type(ed, "aaaa bbbb cccc");
        const lines = ed.renderLines({
            width: 8,
            maxLines: 10,
            firstLinePrefix: "L: ",
            linePrefixFor: (i) => (i === 0 ? "> " : "  "),
        });
        expect(lines[0]).toMatch(/^> L: /);
        expect(lines[1]).toMatch(/^ {2}/);
        expect(lines[1]).not.toContain("L: ");
    });
});

describe("InlineEditor — vertical movement", () => {
    it("up/down move between wrapped visual lines keeping the column", () => {
        const ed = new InlineEditor();
        type(ed, "aaaa bbbb");
        // Render so navigation state exists (width 8 wraps to two lines)
        ed.renderLines({ width: 8, maxLines: 10 });
        // Cursor at end (after "bbbb", col 4 of line 2). Up → col 4 of line 1.
        ed.handleKey(KEY.up);
        type(ed, "X");
        expect(ed.text).toBe("aaaaX bbbb");
        // Down again → back to end of line 2
        ed.renderLines({ width: 8, maxLines: 10 });
        ed.handleKey(KEY.down);
        type(ed, "Y");
        expect(ed.text).toBe("aaaaX bbbbY");
    });

    it("up on the first line jumps to buffer start", () => {
        const ed = new InlineEditor();
        type(ed, "abc");
        ed.renderLines({ width: 80 });
        ed.handleKey(KEY.up);
        type(ed, "X");
        expect(ed.text).toBe("Xabc");
    });
});
