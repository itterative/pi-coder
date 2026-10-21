---
name: agents-runtime
description: "Per-file complexity invariants for src/tools/agent/: action dispatch, restoration, drive, leases, stored records, discovery, and capability assembly."
category: architecture
keep_updated: true
---

# Delegated-agent lifecycle and persistence complexity

Index: [../complexity-hotspots.md](../complexity-hotspots.md) for the metric-reading conventions and the
refactor-prioritization rules. This doc holds the per-file and per-symbol invariants for `src/tools/agent/`
that the split extracted; the code's own in-place doc comments stay authoritative, and the feature contract
lives in the `agents` memory ([../agents.md](../agents.md)).

## Action dispatch

`executeAgentAction` was decomposed along those lines (236 lines, cognitive 60 → no finding): ordered policy stayed in the façade, one handler per action, and the two hand-rolled terminal-status chains were replaced by the shared `isAgentTerminalStatus`. Do not reintroduce per-action `else if` chains or local status comparisons there.

## Restoration

`AgentRunRestoreCoordinator` in `runs/restore.ts` is organized into preparation, per-record eligibility, definition validation, and run reconstruction, while `AgentRunManager.restoreTerminalRun`/`restoreActiveRun` keep the terminal-rebuild and child-reopen steps. Preserve record ordering by `startedAt`, diagnostic precedence/messages, exact workspace ownership, mutation-capability safeguards, terminal retention/removal, legacy repair behavior, V2 exact-leaf rules, and continuation-lease release when changing these phases.

## Driving, terminal settlement, and leases

### Manager phases

`AgentRunManager.drive` separates prompt failure handling, interruption precedence, child-outcome selection, and parent-question checkpointing. Preserve the abort/cancel/lease-loss precedence, prompt-settlement persistence ordering, guidance checkpoint and lease-release sequencing, foreground progress callback timing, and terminal output/error selection. Terminal settlement (`finishTerminal` → `finishTerminalInternal` → `retainBackgroundResult`/`revertTerminalToInterrupted`), `removeRun` removal ordering, and the shutdown interrupt/await/settle phases each document their own required order in place; read those comments before changing them, and keep checkpoint-before-lease-release sequencing everywhere a run becomes resumable. The one deliberate exception is `revertTerminalToInterrupted`, which releases the lease without a fresh checkpoint because that path only runs after persistence failed or the lease was lost (`AgentRunCheckpointStore.saveNow` refuses lease-lost writes); do not "fix" it by adding a write that would race the new holder.

### Child setup and lease mechanics

`createChildFactoryContext` in `runs/child-setup.ts` owns the child→run callback bridge (progress, session identity, file changes) and documents why its `onProgress` steps are ordered as they are; lifecycle code keeps the decision of when a checkpoint must be durable. `AgentRunLeaseCoordinator` in `runs/continuation-lease.ts` owns grant/recovery/release mechanics only — the lifecycle still decides where a lease is required and when it may be released.

## Persistence

### Continuation-lease ledger

