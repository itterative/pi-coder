---
name: typecheck-and-format
description: tsconfig.json excludes test/, so use typecheck:tests or the single-file probe, run the touched suite, and keep Prettier on explicit paths.
category: workflow
---

# Typechecking tests, verifying handed-down code, and formatting

## `tsconfig.json` excludes `test/`

**Typecheck the test file too**, since `tsconfig.json` excludes `test/` — it includes only `src/**/*.ts`, so a
bare `npx tsc --noEmit` stays green after a test imports a name the module no longer exports, and the only
symptom is `TypeError: cloneUsage is not a function` when Vitest runs it.

- `npm run typecheck:tests` (config `tsconfig.check.json`) compiles `src` plus `test` under the project's real
  options and is wired into `npm run check`. It reports **zero errors** for `src` + `test`, so a test-tree type
  error is a regression from here, not baseline noise.
- For one file — the **single-file probe** — use
  `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node,vitest/globals test/<file>.test.ts`.
- **`import type` is the quieter variant of the same hole:** a type imported from a module that never exported it
  erases at runtime (`import type { X } from "..."` included), so the suite passes and only the single-file probe
  reports it.
- The project-wide variant is now a gate, which is also what catches a test leaning on runtime API beyond the
  compile target — `tsconfig.json` sets `target: ES2024`, so the ES2023 array methods (`findLast`, `toSorted`,
  `toReversed`) are promised in `src` and in tests alike, and the single-file probe command above is the one place
  a stale `--target` would still reject them.

## Run the touched suite even when typechecking passes

**Always run the touched suite after a structural change even when typechecking passes**, and run the probe to
catch the type-side drift.

## Verify any code you hand to a child

When a delegation task quotes a helper signature or a snippet, run the single-file probe over it first and say
where reality was measured (commit, line numbers). A child cannot tell an illustrative sketch from a checked
example, so an unverified snippet costs a round trip when the child reports the mismatch — or gets quietly worked
around.

## Prettier only on explicit file paths, at the end

**Prettier must be run on explicit file paths, never a directory:** `npx prettier --write src/tools/agent/`
sweeps the `*.md` files under that directory into a reformat — including `src/tools/agent/TODOS.md`, which is
user-managed — and `npm run format:check` will not flag it because those paths are outside the sanctioned glob, so
the damage only appears in `git status`. Format once, at the end of a task, then check `git status` for collateral
`*.md` reformatting before reporting the work clean.
