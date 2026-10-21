---
name: domain-partials
description: The agent-doubles partial* catalog, session-event builders, dedent, and picking the context double by parameter type rather than convenience.
category: workflow
keep_updated: true
---

# Domain partials and choosing a context double

## `test/helpers/agent-doubles.ts`

- **A domain object where most fields are irrelevant** → `partialRun`, `partialDetails`, `partialWorkspace`,
  `partialWorkspaceResult`, `partialTracker`, `zeroUsage` — not a partial literal plus a cast.
- **A durable-persistence or state-writer double** → `partialPersistence`, `partialStateWriter` — not a
  duck-typed object plus a cast across the two contracts.

## `test/helpers/session-events.ts`

A child-session event to feed `updateTracker` → `messageStartEvent`, `textDeltaEvent`, `thinkingDeltaEvent`,
`toolExecutionStartEvent`, `toolExecutionEndEvent` — not a partial event plus `as any`.

## Picking the context double: by the parameter type, not by convenience

`stubContext` satisfies `ExtensionContext`; dialog entry points that declare `ExtensionCommandContext` (`confirm`
at `src/tui/confirmation.ts:93`, `showAgentSessionBrowser`) need `stubCommandContext`, and the compiler rejects
the swap. Do not hand-build `{ cwd, ui } as any` for either.

**The branch each one guards also differs:** `src/tui/confirmation.ts:95` requires `hasUI && mode === "tui"`,
while `src/tui/ask-user.ts:384` and `src/tui/select-with-message.ts:521` read only `ctx.hasUI` and never
`ctx.mode`. Copying one file's override set onto the other silently changes which branch runs.

## `test/modules/memory/utils.ts`

`dedent` builds template-string fixtures without indentation — not manual leading-space stripping.

Related: the context doubles themselves are documented in [`pi-stub.md`](pi-stub.md), and the rules about what a
double may answer are in [`rules.md`](rules.md).
