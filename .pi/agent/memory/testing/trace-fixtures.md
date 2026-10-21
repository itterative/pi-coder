---
name: trace-fixtures
description: Read recorded trace and decision-log fixtures through their JSONL reader, filter by session, never at live .state/ or home paths.
category: workflow
---

# Recorded-log fixtures

**Read a recorded log through its reader, and scope it to the subject.** A trace or decision-log fixture goes
through `createJsonlRecordLog` + `discoverGenerations` — `test/helpers/compaction-trace.ts` wraps this for the
compaction trace, and `scripts/*-report.ts` share the same reader — never `readFileSync().split("\n")`.

## The hazards a hand-rolled read buys you

- **Rotation.** A hand-rolled read sees only the live segment, so a rotated fixture silently loses its oldest
  runs.
- **Torn lines.** One torn line throws instead of counting a gap.
- **Cross-session ids.** Filter by the session the paired fixture names: `.state/compaction-trace.jsonl` holds
  every session of a checkout, and an unfiltered read matches one session's ids against another's records.

## Fixture policy

- **Never point a suite at `.state/` or a home-directory path.** Commit the pair (fixture plus the session it
  names) to the repo instead.
- **Keep a few foreign-session rows in the trace fixture**, so the filter is a tested property rather than an
  assumption.

Related: the trace and compaction doubles (`loadCapture`, `openTraceLog`, `sessionIdOf`, `fixturePath`, and
the rest) are catalogued in `../test-doubles/decision-and-trace-doubles.md`; the writer's own semantics are in
the `compaction` memory and, for the bash decision log, `../sandbox/decision-log.md`.
