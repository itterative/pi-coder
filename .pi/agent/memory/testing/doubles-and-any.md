---
name: doubles-and-any
description: Reuse a shared test double instead of a hand-built literal, and keep the repo-wide zero no-explicit-any baseline at zero.
category: workflow
---

# Double reuse and the `no-explicit-any` baseline

## Reuse a double before writing one

**Find the helper before writing a literal.** The catalog is `../test-doubles.md`: `createPiStub` and
`stubContext` for the `pi` surfaces, `agent-doubles` `partial*` for domain objects, `child-run-fixture` for a
wired child extension, `test/helpers.ts` for TUI driving, `test/tools/e2e/helpers.ts` for temp dirs, SQLite,
and git.

**A hand-built `const pi = { ... } as any` is the pattern that produced the mess** — it took the form
`const pi = { on(...) {...} } as any;` in the suites it came from. It appeared 28 times across 10 test files, and
each cast silently absorbed a rename or a missing field: the test kept passing while describing an object
production cannot construct. That is how `test/` reached 199 `no-explicit-any` findings.

**When a shape is missing, extend the shared helper so the next suite inherits it** — do not re-declare it
locally.

## The baseline is zero, so a new hit is a regression

- The cleanup that removed those duplicates finished with the TUI/dialog cluster, so
  `@typescript-eslint/no-explicit-any` is now **zero repo-wide**: any new hit is a regression rather than baseline
  noise.
- **No new `no-explicit-any`.** Where a signature genuinely cannot be implemented from test code, cast to the
  _real_ type and state the reason in place — see the narrowing policy in `../test-doubles/rules.md`.
- `npx eslint test/<file>` must be clean on files you touched before you call the work done.
