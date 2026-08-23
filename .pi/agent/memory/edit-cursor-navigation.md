---
name: edit-cursor-navigation
description: Cursor, paste, and visual-line navigation invariants for the shared InlineEditor.
category: architecture
---

# InlineEditor navigation

`src/tui/inline-editor.ts` owns a flat content cursor (`cursorPos`) over segment content. Segments are typed text or atomic large-paste placeholders. The public buffer is exposed as `text`; callers use `handlePasteInput()`, `handleKey()`, and `renderLines()`.

## Atomic paste behavior

Cursor movement skips over paste segments. Backspace/delete at a paste boundary removes the entire segment. Word movement and deletion use `Intl.Segmenter` refined with ASCII punctuation boundaries, then clamp boundaries so they never land inside a paste segment. Range deletion removes any overlapping paste marker and merges adjacent text segments.

## Display mapping and wrapping

`renderLines()` builds a display buffer with paste placeholders and maintains content-to-display and display-to-content mappings. It wraps hard lines with `wrapPreservingSpaces`, records `EditVisLine` ranges, maps the cursor to an absolute visual-line index, and returns a window of rendered strings with optional ellipsis indicators. The caller supplies prefixes, placeholders, and styling.

Up/down uses the absolute visual-line state computed during the last render and remembers the desired column. Because adjacent visual lines share a boundary, boundary mapping must use exclusive ends and special-case the final end-of-buffer position. Up on the first visual line goes to buffer start; down on the last goes to buffer end.

The edit width reserves one cell for the cursor. The maximum visible edit-line count must be at least three so the cursor remains on a non-truncated middle line. Bracketed paste data may arrive in chunks; inactive pastes are consumed and discarded.

`InlineEditor` is composed by both `src/tui/ask-user.ts` and `src/tui/select-with-message.ts`; change the engine once rather than duplicating editing behavior. Tests live in `test/inline-editor.test.ts` and component snapshots use `test/helpers.ts`.
