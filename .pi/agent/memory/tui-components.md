---
name: tui-components
description: src/tui structure — ListViewComponent base for list dialogs (pager/select/multi-select) and InlineEditor engine shared by ask-user/select-with-message; extend these instead of duplicating.
category: architecture
---

# src/tui component architecture

Two composable building blocks, extracted 2026-04 to deduplicate the dialog components:

- **`list-view.ts`** — `ListViewComponent<T, R, S>` base class: frame scaffolding (DynamicBorder/title/header/footer/help), configurable `borderColor` and border glyphs, item render cache, cursor-follow scrolling, scroll indicator, ↑/↓/j/k nav, `onKey` hook. Subclass extension points: `getItemPrefix()`, `handleAction()`, `onExternalDone()`, `renderStatus()`. Subclasses: `pager.ts` (cursor: null, external scroll), `select.ts`, `multi-select.ts`, and the agent-session browser.
- **`dialog-queue.ts`** — shared abort-aware FIFO for modal `ctx.ui.custom()` dialogs. `askUser()` and `selectWithMessage()` both use it; future permission dialogs must use one of these queued entrypoints rather than calling `ctx.ui.custom()` directly. Queued cancellation returns promptly without allowing later dialogs to overtake the active one.
- **`inline-editor.ts`** — `InlineEditor`: theme-free inline edit engine (segment buffer with atomic paste placeholders, bracketed paste, pi-tui-matching word movement/deletion, display↔content mapping, windowed `renderLines()` returning plain strings). Composed by `ask-user.ts` and `select-with-message.ts`; callers supply styling via pre-styled prefixes/placeholders and set `editor.focused`.

Tests: `test/` (vitest). `test/inline-editor.test.ts` unit-tests the editor engine; `test/helpers.ts` provides the headless harness for component rendering tests (`mockTheme` identity theme, `KEY` raw key map, `press`/`type`/`paste`, `interact()` which renders after every keypress like the real TUI loop — needed because InlineEditor up/down reads render-computed visual-line state, and `renderText()` which strips CURSOR_MARKER and renders inverse-video cursor chars as `[X]`). Component tests use inline snapshots. When changing edit behavior, change InlineEditor once — both dialogs inherit it.
