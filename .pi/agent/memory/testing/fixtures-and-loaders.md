---
name: fixtures-and-loaders
description: Copy real .md fixtures for loader tests, build records with the real parent.getSessionId(), and diagnose a suite that hangs in synchronous code.
category: workflow
---

# Loader fixtures, session identity, and fixture-path hazards

## Agent definition tests copy real files

Agent definition tests copy real `.md` fixtures from `test/tools/fixtures/agent-definitions/` into a temporary
scope via `copyFixtures`, rather than inlining frontmatter strings: the loader's contract is about the files it
reads, so sort order picks the duplicate that wins and each diagnostic reports the offending path.

- **Keep new malformed-field cases as one fixture per guard** and assert message plus paths together, which is
  what pins guard order.
- **Reuse the fixture directories already next to a suite** (`agent-transcripts/`, `agent-definitions/`) and
  resolve them with `fileURLToPath(new URL(..., import.meta.url))`.

## Loader tests must build records with the real `parent.getSessionId()`

`validateAgentRunSnapshot` compares the stored owner against the session's id, so a fixture owner (the
`"parent-1"` used by the fake `context()` in `test/tools/agent-persistence.test.ts`) is rejected, and the only
symptom is the generic "parent marker and SQLite snapshot identity do not match" diagnostic, which looks like a
validator defect.

**Instrument `listAgentRunSnapshotsInDatabase` plus `validateAgentRunSnapshot` directly** before chasing such a
message: a real `SessionManager.create` used as `sessionManager` supplies `getEntries`/`appendCustomEntry`, so
`hasEntryIndex` is true and the marker/expectation paths behave as in production.

## A suite that prints nothing is hung in synchronous code

A suite that prints nothing after the `RUN` header is hung inside **synchronous** code, not failing an assertion:
`testTimeout` and `hookTimeout` cannot interrupt a blocked sync call, so the worker stalls with no output at all.
Diagnose by filtering one test at a time (`-t "<name>"` under `timeout`) to find the offending case. The cause
here was a "must fail fast" fixture path under `/proc`, where `fs.mkdirSync(recursive)` blocks; use a path that
fails immediately instead, such as a regular file where a parent directory is required (`ENOTDIR`).
