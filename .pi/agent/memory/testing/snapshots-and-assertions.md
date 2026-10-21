---
name: snapshots-and-assertions
description: One inline snapshot per model-facing sentence, file snapshots for distinct rendered states, normalization of ambient noise, and no wiring assertions.
category: workflow
keep_updated: true
---

# Snapshots and assertions

## Model-facing sentences get one inline snapshot per case, not a snapshot plus a literal

`expect(reason).toMatchInlineSnapshot(...)` rewrites in place under `-u` and shows a wording change as a prose
diff; asserting the same sentence again with `toBe`/`toContain` keeps a second copy that has to be hand-edited
on every rewording (that duplication, not the wording, is what made three revisions into six edit loops). TUI
frames and grouped rendered text keep `snapshotText(...)` + `toMatchFileSnapshot(...)`.

**Where the branch a sentence names is unreachable through configuration today** (an applied `refuse`), mock the
one function that produces the input — `vi.mock("../../src/tools/decision-model")` over `consultForGate`,
leaving the other exports real — so the gate's own reasoning stays under test; see
`test/tools/agent-child-applied-deny.test.ts`.

## Rendered text for a model or user: one sectioned file snapshot per group

For text a module renders for a model or user to read (agent list rows, outcome envelopes, transcripts),
characterize with one sectioned file snapshot per group instead of fragment `toContain` assertions: join
`### case` blocks, normalize the clock out through a `stableDetails`-style helper, and write the file with
`snapshotText(...)` plus `toMatchFileSnapshot("__snapshots__/...")`. Generate it from the pre-change code so it
pins reality rather than aspiration.

**The measured difference:** in `presentation/outcomes.ts` the seven existing fragment tests caught 3 of 13
mutations; the snapshot suite caught 15 of 15 and exposed two real inconsistencies in the same pass.

## Rendering: distinct states via file snapshots, not a frame trace

- **Assert distinct projected states.** TUI widget tests must assert distinct projected **states**, not a trace
  of render frames — `snapshotText(...)` + `toMatchFileSnapshot(...)`, plus direct state or interaction
  assertions.
- **Keep the recorder's frame dedupe.** The background-flow recorder in `test/tools/agent-tool.test.ts` dedupes
  consecutive identical frames before `toMatchFileSnapshot`, because the widget requests a render on every status
  event: a raw frame trace snapshots how many microtask boundaries a flow contains, and a transient state
  (`Starting:`) can coalesce into the next frame. Keep that recorder dedupe when adding widget coverage.
- **Prefer `vi.waitFor` over fixed flush counts** for background-settling assertions.

## Keep ambient noise out of every snapshot

Keep clocks, the per-run temp directory, temp dirs, repo paths, the home directory, and sandbox argument lists
normalized out of snapshots — a sandboxed command reads as `sandbox(<inner command>)`. And send `tool_result`
only for calls that were allowed, otherwise the snapshot claims edits that never happened.

## Assert a behavior, not a wiring detail

A test that restates a literal (`expect(x.hardcodedField).toBe("same")`) catches nothing; test a double's
ordering and failure contracts, not its field copying.

Related: TUI driving helpers are in `../test-doubles/tui-e2e.md`; [`typecheck-and-format.md`](typecheck-and-format.md)
explains the `TypeError: cloneUsage is not a function` symptom.
