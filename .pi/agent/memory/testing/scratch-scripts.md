---
name: scratch-scripts
description: npm run scratch bundles and runs one throwaway TS script from anywhere, with import resolution, cwd semantics, and temp-dir bundle details.
category: workflow
---

# Scratch scripts

`npm run scratch -- <script> [args...]` bundles and runs one throwaway TS script from anywhere.

## Import resolution

- `./x` for sibling files.
- `@pi-coder/...` for pi-coder source (`src/`, `test/`).
- `@earendil-works/...` for the pi package (left external).
- Any package installed in the repo's `node_modules` (bundled via `nodePaths`), and a `node_modules` next to the
  script itself.
- `node:*` builtins.

## Where the child runs

The child runs with `cwd` set to the script's own directory, so relative file paths (`readFileSync("./data.json")`)
resolve next to the script, like relative imports do.

## Where the bundle lives

The bundle lives in a temp dir under the OS temp dir (removed on exit, stale dirs swept); details in the doc
comment of `scripts/scratch.ts`.

Related: driving a bundled script as a real CLI from inside a suite (`bundleScript`) is
`../test-doubles/tui-e2e.md`.