`runs/persistence/lease-ledger.ts` must keep its in-process lease claims (`ContinuationLeaseLedger.active`) and the durable lease rows in step. `SqliteAgentRunStateWriter.persistQueued` decides whether to take its own automatic lease from that map up front and re-reads it while renewing, which is a TOCTOU pair unless a release drops the claim synchronously: `ContinuationLeaseLedger.release` therefore deletes the map entry _before_ awaiting its `DELETE`, and `AgentRunLeaseCoordinator.release` likewise clears `run.continuationLease` before awaiting. That is what lets an already-released run still be checkpointed — `collect` writes the removal tombstone after `retainBackgroundResult` released the lease. Before this ordering was enforced the tombstone was lost silently (`save` returns only a boolean, and the explanatory `ui.notify` fires once per session; `loadAgentRunPersistence`'s `onRefusedWrite` listener is now the unbudgeted diagnostics channel, recorded as the `persistence.save_refused` trace event by `AgentLifecycle`), and it reproduced only under heavy CPU starvation because the release transaction had to land between a save's two transactions. Deterministic coverage lives in `test/tools/agent-persistence-v2.test.ts` (“persists a save whose lease was released in the same turn”), which gates the connection with an open write transaction; prefer that technique over load-looping when chasing ordering races.

### Stored-record parsing

`parseRecord` in `runs/persistence/stored-record.ts` stays a single long guard chain over untrusted stored data; its cyclomatic count reflects stored-shape defensiveness, not a missing abstraction. What was split is the coercion inside its return literal: `normalizeProgress`, `normalizeQuestion`, and `normalizeMutationReport` now hold the nested ternaries, and the asymmetry between them and the outer gate is the invariant to preserve — identity and authority checks (`version`, owner, run-id shape, agent/run-id prefix, fingerprint, restorable status, `nonNegativeNumber` timestamps, plus the marker/column cross-checks in `validateAgentRunSnapshot`) reject the whole record, while display state (progress, question text beyond its cap, mutation lists) degrades so a run stays restorable without its last frame. `RESTORABLE_STATUSES` deliberately includes `removed` so tombstones restore, and `nonNegativeNumber` carries the non-negativity contract, making a stored negative count or timestamp corruption rather than a value to clip. The exported seam `validateAgentRunSnapshot` pins all of this in `test/tools/agent-run-snapshot-shape.test.ts`; keep `parseRecord` module-private and add cases there instead of exporting it.

### Loading the persistence façade

`loadAgentRunPersistence` in `runs/persistence/load.ts` is a short orchestrator over one function per phase (open → marker scan → session heads → branch heads → legacy read-only compatibility → latest resolution → writer → facade), with the diagnostics accumulator, the refusal-warning budget, and the returned facade each behind a small class. Extraction kept every diagnostic string call-site specific, because those messages are user-visible and asserted, and it kept `initializeAgentRunContinuationHeads`/`createAgentRunStateWriter` calls visible in the orchestrator. Any step that must not leak an open connection goes through the existing `withDatabaseFailureCleanup(database, ...)` wrapper rather than a hand-rolled `try { await database.close() } catch {} throw` block; two of those were duplicates of the helper. The refusal path is `RefusedWriteReporter.report`, which owns the one-shot UI warning flag while the `onRefusedWrite` listener stays unbudgeted. The legacy non-marker save branch has no direct test and is read-only compatibility for the pre-V2 session facade; do not extend it.

## Definition discovery

`loadScope` in `definitions/discovery.ts` is now four small functions over one file each: `readScopeFile` (read plus frontmatter parse, body trimmed), `normalizeScopeDefinition` (every field rule, returning a decision instead of recording one), `mergeScopeDefinition` (apply requested fields over a base), and the loop, which keeps the `warn` envelope, duplicate detection, and the merge call. `normalizeScopeDefinition` takes no diagnostics array, no filesystem, and no scope in its messages, which is what makes the authorization rules testable in isolation. Two invariants there are load-bearing and order-dependent: **guard order is user-visible**, because the unsupported `tools` advisory and the ignored-overlay-capabilities advisory are raised after the model guard but before the capability/path/command guards, so a file with a bad `model` reports only the model while a file with a bad `capabilities` list reports the advisory _and_ the rejection — the exact-array guard-order test in `test/tools/agent-discovery.test.ts` pins the sequence, and `toContainEqual` cannot, because it tolerates extra entries; and an **empty body must not replace the base prompt** (`body || base.systemPrompt`), which is intended so a metadata-only overlay keeps the built-in's instructions and is why the custom skeleton is built with an empty prompt. `overrides` carries **only requested keys**, because an overlay spreads the built-in and `model: undefined` would erase the built-in's own value instead of inheriting it. Description and model are normalized once into `trimmedDescription` / `trimmedModel`, which is why the old `(description as string)` cast and the unreachable `typeof model === "string"` check are gone. Definition files are authored as fixtures under `test/tools/fixtures/agent-definitions/`, one per guard, and equivalence during this extraction was proven by diffing against a temporary copy of the pre-refactor module over ~195 generated combinations plus every checked-in fixture (agents and diagnostics as JSON). The remaining cognitive score in that file was intrinsic to a validator; it no longer exceeds the threshold, and the guard chain must not become a predicate table.

## The assembled model: capability declarations

### Capability declaration and gates

The child capability restructure is the model for the assembled case when the branches are _scenario combinations_ rather than state: put the declaration and its implications in `definitions/types.ts`, resolve once into a grant, give each capability a unit that owns its own contributions, and give each authorization surface a gate with its own `applies`/`install`. Two prompt-side findings (cognitive 37 and a 171-line closure) disappeared that way with no score-hunting: the four-arm profile chain became four named profiles, and the flag pairs it switched on became one rung comparison. The one finding left in that package is deliberate: the `44` at `command-permissions.ts`'s `tool_call` handler is the Bash resolve, sandbox-mode, prompt, and command-rewrite sequence, which is intrinsic domain ordering that the maintainer has chosen to keep visible as a signal rather than decompose or suppress. "Who gets gated" no longer lives there (it is `COMMAND_GATE.applies`), so treat that score as a read-this-before-changing-the-order marker rather than a refactor target.

### `createAgentRunStateWriter`

`createAgentRunStateWriter` was the assembled case and is now a class: the factory returns a `SqliteAgentRunStateWriter`, `ContinuationLeaseLedger` owns the token/timer/lost-set cluster, and `JournalHeadExpectations` owns the compare-and-set expectations that the lease claim and the reserve transaction both repeat. The writer left the size inventory entirely and no score changed, because each private method was already implicit in the closure. Reach for that shape when a function _assembles_: captured mutable state becomes named fields, and each ordering invariant stays in the doc comment above the one method that enforces it. Keep the factory function as the exported seam so call sites and tests do not churn.
