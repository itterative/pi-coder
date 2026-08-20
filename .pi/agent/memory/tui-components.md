---
name: tui-components
description: src/tui structure — ListViewComponent base for list dialogs (pager/select/multi-select) and InlineEditor engine shared by ask-user/select-with-message; extend these instead of duplicating.
category: architecture
---

# src/tui component architecture

Two composable building blocks, extracted 2026-04 to deduplicate the dialog components:

- **`list-view.ts`** — `ListViewComponent<T, R, S>` base class: frame scaffolding (DynamicBorder/title/header/footer/help), item render cache, cursor-follow scrolling, scroll indicator, ↑/↓/j/k nav, `onKey` hook. Subclass extension points: `getItemPrefix()`, `handleAction()`, `onExternalDone()`, `renderStatus()`. Subclasses: `pager.ts` (cursor: null, external scroll), `select.ts`, `multi-select.ts`.
- **`inline-editor.ts`** — `InlineEditor`: theme-free inline edit engine (segment buffer with atomic paste placeholders, bracketed paste, pi-tui-matching word movement/deletion, display↔content mapping, windowed `renderLines()` returning plain strings). Composed by `ask-user.ts` and `select-with-message.ts`; callers supply styling via pre-styled prefixes/placeholders and set `editor.focused`.

Tests: `test/inline-editor.test.ts` (vitest, 27 tests). When changing edit behavior, change InlineEditor once — both dialogs inherit it.
