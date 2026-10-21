---
name: scripts-and-measurement
description: npm run lint/format:check/knip/check, the baseline-findings caveat, the cognitive-load and coverage report scripts, and parser benchmarks.
category: workflow
---

# Quality scripts, measurement reports, and benchmarks

## Repo quality checks

Quality checks are available through `npm run lint`, `npm run format:check`, and `npm run knip`; `npm run check`
runs typechecking, linting, formatting, tests, and Knip together. ESLint uses the flat config in
`eslint.config.mjs`, with cyclomatic and cognitive complexity currently reported as warnings.

**The repository currently has pre-existing lint, formatting, and Knip findings**; do not treat those baseline
findings as regressions without comparing changes.

## `./scripts/cognitive_load_report.py` — detailed complexity overview

It runs ESLint once, tolerates unrelated lint errors, reports both complexity rules plus a function-size and
nesting tree, groups findings by file/subsystem, and supports `--target`, `--top`, `--format json`, `--input`,
`--min-function-lines`, `--big-function-lines`, `--child-function-lines`, `--no-structure`, and threshold options.

The size pass injects `max-lines-per-function` through `--rule` in the same ESLint run, nests reported spans, and
separates a function's own lines from its children's; rank by self lines to find undecomposed bodies, and by span
with a high nested count to find behavior assembled across callbacks. `--input` skips the size pass unless that
saved report already contains the rule.

**Keep those two floors distinct:** ESLint's rule threshold is the _measurement_ floor
(`INVENTORY_FUNCTION_LINES`) and must stay low, because a function that is never reported cannot be subtracted
from its parent's self count, so raising it makes a function that already delegates read as one undecomposed
body; `--min-function-lines` is only the _display_ floor and defaults to two thirds of `--big-function-lines`.

## `./scripts/coverage_report.py` — which paths a suite never reaches

`./scripts/coverage_report.py <source-glob> --tests <files...>` shows which paths a suite never reaches before
refactoring, since coverage percentages alone hide that. It runs `vitest run --coverage` scoped to the targets (or
analyzes an existing `coverage-final.json` with `--input`) and lists each uncovered branch _path_ with its own
source line, plus uncovered statements and functions, and supports `--top`, `--format json`, and
`--fail-on gaps|thin --min-branches`.

**Narrow `--tests` deliberately:** Vitest instruments only what the selected tests load, so untargeted files
report as never loaded.

## Parser benchmarks

- `npm run bench` runs `test/modules/sandbox/bash.bench.ts`, measuring `parseBashAst()` across simple, medium, and
  high-complexity command corpora. Benchmarks are separate from `npm run test:run`.
- Benchmark output is machine-specific and intended as a future AST-parser performance baseline, not a hard
  threshold.

Related: complexity hotspots themselves are the `complexity-hotspots` memory (`../complexity-hotspots.md`).
