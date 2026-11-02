---
name: testing
description: Local validation commands and the highest-value test-writing rules for pi-coder, plus where each testing detail doc lives.
category: workflow
priority: 1
---

# Testing pi-coder

The tests cover the consolidated TUI, memory, config, and sandbox modules. Commands an agent runs every day:

- `npm run test:run` — the full suite. `npx vitest run <test-file>` — a focused suite.
- `npx tsc --noEmit` (or `npm run typecheck`) — types for `src/` **only**; `tsconfig.json` excludes `test/`, so a
  green run says nothing about the test tree. Use `npm run typecheck:tests` for `src` + `test`.
- `npm run scratch -- <script> [args...]` — bundle and run one throwaway TS script from anywhere.
- `npm run check` — the whole chain (typecheck, typecheck:tests, `eslint .`, `prettier --check .`, `test:run`,
  `knip`). `knip` is not a gate yet: it exits 1 on ~156 pre-existing unused exports across untouched TUI/agent
  files, so treat its list as advisory and keep the four steps before it green.

## Checklist before adding or changing a test

The five rules most often gotten wrong; the rest are in the detail docs below.

- **Reuse a shared double before writing one** — see `test-doubles.md` for which helper; never a hand-built
  `as any` literal.
- **Add no new `no-explicit-any`** and leave `npx eslint test/<file>` clean on files you touched.
- **TUI rendering: assert distinct projected states** via `snapshotText(...)` + `toMatchFileSnapshot(...)`, plus
  direct state or interaction assertions.
- **Never write the developer's home or `.state/` state from a suite** — use explicit temporary state/workspaces
  dirs.
- **Never read the developer's setup either.** Three ambient inputs have made the suite pass only on one machine:
  the global sandbox config (`config.load` merges `~/.pi/bash-sandbox-config.json` and falls back to
  `defaultConfig()`, whose `inheritEnv: {}` is what emits `--clearenv`), the process environment
  (`PI_SANDBOX_BACKEND` decides whether prompts show `sandbox(...)`), and installed binaries (`bwrap`). Pin the
  config path with `vi.stubEnv("SANDBOX_CONFIG_PATH_GLOBAL", <temp file>)`, pin the backend once for the whole
  suite (`process.env.PI_SANDBOX_BACKEND = "bwrap"` in `test/setup.ts`, so running the suite inside the container
  still exercises bwrap wrapping), and guard a genuinely bwrap-driven
  test with `it.skipIf(!hasBwrap())` from `test/helpers/host-tools.ts`. Skipped is visible; red is misleading.
  The pi-coder sandbox image bakes `bubblewrap` in, so those guards do not fire there and the whole suite runs
  inside the container (3171 tests); on an image without it they skip instead of failing.
- **The container backend is testable without podman**, which matters because the suite runs *inside* the
  sandbox image where podman is unreachable. Three techniques cover it: (1) drive `dispatch.mjs` as a child
  process and speak its NDJSON protocol (`test/modules/sandbox-container-dispatch.test.ts`) — it is plain JS on
  purpose; (2) a session double that implements `fs`/`spawn` over the local filesystem, which is legitimate
  because the checkout is bind-mounted at its real path, so the host is a faithful stand-in for the container
  (`grep-tool.test.ts`); (3) run pi's own tool definition beside the container one over the same tree and
  compare output — a parity oracle for reimplemented behaviour, which is how `grep`'s deliberate duplication is
  guarded. `rg`'s parallel walk makes match order nondeterministic, so parity cases compare sorted lines unless
  they are scoped to a single file.
- **Run the touched suite even when typechecking passes.**

Manual agent/provider/rendering validation is documented in `src/tools/agent/README.md`; the permission-prompt and
`selectWithMessage` checks are in `testing/manual-checks.md`.

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory
index.

- `testing/doubles-and-any.md` — double reuse, the 28-duplicate/199-`any` history, the zero baseline, eslint.
- `testing/trace-fixtures.md` — reading recorded traces/decision logs through `createJsonlRecordLog`, rotation and
  torn-line hazards, session filtering, no live `.state/` reads.
- `testing/state-isolation.md` — `test/setup.ts` env pins, the decision-log/compaction-trace escape hatches,
  temporary state and workspaces dirs.
- `testing/decision-gates.md` — the two keys needed to reach a decision-model gate from a fixture.
- `testing/snapshots-and-assertions.md` — inline vs file snapshots, `vi.mock` for unreachable branches,
  normalization, behavior over wiring details.
- `testing/typecheck-and-format.md` — the `test/` typecheck hole, the single-file probe, running the touched
  suite, verifying code handed to a child, Prettier on explicit paths.
- `testing/mutation-proofs.md` — mutation testing, redundant/equivalent mutants, differential restructure proofs.
- `testing/child-grant-fixtures.md` — real grants over option bags, impossible-child fixtures, distinct-case
  snapshots.
- `testing/fixtures-and-loaders.md` — copied `.md` definition fixtures, real `parent.getSessionId()`, hangs in
  synchronous code.
- `testing/scripts-and-measurement.md` — lint/format/knip baseline caveat, `cognitive_load_report.py`,
  `coverage_report.py`, `npm run bench`.
- `testing/scratch-scripts.md` — import resolution, `cwd`, and temp-bundle semantics of `npm run scratch`.
- `testing/manual-checks.md` — permission-prompt and `selectWithMessage` checks by hand.
- `testing/test-map.md` — which suite covers what.

Related: `test-doubles.md` (which helper to use), `patch-hygiene` (scripted edits must assert before writing).
