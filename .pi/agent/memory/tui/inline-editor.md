---
name: inline-editor
description: "InlineEditor engine, text-input/numeric-input facades, and the atomic-paste, display-mapping, wrapping, and cursor invariants. Load on input edits."
category: architecture
keep_updated: true
---

# Inline editing (`src/tui/inline-editor.ts`)

## The engine

- `InlineEditor`: theme-free inline edit engine (segment buffer with atomic paste placeholders, bracketed paste, pi-tui-matching word movement/deletion, display↔content mapping, windowed `renderLines()` returning plain strings).
- Composed by `ask-user.ts`, `select-with-message.ts`, and `numeric-input.ts`; callers supply styling via pre-styled prefixes/placeholders and set `editor.focused`.
- `src/tui/inline-editor.ts` owns a flat content cursor (`cursorPos`) over segment content. Segments are typed text or atomic large-paste placeholders. The public buffer is exposed as `text`; callers use `handlePasteInput()`, `handleKey()`, and `renderLines()`.

## Atomic paste behavior

- Cursor movement skips over paste segments. Backspace/delete at a paste boundary removes the entire segment. Word movement and deletion use `Intl.Segmenter` refined with ASCII punctuation boundaries, then clamp boundaries so they never land inside a paste segment. Range deletion removes any overlapping paste marker and merges adjacent text segments.

## Display mapping, wrapping, and up/down

- `renderLines()` builds a display buffer with paste placeholders and maintains content-to-display and display-to-content mappings. It wraps hard lines with `wrapPreservingSpaces`, records `EditVisLine` ranges, maps the cursor to an absolute visual-line index, and returns a window of rendered strings with optional ellipsis indicators. The caller supplies prefixes, placeholders, and styling.
- Up/down uses the absolute visual-line state computed during the last render and remembers the desired column. Because adjacent visual lines share a boundary, boundary mapping must use exclusive ends and special-case the final end-of-buffer position. Up on the first visual line goes to buffer start; down on the last goes to buffer end.
- The edit width reserves one cell for the cursor. The maximum visible edit-line count must be at least three so the cursor remains on a non-truncated middle line. Bracketed paste data may arrive in chunks; inactive pastes are consumed and discarded.

## Field facades

- `text-input.ts` — `TextInputComponent<T>`: the generic modal inline field (`InlineEditor` + `BorderBox`) with caller-supplied `parse`/`format`, an optional `fieldLabel`, and validation errors; `textInput()` opens it through `withOverlayStack`.
- `numeric-input.ts` is now a facade over it — `NumericInputComponent` is an alias, `numericInput()` forwards with the numeric placeholder, and `parsePositiveInteger` stays. Use `numericInput()` for settings that need arbitrary numeric values instead of fixed choice lists.

## Changing edit behavior

- When changing edit behavior, change InlineEditor once — both dialogs inherit it.
- Keep layout and editing fixes in the shared editor where possible.

## Testing the editor

- `test/inline-editor.test.ts` unit-tests the editor engine.
- `test/helpers.ts` provides the headless harness for component rendering tests (`mockTheme` identity theme, `KEY` raw key map, `press`/`type`/`paste`, `interact()` which renders after every keypress like the real TUI loop — needed because InlineEditor up/down reads render-computed visual-line state, and `renderText()` which strips CURSOR_MARKER and renders inverse-video cursor chars as `[X]`).
- Preserve the render-after-input behavior used by `test/helpers.ts` because vertical cursor movement depends on render-computed visual-line state.

The harness itself (`KEY`, `mockTheme`, `press`/`type`/`paste`, `interact()`, `renderText()`, `snapshotText()`) is catalogued in [`../test-doubles/tui-e2e.md`](../test-doubles/tui-e2e.md), and TUI rendering tests use file snapshots per [`../testing/snapshots-and-assertions.md`](../testing/snapshots-and-assertions.md).

Related: [`layout.md`](layout.md) for the permission-dialog layout rules that ride on this editor, and [`../tui.md`](../tui.md) for which component to extend.
