---
name: pi-version
description: Pinned `@earendil-works/pi-*` dev-dependency version, why it is pinned there, and the compatibility fixes the 0.84 → 1.1.0 bump required.
category: architecture
---

# pi dependency version

`package.json` pins `@earendil-works/pi-ai`, `pi-tui`, and `pi-coding-agent` at **`^1.1.0`** (dev dependencies;
pi-coder is an extension, so at runtime the host pi provides these). The runtime pi on this machine is **1.3.0**,
but 1.1.0 is the pinned floor.

## Why 1.1.0

1.1.0 is the first release with the classifier/decision-model surface the decision-model work needs:
`ctx.modelRegistry.classify(model, { state, questions }, options?)`, plus `getModelOfType("classifier", …)` /
`findOfType` / `getAvailableOfType`, and native llama.cpp `/v1/systemone` decision models. (`classify()` itself
landed in 0.99.0; native llama.cpp decision models, Cloudflare Clef, and GPT-6 Luna arrived in 1.0.x–1.1.0.)

The repo `.npmrc` sets `min-release-age=7`. On 2026-10-17, 1.2.0 (5 days) and 1.3.0 (2 days) were inside that
window; 1.1.0 (10 days) cleared it. Do not bump to 1.2/1.3 without either waiting or an explicit decision to
override the age policy. See `docs/bash-execution-redesign.md` Part C.

## Compatibility fixes from 0.84 → 1.1.0

These were the only breakages; `npx tsc --noEmit` and `npm run typecheck:tests` plus the suite are green again.

- **`ToolInfo.exposure` is required** (was optional on `ToolDefinition`). `stubToolInfo` supplies `"direct"`.
- **`Message` gained `SystemMessage`** (`role: "system"`). `messageParts` in
  `src/tools/agent/presentation/transcript.ts` must handle it; it returns `[]` (prompt, not conversation).
- **pi-tui split `Box` and `Container`** into unrelated classes (both implement `Component`). The list-view
  `footerContent` callback receives the padded content `Box`, so its type is `Box`, not `Container` (propagated to
  `pager.ts`, `select.ts`, `multi-select.ts`). `headerContent` still receives a `Container`.
- **`OverlayHandle.getBounds()` and `Terminal.setProgramStatus()` are new required members**; the local test fakes
  in `test/tui/overlay-stack.test.ts` and `test/tui/confirmation.test.ts` supply them.
- **`ToolCall.arguments` and `ToolResultMessage.details` are `JsonObject`**, not `Record<string, unknown>`;
  the compaction test doubles and `sections.test.ts` were retyped to `JsonObject`.

## Behavior change to remember

pi 1.1.0's `buildSessionProjection` emits a compaction summary only for the `compaction` entry at index 0, so a
session with multiple folds carries one summary (the newest), not one per fold. The non-idempotent hoist defect is
unchanged. Details in the `compaction` memory (`compaction.md`), nested at `compaction/pipeline.md`.