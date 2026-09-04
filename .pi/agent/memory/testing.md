---
name: testing
description: Local validation commands and manual checks for the consolidated pi-coder extension.
category: workflow
---

# Testing pi-coder

Run the full suite with `npm run test:run` and check types with `npm run typecheck` (or `npx tsc --noEmit`). The tests cover the consolidated TUI, memory, config, and sandbox modules.

Quality checks are available through `npm run lint`, `npm run format:check`, and `npm run knip`; `npm run check` runs typechecking, linting, formatting, tests, and Knip together. ESLint uses the flat config in `eslint.config.mjs`, with cyclomatic and cognitive complexity currently reported as warnings. The repository currently has pre-existing lint, formatting, and Knip findings; do not treat those baseline findings as regressions without comparing changes.

Use `./scripts/cognitive_load_report.py` for a detailed complexity overview. It runs ESLint once, tolerates unrelated lint errors, reports both complexity rules plus a function-size and nesting tree, groups findings by file/subsystem, and supports `--target`, `--top`, `--format json`, `--input`, `--min-function-lines`, `--big-function-lines`, `--child-function-lines`, `--no-structure`, and threshold options. The size pass injects `max-lines-per-function` through `--rule` in the same ESLint run, nests reported spans, and separates a function's own lines from its children's; rank by self lines to find undecomposed bodies, and by span with a high nested count to find behavior assembled across callbacks. `--input` skips the size pass unless that saved report already contains the rule. Keep those two floors distinct: ESLint's rule threshold is the _measurement_ floor (`INVENTORY_FUNCTION_LINES`) and must stay low, because a function that is never reported cannot be subtracted from its parent's self count, so raising it makes a function that already delegates read as one undecomposed body; `--min-function-lines` is only the _display_ floor and defaults to two thirds of `--big-function-lines`.

Use `./scripts/coverage_report.py <source-glob> --tests <files...>` to see which paths a suite never reaches before refactoring, since coverage percentages alone hide that. It runs `vitest run --coverage` scoped to the targets (or analyzes an existing `coverage-final.json` with `--input`) and lists each uncovered branch _path_ with its own source line, plus uncovered statements and functions, and supports `--top`, `--format json`, and `--fail-on gaps|thin --min-branches`. Narrow `--tests` deliberately: Vitest instruments only what the selected tests load, so untargeted files report as never loaded.

For a manual permission-prompt check, run `cat /etc/hostname`; without a matching rule it should prompt with `ask`. Verify the `selectWithMessage` UI, long-command wrapping and scrolling, Tab edit mode, bracketed clipboard paste, wrapped feedback, and Enter/Escape behavior.

Database-backed agent tests must use an explicit temporary state/workspaces directory; integration tests that only exercise agent action presentation should mock catalog access rather than allowing the default `.state/meta.sqlite` path. The project-local `.state/` directory is runtime state and must not be mutated by the test suite. Shared workspace lifecycle E2E tests live under `test/tools/e2e/` and should use its `createE2EPaths`, `createE2EContext`, `withE2EMetadataDatabase`, and `createScriptedChild` helpers so temporary SQLite, context defaults, cleanup, and child handles remain consistent.

TUI widget tests must assert distinct projected **states**, not a trace of render frames. The background-flow recorder in `test/tools/agent-tool.test.ts` dedupes consecutive identical frames before `toMatchFileSnapshot`, because the widget requests a render on every status event, so a raw frame trace snapshots how many microtask boundaries a flow contains and a transient state (`Starting:`) can coalesce into the next frame. Keep that recorder dedupe when adding widget coverage, and prefer `vi.waitFor` over fixed flush counts for background-settling assertions.

When proving a test actually detects a regression, mutate the source and confirm the test fails—and assert the mutation applied. An exact string replace silently becomes a no-op when formatting differs (Prettier re-wraps long boolean expressions), which reads as “the tests caught nothing” and can also leave the tree mutated: restore from a saved copy, not by re-running the reverse replacement. Verify the mutation was actually written before running the suite, because re-testing an untouched file looks identical to an undetected regression.

When an applied mutation genuinely produces no failures, diagnose the clause before adding tests: it is often already redundant, because a helper enforces part of the condition. That is what happened with `finite(value) && value < 0` in `runs/persistence/stored-record.ts`, where `finite` also rejected negatives. Fix the naming rather than doubling down—the helper is now `nonNegativeNumber`, whose name carries the whole contract—then pin the boundary with a case per direction (negative timestamps and a negative failed-tool count in `test/tools/agent-run-snapshot-shape.test.ts`) so a future relaxation of the helper is caught at the call sites that matter. Second, check whether the mutant is _equivalent_ before writing a test for it: `previous.order <= entry.order` and `< entry.order` in `runs/persistence/load.ts` cannot disagree, because markers arrive in ascending transcript order, so only the newest can win either way; reversing the comparison to `>=` is caught by the existing branch-checkpoint test. Prove equivalence by mutating in the direction that must fail before concluding a behavior is unguarded.

Agent definition tests copy real `.md` fixtures from `test/tools/fixtures/agent-definitions/` into a temporary scope via `copyFixtures`, rather than inlining frontmatter strings: the loader's contract is about the files it reads, so sort order picks the duplicate that wins and each diagnostic reports the offending path. Keep new malformed-field cases as one fixture per guard and assert message plus paths together, which is what pins guard order. Reuse the fixture directories already next to a suite (`agent-transcripts/`, `agent-definitions/`) and resolve them with `fileURLToPath(new URL(..., import.meta.url))`.

Loader tests must build records with the real `parent.getSessionId()`. `validateAgentRunSnapshot` compares the stored owner against the session's id, so a fixture owner (the `"parent-1"` used by the fake `context()` in `test/tools/agent-persistence.test.ts`) is rejected, and the only symptom is the generic “parent marker and SQLite snapshot identity do not match” diagnostic, which looks like a validator defect. Instrument `listAgentRunSnapshotsInDatabase` plus `validateAgentRunSnapshot` directly before chasing such a message: a real `SessionManager.create` used as `sessionManager` supplies `getEntries`/`appendCustomEntry`, so `hasEntryIndex` is true and the marker/expectation paths behave as in production.

Parser benchmarks:

- `npm run bench` runs `test/modules/sandbox/bash.bench.ts`, measuring `parseBashAst()` across simple, medium, and high-complexity command corpora. Benchmarks are separate from `npm run test:run`.
- Benchmark output is machine-specific and intended as a future AST-parser performance baseline, not a hard threshold.

Relevant test locations:

- `test/ask-user.test.ts`, `test/select-with-message.test.ts`, and `test/inline-editor.test.ts` for TUI editing.
- `test/modules/memory/` for frontmatter parsing, memory scanning, and list formatting.
- `test/common/config.test.ts` and `test/modules/sandbox/` for sandbox behavior, heuristics, permissions, resolution, suggestions, bubblewrap, fuzzing, and bash parsing.
