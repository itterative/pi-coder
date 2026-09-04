---
name: testing
description: Local validation commands and manual checks for the consolidated pi-coder extension.
category: workflow
---

# Testing pi-coder

Run the full suite with `npm run test:run` and check types with `npm run typecheck` (or `npx tsc --noEmit`). The tests cover the consolidated TUI, memory, config, and sandbox modules.

Quality checks are available through `npm run lint`, `npm run format:check`, and `npm run knip`; `npm run check` runs typechecking, linting, formatting, tests, and Knip together. ESLint uses the flat config in `eslint.config.mjs`, with cyclomatic and cognitive complexity currently reported as warnings. The repository currently has pre-existing lint, formatting, and Knip findings; do not treat those baseline findings as regressions without comparing changes.

Use `./scripts/cognitive_load_report.py` for a detailed complexity overview. It runs ESLint once, tolerates unrelated lint errors, reports both complexity rules, groups findings by file/subsystem, and supports `--target`, `--top`, `--format json`, `--input`, and threshold options.

Use `./scripts/coverage_report.py <source-glob> --tests <files...>` to see which paths a suite never reaches before refactoring, since coverage percentages alone hide that. It runs `vitest run --coverage` scoped to the targets (or analyzes an existing `coverage-final.json` with `--input`) and lists each uncovered branch *path* with its own source line, plus uncovered statements and functions, and supports `--top`, `--format json`, and `--fail-on gaps|thin --min-branches`. Narrow `--tests` deliberately: Vitest instruments only what the selected tests load, so untargeted files report as never loaded.

For a manual permission-prompt check, run `cat /etc/hostname`; without a matching rule it should prompt with `ask`. Verify the `selectWithMessage` UI, long-command wrapping and scrolling, Tab edit mode, bracketed clipboard paste, wrapped feedback, and Enter/Escape behavior.

Database-backed agent tests must use an explicit temporary state/workspaces directory; integration tests that only exercise agent action presentation should mock catalog access rather than allowing the default `.state/meta.sqlite` path. The project-local `.state/` directory is runtime state and must not be mutated by the test suite. Shared workspace lifecycle E2E tests live under `test/tools/e2e/` and should use its `createE2EPaths`, `createE2EContext`, `withE2EMetadataDatabase`, and `createScriptedChild` helpers so temporary SQLite, context defaults, cleanup, and child handles remain consistent.

TUI widget tests must assert distinct projected **states**, not a trace of render frames. The background-flow recorder in `test/tools/agent-tool.test.ts` dedupes consecutive identical frames before `toMatchFileSnapshot`, because the widget requests a render on every status event, so a raw frame trace snapshots how many microtask boundaries a flow contains and a transient state (`Starting:`) can coalesce into the next frame. Keep that recorder dedupe when adding widget coverage, and prefer `vi.waitFor` over fixed flush counts for background-settling assertions.

Parser benchmarks:

- `npm run bench` runs `test/modules/sandbox/bash.bench.ts`, measuring `parseBashAst()` across simple, medium, and high-complexity command corpora. Benchmarks are separate from `npm run test:run`.
- Benchmark output is machine-specific and intended as a future AST-parser performance baseline, not a hard threshold.

Relevant test locations:

- `test/ask-user.test.ts`, `test/select-with-message.test.ts`, and `test/inline-editor.test.ts` for TUI editing.
- `test/modules/memory/` for frontmatter parsing, memory scanning, and list formatting.
- `test/common/config.test.ts` and `test/modules/sandbox/` for sandbox behavior, heuristics, permissions, resolution, suggestions, bubblewrap, fuzzing, and bash parsing.
