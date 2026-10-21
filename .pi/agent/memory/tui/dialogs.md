---
name: dialogs
description: "Abort-aware dialog FIFO and the confirm() yes/no overlay, plus the queue and overlay-stack rules new modals must follow. Load when adding a dialog."
category: architecture
keep_updated: true
---

# Modal dialogs and overlays (`src/tui/dialog-queue.ts`, `src/tui/confirmation.ts`)

## `dialog-queue.ts` — shared abort-aware FIFO for modal `ctx.ui.custom()` dialogs

- `askUser()` and `selectWithMessage()` both use it; future permission dialogs must use one of these queued entrypoints rather than calling `ctx.ui.custom()` directly.
- Queued cancellation returns promptly without allowing later dialogs to overtake the active one.

## `confirmation.ts` — reusable `ConfirmationComponent` and `confirm()` helper for centered, focus-safe yes/no overlays

- The helper participates in `withOverlayStack`, so it can be opened from an existing overlay; the delegated-agent browser uses it for agent cancellation and workspace disposition actions.

Both live behind the queued entrypoints above: `askUser()` and `selectWithMessage()` for prompts, `confirm()` for yes/no. The overlay stack that keeps nested overlays focus-safe is `src/tui/overlay-stack.ts` (`withOverlayStack`).

## Permission prompts

Permission-dialog layout invariants — the ones that stop a tall prompt from flickering — are in [`layout.md`](layout.md). The permission semantics these dialogs raise belong to [`sandbox.md`](../sandbox.md) and [`decision-model.md`](../decision-model.md).
