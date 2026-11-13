---
name: state-isolation
description: test/setup.ts pins the best-effort global logs off; suites use temporary state/workspaces dirs and never mutate the pi-coder state root, the developer's home, or the SDK credential store.
category: workflow
---

# Keeping suite state out of the developer's machine

**State stays out of the repo:** explicit temporary state/workspaces directories, and never mutate pi-coder's real
state root (`<agent-dir>/pi-coder`, `PI_CODER_STATE_DIR` overrides it).

## Never write the developer's home state from a suite

`test/setup.ts` (vitest `setupFiles`) pins the best-effort global writers off:

- `PI_CODER_ENV_FILE ??= "0"`, so a developer's checkout `.env` (which may pin the state root) cannot change
  what a suite asserts. Tests that exercise the file call `applyDevEnvFile` with their own temporary path.
  Turning the file off does not undo a load that already happened: under pi, the extension applied the
  checkout `.env` to `process.env` before the suite started, so `PI_CODER_STATE_DIR` arrives as an absolute
  `.state` path. `test/setup.ts` therefore blanks it unconditionally (blank means unset to the resolver);
  without that the default-root assertions pass outside pi and fail inside it.

- `SANDBOX_DECISION_LOG ??= "0"`, so the bash decision log is off for every suite unless a file re-enables it
  with `vi.stubEnv("SANDBOX_DECISION_LOG", "1")` plus a temporary `SANDBOX_DECISION_LOG_PATH` (or a
  `decisionLog.path` in a temporary project config).
- `COMPACTION_TRACE ??= "0"` is set there for the same reason and with the same escape hatch
  (`vi.stubEnv("COMPACTION_TRACE", "1")` plus a temporary `COMPACTION_TRACE_PATH`); its records hold raw
  summary text.
- **Follow the same pattern for any future best-effort global log:** pin it off in `test/setup.ts`, and give a
  suite an explicit env-var escape hatch pointing at its own temporary path.

## The SDK writes its credential store under `~/.pi/agent`

A suite that constructs a real `ModelRuntime` or `createAgentSession` must not inherit the developer's agent
directory. `ModelRuntime.create()` creates `$HOME/.pi/agent`, locks `auth.json`, and refreshes
`models-store.json`; `createChildModelRuntime()` may copy the parent API key into the same store. Under an
unwritable or missing `$HOME` — what a container frequently has — the SDK throws
`ModelsError: Credential store read failed for <provider>: EACCES: permission denied, mkdir '.../.pi/agent'`, so
unrelated assertions fail for an environment reason. `test/tools/agent-sdk-smoke.test.ts` demonstrates the fix:
`fs.mkdtempSync` a throwaway directory, seed it with copies of the real `auth.json` / `models.json` when they are
readable (so a conditional OAuth case still exercises a persisted credential), set `process.env.PI_CODING_AGENT_DIR`
to it at module scope, and `fs.rmSync` it in `afterAll`. `getAgentDir()` reads that variable at call time, so the
module-body assignment is early enough for everything built inside the tests, though not for constants
(`PI_CODER_STATE_DIR`) resolved at import.

## Database-backed agent tests

- Database-backed agent tests must use an explicit temporary state/workspaces directory.
- Integration tests that only exercise agent action presentation should **mock catalog access** rather than
  allowing the default `<agent-dir>/pi-coder/meta.sqlite` path.
- The pi-coder state root is runtime state and must not be mutated by the test suite; the legacy in-checkout
  `.state/` directory, when it still exists, is equally off limits.

Related: the e2e scaffolding that provides those directories (`createE2EPaths`, `withE2EMetadataDatabase`) is
in `../test-doubles/tui-e2e.md`; reading a recorded log from a fixture is
[`trace-fixtures.md`](trace-fixtures.md). A fresh or unwritable `$HOME` also breaks two suites that assume a
developer machine — the TUI footer snapshot shortens the checkout to `~/Repos/...` using `os.homedir()`, and
`file-permissions` reads user memories under it — so a container run still shows those two red.
