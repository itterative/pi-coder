---
name: tui-e2e
description: test/helpers.ts TUI driving and stubTui, the e2e temp-dir/SQLite/git scaffolding, child-run-fixture, and bundleScript for CLI-driven suites.
category: workflow
keep_updated: true
---

# TUI driving, e2e scaffolding, and script bundles

## Driving a TUI component — `test/helpers.ts`

`KEY`, `mockTheme`, `press`, `type`, `paste`, `interact`, `renderText`, `snapshotText` — not inline ANSI
sequences or hand-rolled key strings.

- **`interact()` binds `component.handleInput` once** and throws a named error when a component implements none,
  because pi types that member optional and `?.()` would silently drop keystrokes from a TUI flow.
- **`snapshotText(...)`** is the frame builder for the file-snapshot policy
  (`toMatchFileSnapshot(...)`): see `../testing/snapshots-and-assertions.md`.
- **A widget's or dialog's terminal environment** → `stubTui(overrides)` / `FocusAwareTui` — not
  `{ requestRender() {} } as any` and not `as unknown as TUI`.

## Agent lifecycle scaffolding — `test/tools/e2e/helpers.ts`

Temp dirs, SQLite, and git repos for agent lifecycle: `createE2EPaths`, `withE2EMetadataDatabase`,
`createScriptedChild`, `insertE2EAgentRun`, `createClaimedTaskWorkspace`, `initializeRepository` — not ad-hoc
`mkdtemp` plus open-by-hand.

**Shared workspace lifecycle suites should use `createE2EPaths`, `createE2EContext`, `withE2EMetadataDatabase`,
and `createScriptedChild`** so temporary SQLite, context defaults, cleanup, and child handles remain consistent.

- `createE2EContext(paths, overrides)` returns a typed `AgentStartContext` and deliberately carries **no** `ui`
  (the start context has no such member; the child reaches the parent UI through `parentContext`).
- `loadE2EPersistence` builds a real `ExtensionContext` via `stubSessionContext`.
- So: a checked **parent** context is `stubContext`/`stubSessionContext`, while an **e2e run** context is
  `createE2EContext`.

## A child wired the way production wires it — `test/tools/child-run-fixture.ts`

`buildChildRun` and `probeDefinition` — not a hand-built grant or option bag, and not a suite-local decision
config.

- **`mode.decision`** arms a decision model the way a configured session has one: it writes a real
  `.pi/decision-model-config.json`, installs a registry answering every classification with one
  criterion/confidence, and sets `apply: true` with the `child` surface on.
- The fixture exposes `classifyCalls()`, `notifications`, and a recording `parentContext.ui`.
- Why the fixture rather than an option bag, and what its snapshots must normalize:
  `../testing/child-grant-fixtures.md` and `../testing/decision-gates.md`.

## Driving a TypeScript script as a real CLI — `test/helpers/script-bundle.ts`

`bundleScript(entry)` → `{ bundle, run, dispose }` for argv, exit codes, and stdout: bundle once in `beforeAll`,
`dispose()` in `afterAll`. Not spawning `node --import tsx <script>` per test call — that costs ~130ms each (node
start plus the tsx loader), and the bundle drops each spawn to ~30ms.

Related: `../testing/scratch-scripts.md` for the repo's throwaway-script runner (`npm run scratch`).
