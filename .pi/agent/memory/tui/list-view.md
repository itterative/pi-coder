---
name: list-view
description: "ListViewComponent base, pager/select/multi-select subclasses, the composed agent browser host, and scroll/cache invariants. Load when adding list UI."
category: architecture
keep_updated: true
---

# List views (`src/tui/list-view.ts`)

## `ListViewComponent<T, R, S>` base class

- `ListViewComponent<T, R, S>` base class: frame scaffolding (DynamicBorder/title/header/footer/help), configurable `borderColor`, border glyphs, optional header spacing, fixed-height/compact-footer framing, visual-line wrapping, item render cache, cursor-follow scrolling, scroll indicator, ↑/↓/j/k nav, `onKey` hook.

## Extension points and subclasses

- Subclass extension points: `getItemPrefix()`, `handleAction()`, `onExternalDone()`, `renderStatus()`, plus compositional `itemPrefix`, `onCacheBuilt`, title, and help updates.
- Subclasses: `pager.ts`, `select.ts`, and `multi-select.ts`; `SelectComponent` supports opt-in printable-input filtering with a header search indicator via `enableSearch`.

## The agent browser is a composed host

- The agent browser is now a composed host in `agents/browser.ts`.
- The unified browser defaults its Agents view to the current parent session, with an `h` toggle for cwd-wide historical sessions, plus Workspaces and Settings views; it opens pager-based read-only session or workspace metadata views.

The agent-run semantics behind those views belong to the delegated-agent cluster: see [`../agents.md`](../agents.md) and [`agents/lifecycle.md`](../agents/lifecycle.md).

## Framing, viewport restore, and the render cache

- `ListViewComponent` fits fixed-height frames by reserving space for scroll indicators/wrapped footers and placing a flexible spacer before help text, so compact agent detail/workspace views anchor help at the bottom; it restores the configured viewport size when dimensions change. It caches rendered and wrapped item lines across scroll-only renders; `invalidate()` marks that cache dirty for content changes, while custom key handlers use the non-cache-invalidating path for offset-only navigation.

## Agent detail scroll offset and lazy transcripts

- `AgentSessionDetailComponent` clamps its pager scroll offset after transcript content changes, which is required when switching from a long detailed transcript to a shorter collapsed one.
- When an open live run transitions to a historical row without preloaded transcript text, the browser must trigger the lazy transcript loader again before the detail can retain the final transcript/TODO projection.
- When a lazy transcript resolves, update the open detail before invalidating cached browser state, then call the host `onInvalidate` callback so the TUI redraws without waiting for another keypress.

Related: [`inline-editor.md`](inline-editor.md) for the shared editor behind search and filter rows, and [`../testing/snapshots-and-assertions.md`](../testing/snapshots-and-assertions.md) for the file-snapshot policy these views render through.
