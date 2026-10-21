---
name: mutation-proofs
description: Mutate the source and assert the mutation landed, diagnose redundant or equivalent mutants, and diff a restructure against a frozen baseline.
category: workflow
---

# Proving a test actually detects the regression

## Mutate, confirm the failure, and assert the mutation applied

When proving a test actually detects a regression, mutate the source and confirm the test fails — **and assert
the mutation applied**. An exact string replace silently becomes a no-op when formatting differs (Prettier
re-wraps long boolean expressions), which reads as "the tests caught nothing" and can also leave the tree mutated:
restore from a saved copy, not by re-running the reverse replacement. Verify the mutation was actually written
before running the suite, because re-testing an untouched file looks identical to an undetected regression. (The
same assert-before-write rule for scripted edits is the `patch-hygiene` memory, `../patch-hygiene.md`.)

## When an applied mutation produces no failures, diagnose the clause before adding tests

- **It is often already redundant, because a helper enforces part of the condition.** That is what happened with
  `finite(value) && value < 0` in `runs/persistence/stored-record.ts`, where `finite` also rejected negatives. Fix
  the naming rather than doubling down — the helper is now `nonNegativeNumber`, whose name carries the whole
  contract — then pin the boundary with a case per direction (negative timestamps and a negative failed-tool count
  in `test/tools/agent-run-snapshot-shape.test.ts`) so a future relaxation of the helper is caught at the call
  sites that matter.
- **Check whether the mutant is _equivalent_ before writing a test for it:** `previous.order <= entry.order` and
  `< entry.order` in `runs/persistence/load.ts` cannot disagree, because markers arrive in ascending transcript
  order, so only the newest can win either way; reversing the comparison to `>=` is caught by the existing
  branch-checkpoint test. Prove equivalence by mutating in the direction that must fail before concluding a
  behavior is unguarded.

## Proving a pure or near-pure module survived a restructure

Copy the pre-change file out of git next to the new one (`outcomes-baseline.ts`), write a temporary differential
test comparing rendered output over a generated input matrix, then delete both files.

- **Include a negative control:** mutate one asymmetric rule in the new module and confirm the differential test
  fails, otherwise an accidentally identical import pair reads as a proof.
- **Compare in the same process** rather than against a golden JSON file captured earlier: a file-based oracle
  inherits ambient state (config singletons initialized differently in a solo run versus a full-suite worker,
  `git config` lookups, `bwrap` availability) and reports order-dependent mismatches that are not behavior
  changes.
- **Three hazards when the subject installs event handlers:** handlers legitimately mutate their input (the
  command gate rewrites `input.command` when sandboxing, the mutation gate writes `_userMessage`), so rebuild the
  call corpus per implementation or the first side poisons the second; a mutation lock is held until `tool_result`
  arrives, so a driver that never sends one deadlocks; and driving a handler against a parent that reports a UI
  reaches a real dialog that can never resolve in a test, so use the no-UI arm where every prompt denies
  deterministically.
- **Freeze the _whole_ decision chain:** a copy of `child/` that still imports the live `definitions/types.ts`
  cannot see a change to capability semantics, which is how the differential missed its first real over-grant.
