# pi-coder

pi-coder is a pi extension providing coding-oriented memory, sandbox, TUI, and delegated-agent tools.

## Workflow

- Read relevant memories before exploring or implementing changes, and use them to guide the work.
- Resolve relative paths mentioned in project documentation from the project root, not from the location of the document that mentions them.
- Give a thorough plan before making changes unless the user has directly requested the specific change.
- After making requested changes, review and update relevant project memories.
- Ask clarifying questions when requirements or tradeoffs are unclear.

## Code styleguide

- Prefer guard clauses to reduce nesting. Always use braces, including for guard clauses and other single-statement control-flow bodies.
- Avoid nested ternary expressions. Replace complex conditional expressions with guard clauses, explicit branches, or named intermediate values.
- Separate logical phases within a function with blank lines, especially validation, state updates, side effects, and result construction.
- Keep functions focused on one responsibility. Extract helpers when a function handles multiple action paths or lifecycle concerns.
- Break up long signatures, callbacks, boolean conditions, and template expressions when they become difficult to scan.

## Development

- Run `npm run test:run` for the full suite and `npx tsc --noEmit` for type checking. To run a focused suite, use `npx vitest run <test-file>`.
- Tests do not make provider calls. For agent lifecycle, provider, or rendering changes, follow the manual checklist in `src/tools/agent/README.md`.
- Child prompt design guidelines are documented in `src/tools/agent/README.md` under **Child prompt design**; read them before changing child protocols, capability wording, or prompt snapshots.
- TUI rendering tests must use file snapshots via `snapshotText(...)` and `toMatchFileSnapshot(...)`; update snapshots deliberately when rendering changes. Use direct assertions for state or interaction outcomes in addition to, not instead of, rendering snapshots.
- Linux sandbox and worker behavior requires the `bwrap` executable. Sandbox config is project-local at `.pi/bash-sandbox-config.json` or global at `~/.pi/bash-sandbox-config.json`; `SANDBOX_CONFIG_PATH` and `SANDBOX_CONFIG_PATH_GLOBAL` can override those locations.
- npm uses `.npmrc` with `ignore-scripts=true` and a 7-day package release age policy; do not bypass these casually.
- `.state/` contains private runtime state and is not source code.

## Architecture

- The extension entrypoint is `src/index.ts`; register new modules there.
- Preserve the agent capability split: `scout` is read-only and only the built-in `worker` may mutate. Same-checkout workers are single-flight; isolated `worker` runs in distinct worktrees may mutate concurrently, with shared permission dialogs still serialized.
- Extend the shared TUI components in `src/tui/list-view.ts` and `src/tui/inline-editor.ts` rather than duplicating their behavior.
