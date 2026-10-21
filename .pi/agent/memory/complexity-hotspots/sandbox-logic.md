---
name: sandbox-logic
description: "Per-file complexity invariants for src/modules/sandbox/: path extraction, evaluator, permission matcher, resolve, and the security rule."
category: architecture
keep_updated: true
---

# Sandbox parser and policy complexity

Index: [../complexity-hotspots.md](../complexity-hotspots.md) for the metric-reading conventions. This doc
holds the per-file invariants for `src/modules/sandbox/`; the confinement semantics themselves belong to the
`sandbox` memory (`sandbox.md`) and its `sandbox/confinement.md` detail doc.

**Preserve conservative security behavior and existing tests when decomposing sandbox logic.**

## Command path extraction

`extractCommandPaths` is implemented through a private `CommandPathExtractor` context. Its extraction loop delegates legacy redirections, options, process substitutions, positional modes, AST redirections, and final validation to named methods while preserving conservative fallbacks. Argument helpers consistently return the next unprocessed index; an unchanged index means no match, and `null` means unsafe.

## Heuristic evaluator

`heuristics/evaluator.ts` keeps directory-state transitions and AST traversal in semantic helpers: directory operand parsing/target resolution/state updates are separate from `applyDirectoryCommand`, while `isConfined` delegates parsing, statement evaluation, and command-part snapshot/restore. The non-persistent pipeline/background snapshot protocol and persistent chain/statement state must remain explicit.

`isCommandConfined` in `heuristics/evaluator.ts` is organized into environment normalization, command resolution, directory-builtin assessment, command-access extraction, path validation, and post-access policy checks. Keep the order of policy checks and diagnostic reasons stable when changing these phases.

## Permission matcher

The permission matcher in `src/modules/sandbox/permissions.ts` keeps cursor ownership in `matchArgs`; wildcard lookahead/remainder handling, recursive nested-substitution matching, and heredoc trailing-argument compatibility are separate helpers. Preserve its depth/iteration guards and chain-operator rejection when changing matcher behavior.

## Segment and line resolution

`src/modules/sandbox/resolve.ts` separates single-segment resolution from line-level state and aggregation. `resolveSegment` must still evaluate cwd confinement before policy selection so modeled directory state advances even for explicitly covered commands; `resolveLine` owns pipeline/background snapshot restoration, deny short-circuiting, and unresolved collection. Resolve tests cover explicit-policy `cd` state isolation for `|`, `|&`, and `&` chains.
