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

`extractCommandPaths` is implemented through a private `CommandPathExtractor` context. Its extraction loop delegates legacy redirections, options, process substitutions, positional modes, AST redirections, and final validation to named methods while preserving conservative fallbacks. Argument helpers consistently return the next unprocessed index; an unchanged index means no match, and `null` means unsafe.

`heuristics/evaluator.ts` keeps directory-state transitions and AST traversal in semantic helpers: directory operand parsing/target resolution/state updates are separate from `applyDirectoryCommand`, while `isConfined` delegates parsing, statement evaluation, and command-part snapshot/restore. The non-persistent pipeline/background snapshot protocol and persistent chain/statement state must remain explicit.

`isCommandConfined` in `heuristics/evaluator.ts` is organized into environment normalization, command resolution, directory-builtin assessment, command-access extraction, path validation, and post-access policy checks. Keep the order of policy checks and diagnostic reasons stable when changing these phases.

The permission matcher in `src/modules/sandbox/permissions.ts` keeps cursor ownership in `matchArgs`; wildcard lookahead/remainder handling, recursive nested-substitution matching, and heredoc trailing-argument compatibility are separate helpers. Preserve its depth/iteration guards and chain-operator rejection when changing matcher behavior.

`src/modules/sandbox/resolve.ts` separates single-segment resolution from line-level state and aggregation. `resolveSegment` must still evaluate cwd confinement before policy selection so modeled directory state advances even for explicitly covered commands; `resolveLine` owns pipeline/background snapshot restoration, deny short-circuiting, and unresolved collection. Resolve tests cover explicit-policy `cd` state isolation for `|`, `|&`, and `&` chains.

Use `scripts/cognitive_load_report.py` for current measurements rather than storing threshold values or dated score tables in this memory.
