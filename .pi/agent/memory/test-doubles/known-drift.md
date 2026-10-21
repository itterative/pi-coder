---
name: known-drift
description: Live worklist of test-double drift still to fold back. Verify each item before acting; these are open gaps, not settled fact.
category: workflow
keep_updated: true
status: Live worklist - re-verified 2026-10-21
---

# Known drift to fold back

**This is a live worklist, verified 2026-10-21 — not settled fact.** Every item below was confirmed still open on
that date unless it says otherwise. Line numbers quoted from `src/` are as-recorded and need re-checking before
you act on them.

## Still open (re-checked 2026-10-21)

- **`test/tools/e2e/helpers.ts` defines its own `zeroUsage()`**; `test/helpers/agent-doubles.ts` exports the same
  thing (the duplicate is live at `e2e/helpers.ts:95`). Consolidate on the doubles module, and prefer the
  `agent-doubles` version in new code.
- **Knip still lists three unused test-side exports** that predate the double cleanup: `paste` in
  `test/helpers.ts`, and `assertTemporaryStateDirectory` / `openE2EMetadataDatabase` in
  `test/tools/e2e/helpers.ts`. Left in place; delete them if you agree nothing external drives them.
- **`LoadedAgentRunPersistence.catalog` is produced (`runs/persistence/load.ts:451`) and never read** in `src/` or
  in tests. `partialStateWriter` exists so the fixture stops conflating it with `AgentRunPersistence`, but the
  field itself is a candidate for removal from the contract — a production change, so confirm intent first.

## Re-checked and closed, kept for reference

- **`test/tools/agent.test.ts` is probe-clean** (re-confirmed 2026-10-21 with the single-file probe).
  Its 50 type errors came from three root causes (a `getSessionLeafId` return that widened past the interface,
  `save` returning `boolean` instead of `Promise<boolean>`, and lease grantors returning the lease instead of a
  promise); typing one `implements` clause cleared ~35 of them. Recorded here so the shape of the fix is not
  re-derived.
- The repo-wide `no-explicit-any` and test-tree type-error baselines are now folded into
  `../testing/doubles-and-any.md` and `../testing/typecheck-and-format.md`.
- The `createE2EContext` / `loadE2EPersistence` contract is folded into [`tui-e2e.md`](tui-e2e.md).
