# pi-coder

- The extension entrypoint is `src/index.ts`; register new modules there.
- Run `npm run test:run` for the full suite and `npx tsc --noEmit` for type checking. To run a focused suite, use `npx vitest run <test-file>`.
- Tests do not make provider calls. For agent lifecycle, provider, or rendering changes, follow the manual checklist in `src/tools/agent/README.md`.
- Linux sandbox and worker behavior requires the `bwrap` executable. Sandbox config is project-local at `.pi/bash-sandbox-config.json` or global at `~/.pi/bash-sandbox-config.json`; `SANDBOX_CONFIG_PATH` and `SANDBOX_CONFIG_PATH_GLOBAL` can override those locations.
- npm uses `.npmrc` with `ignore-scripts=true` and a 7-day package release age policy; do not bypass these casually.
- Preserve the agent capability split: `scout` is read-only, while only one `worker` may mutate at a time through the shared permission/sandbox hooks.
- Extend the shared TUI components in `src/tui/list-view.ts` and `src/tui/inline-editor.ts` rather than duplicating their behavior.
- `.state/` contains private runtime state and is not source code.
