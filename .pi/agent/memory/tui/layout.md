---
name: layout
description: "Terminal-height layout invariants that stop a permission dialog flickering when content exceeds the screen. Load when changing dialog framing."
category: architecture
keep_updated: true
---

# Permission dialog layout (`src/tui/select-with-message.ts`)

- `src/tui/select-with-message.ts` keeps the title short and puts long command text in a capped, scrollable content area. The content area renders numbered, manually wrapped lines; selection items and help text remain below it and visible. PageUp/PageDown update the content scroll offset.

## Wrapping

- Wrapping uses `wrapTextWithAnsi` for command content and `wrapPreservingSpaces` through `InlineEditor` for in-progress feedback, so trailing spaces remain visible while typing. The edit area is capped at three visual lines and uses a cursor-safe window; the cursor is never placed on a truncated first/last line.

## Which file owns the fix

Layout and editing fixes for this dialog go into the shared editor, not here — the engine rules and the reason the harness renders after every keypress are in [`inline-editor.md`](inline-editor.md).

Related: [`dialogs.md`](dialogs.md) for the dialog queue and overlay stack, and the scroll/framing mechanics of list-based dialogs in [`list-view.md`](list-view.md).
