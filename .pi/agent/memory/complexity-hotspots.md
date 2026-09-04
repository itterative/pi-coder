---
name: complexity-hotspots
description: Conventions for interpreting and reducing complexity in pi-coder.
category: architecture
priority: 3
keep_updated: true
---

# Complexity conventions

Complexity metrics are review signals, not defects. A high score should trigger inspection rather than automatic refactoring.

- Prefer cognitive complexity for readability decisions; use cyclomatic complexity mainly as a signal for testing and path-coverage risk.
- Prioritize severe outliers and changed code before attempting to reduce the historical baseline.
- Refactor by semantic responsibility: separate parsing, validation, state transitions, persistence, and rendering rather than splitting arbitrary blocks to lower a score.
- Do not game the metric with dispatch tables, excessive indirection, or tiny wrappers that make the code harder to follow.
- Prefer guard clauses and explicit phases. Parser methods should have clear recognition guards, one responsibility, and obvious progress/termination behavior.
- Keep cursor and state ownership unambiguous. Cursor movement should have one owner; parser context should be separate from cursor control where practical.
- Preserve domain invariants explicitly. Parser and security code may legitimately need defensive branches or conservative fallbacks; document those reasons.
- Require behavior-preserving tests before refactoring. Run focused tests first and the full suite after structural changes.
- Use complexity suppressions only when narrowly scoped, documented, and justified by inherently complex domain behavior.
- Review other dimensions alongside scores: nesting depth, function length, mutable state count, number of modes, and testability.
- Track trends rather than only absolute values. A smaller score is not an improvement if readability gets worse.

## Qualitative priorities

When prioritizing refactors, start with delegated-agent lifecycle/state-machine orchestration and sandbox parser/policy phases. Persistence normalization and validation boundaries are secondary; TUI rendering and input handling can usually be addressed incrementally. Preserve conservative security behavior and existing tests when decomposing sandbox logic.

`AgentRunRestoreCoordinator` in `runs/restore.ts` is organized into preparation, per-record eligibility, definition validation, and run reconstruction, while `AgentRunManager.restoreTerminalRun`/`restoreActiveRun` keep the terminal-rebuild and child-reopen steps. Preserve record ordering by `startedAt`, diagnostic precedence/messages, exact workspace ownership, mutation-capability safeguards, terminal retention/removal, legacy repair behavior, V2 exact-leaf rules, and continuation-lease release when changing these phases.

`AgentRunManager.drive` separates prompt failure handling, interruption precedence, child-outcome selection, and parent-question checkpointing. Preserve the abort/cancel/lease-loss precedence, prompt-settlement persistence ordering, guidance checkpoint and lease-release sequencing, foreground progress callback timing, and terminal output/error selection. Terminal settlement (`finishTerminal` → `finishTerminalInternal` → `retainBackgroundResult`/`revertTerminalToInterrupted`), `removeRun` removal ordering, and the shutdown interrupt/await/settle phases each document their own required order in place; read those comments before changing them, and keep checkpoint-before-lease-release sequencing everywhere a run becomes resumable. The one deliberate exception is `revertTerminalToInterrupted`, which releases the lease without a fresh checkpoint because that path only runs after persistence failed or the lease was lost (`AgentRunCheckpointStore.saveNow` refuses lease-lost writes); do not "fix" it by adding a write that would race the new holder.

`createChildFactoryContext` in `runs/child-setup.ts` owns the child→run callback bridge (progress, session identity, file changes) and documents why its `onProgress` steps are ordered as they are; lifecycle code keeps the decision of when a checkpoint must be durable. `AgentRunLeaseCoordinator` in `runs/continuation-lease.ts` owns grant/recovery/release mechanics only — the lifecycle still decides where a lease is required and when it may be released.

`createAgentRunStateWriter` in `runs/persistence.ts` must keep its in-process lease claims (`activeLeases`) and the durable lease rows in step. `save` decides whether to take its own automatic lease from that map up front and re-reads it while renewing, which is a TOCTOU pair unless a release drops the claim synchronously: `releaseLease` therefore deletes the map entry _before_ awaiting its `DELETE`, and `AgentRunLeaseCoordinator.release` likewise clears `run.continuationLease` before awaiting. That is what lets an already-released run still be checkpointed — `collect` writes the removal tombstone after `retainBackgroundResult` released the lease. Before this ordering was enforced the tombstone was lost silently (`save` returns only a boolean, and the explanatory `ui.notify` fires once per session; `loadAgentRunPersistence`'s `onRefusedWrite` listener is now the unbudgeted diagnostics channel, recorded as the `persistence.save_refused` trace event by `AgentLifecycle`), and it reproduced only under heavy CPU starvation because the release transaction had to land between a save's two transactions. Deterministic coverage lives in `test/tools/agent-persistence-v2.test.ts` (“persists a save whose lease was released in the same turn”), which gates the connection with an open write transaction; prefer that technique over load-looping when chasing ordering races.

`extractCommandPaths` is implemented through a private `CommandPathExtractor` context. Its extraction loop delegates legacy redirections, options, process substitutions, positional modes, AST redirections, and final validation to named methods while preserving conservative fallbacks. Argument helpers consistently return the next unprocessed index; an unchanged index means no match, and `null` means unsafe.

`heuristics/evaluator.ts` keeps directory-state transitions and AST traversal in semantic helpers: directory operand parsing/target resolution/state updates are separate from `applyDirectoryCommand`, while `isConfined` delegates parsing, statement evaluation, and command-part snapshot/restore. The non-persistent pipeline/background snapshot protocol and persistent chain/statement state must remain explicit.

`isCommandConfined` in `heuristics/evaluator.ts` is organized into environment normalization, command resolution, directory-builtin assessment, command-access extraction, path validation, and post-access policy checks. Keep the order of policy checks and diagnostic reasons stable when changing these phases.

The permission matcher in `src/modules/sandbox/permissions.ts` keeps cursor ownership in `matchArgs`; wildcard lookahead/remainder handling, recursive nested-substitution matching, and heredoc trailing-argument compatibility are separate helpers. Preserve its depth/iteration guards and chain-operator rejection when changing matcher behavior.

`src/modules/sandbox/resolve.ts` separates single-segment resolution from line-level state and aggregation. `resolveSegment` must still evaluate cwd confinement before policy selection so modeled directory state advances even for explicitly covered commands; `resolveLine` owns pipeline/background snapshot restoration, deny short-circuiting, and unresolved collection. Resolve tests cover explicit-policy `cd` state isolation for `|`, `|&`, and `&` chains.

Use `scripts/cognitive_load_report.py` for current measurements rather than storing threshold values or dated score tables in this memory.
