---
name: tui
description: "src/tui structure — which shared component answers which need, the invariants they carry, and where each nested TUI doc lives. Load for src/tui work."
category: architecture
priority: 8
keep_updated: true
---

# Shared TUI components (`src/tui/`)

Composable building blocks, extracted to deduplicate dialog and status-footer behavior. The rule AGENTS.md encodes for this directory: extend the shared components in `src/tui/list-view.ts` and `src/tui/inline-editor.ts` rather than duplicating their behavior — a layout or editing fix belongs in the shared engine once, so every host inherits it.

## Which component for which need

- `list-view.ts` — the `ListViewComponent<T, R, S>` base class for any list-style dialog or browser view; new list UI subclasses `pager.ts`, `select.ts`, or `multi-select.ts` rather than rebuilding the frame. `tui/list-view.md`.
- `inline-editor.ts` — `InlineEditor`: the theme-free inline edit engine behind every free-text field. `tui/inline-editor.md`.
- `text-input.ts` — `TextInputComponent<T>`: the generic modal inline field (`InlineEditor` + `BorderBox`) with caller-supplied `parse`/`format` and validation errors.
- `numeric-input.ts` — facade over it: reach for `numericInput()` when a setting needs an arbitrary numeric value instead of a fixed choice list.
- `dialog-queue.ts` — shared abort-aware FIFO behind `askUser()` and `selectWithMessage()`. `tui/dialogs.md`.
- `confirmation.ts` — `ConfirmationComponent` + `confirm()`: centered, focus-safe yes/no overlays that open from an existing overlay.
- `spinner.ts` — `Spinner`: small animated frame component for a status line. `tui/packages.md`.
- `agents/` — agent browser TUI, composing the generic list/pager/select components. `tui/packages.md`.
- `decision/` — decision-model settings TUI; mirrors `agents/`, not the status package. `tui/packages.md`.
- `status/` — the shared parent status footer, one compact line. `tui/status-footer.md`.
- `ask-user.ts` / `select-with-message.ts` — the dialogs themselves; their terminal-height layout rules are in `tui/layout.md`.

## Invariants most often broken

- A future permission dialog must use one of the queued entrypoints rather than calling `ctx.ui.custom()` directly.
- Editing and layout fixes go in `InlineEditor` once — both dialogs inherit them.
- Content changes call `invalidate()`; offset-only navigation from custom key handlers takes the non-cache-invalidating path.
- The footer reserves the right cluster's width first, so the left prunes first; a `shrinkToFit` segment is shortened before it is dropped.
- Tests must render after every keypress — `InlineEditor` up/down reads render-computed visual-line state.
- Agent- and decision-specific TUI stays in its package; transcript projections belong under `src/tools/agent/presentation/`.

## Targeted references

Load only what the task needs; these nested docs are on-demand and are not listed in the memory index.

- `tui/list-view.md` — base class, subclasses and extension points, the composed agent browser host, framing/viewport/render-cache and scroll-offset rules.
- `tui/inline-editor.md` — the engine, `text-input.ts`/`numeric-input.ts` facades, atomic paste, display↔content mapping, wrapping, up/down, and how to test edits.
- `tui/dialogs.md` — the abort-aware dialog FIFO, `confirm()` overlays, queue and overlay-stack rules.
- `tui/status-footer.md` — badge, agent summary, TODO progress, usage totals, pruning order, tip rotation.
- `tui/layout.md` — permission-dialog layout invariants that prevent flickering.
- `tui/packages.md` — `agents/` and `decision/` boundaries, `spinner.ts`, transcript projection.

Related clusters: `agents.md` + `agents/lifecycle.md` (browser and status-widget semantics), `testing.md` + `testing/snapshots-and-assertions.md` (file-snapshot policy), `test-doubles.md` + `test-doubles/tui-e2e.md` (headless TUI harness), `decision-model.md` (`alt+a`, the consult the badge reports), `sandbox.md` (the prompts these dialogs raise).
