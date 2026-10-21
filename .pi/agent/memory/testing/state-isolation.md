---
name: state-isolation
description: test/setup.ts pins the best-effort global logs off; suites use temporary state/workspaces dirs and never mutate .state/ or home state.
category: workflow
---

# Keeping suite state out of the developer's machine

**State stays out of the repo:** explicit temporary state/workspaces directories, and never mutate `.state/`.

## Never write the developer's home state from a suite

`test/setup.ts` (vitest `setupFiles`) pins the best-effort global writers off:

- `SANDBOX_DECISION_LOG ??= "0"`, so the bash decision log is off for every suite unless a file re-enables it
  with `vi.stubEnv("SANDBOX_DECISION_LOG", "1")` plus a temporary `SANDBOX_DECISION_LOG_PATH` (or a
  `decisionLog.path` in a temporary project config).
- `COMPACTION_TRACE ??= "0"` is set there for the same reason and with the same escape hatch
  (`vi.stubEnv("COMPACTION_TRACE", "1")` plus a temporary `COMPACTION_TRACE_PATH`); its records hold raw
  summary text.
- **Follow the same pattern for any future best-effort global log:** pin it off in `test/setup.ts`, and give a
  suite an explicit env-var escape hatch pointing at its own temporary path.

## Database-backed agent tests

- Database-backed agent tests must use an explicit temporary state/workspaces directory.
- Integration tests that only exercise agent action presentation should **mock catalog access** rather than
  allowing the default `.state/meta.sqlite` path.
- The project-local `.state/` directory is runtime state and must not be mutated by the test suite.

Related: the e2e scaffolding that provides those directories (`createE2EPaths`, `withE2EMetadataDatabase`) is
in `../test-doubles/tui-e2e.md`; reading a recorded log from a fixture is
[`trace-fixtures.md`](trace-fixtures.md).
