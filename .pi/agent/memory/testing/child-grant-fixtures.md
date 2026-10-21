---
name: child-grant-fixtures
description: Child suites resolve a real grant through resolveChildGrant, not an option bag, and a snapshot claiming a distinct case must differ.
category: workflow
---

# Child-side fixtures: a real grant, not an option bag

**Child-side tests build a real grant instead of an internal option bag:** `test/tools/child-run-fixture.ts`
resolves through `resolveChildGrant` and installs the child extension against a recording `pi`, so a fixture
cannot drift from what `createAgentChild` does.

**Two suites replace the old hand-written bags:** `agent-child-gates.test.ts` pins the ordered registration
record per profile (which gates a child arms, and that `ask_user` appears only when the parent can host it), and
`agent-child-decisions.test.ts` snapshots the allow/block truth table with its reasons plus the tracked change
sets. Keep path- and machine-specific noise out of those snapshots — see
[`snapshots-and-assertions.md`](snapshots-and-assertions.md) for the normalization list and the
send-`tool_result`-only-for-allowed-calls rule.

**When a behavior test needs a note recorded before a side effect, drive the callback directly** rather than
through a real extension.

## A hand-written option bag can pass while describing a child that cannot exist

The per-built-in prompt snapshots passed `additionalPaths: []`, so they omitted the
`", or configured additional paths"` clause that memory-capable agents really get, and the worker cases hid that
by not using the read scope. Snapshot wording changed only after the fixtures resolved for real, which is the
point. When converting such tests, expect to review the diff per agent and confirm the substance is unchanged.

## A snapshot that claims a _distinct_ case has to differ

When a test claims to pin a **distinct** case, compare its snapshot against the nearest sibling (`cmp`):
`agent-prompt.scout-background.system.txt` was byte-identical to the scout file because the prompt never read
`background` at all, so the case pinned nothing. Replace that pattern with an equality assertion that states the
real invariant.

Related: the child fixture's API surface (`buildChildRun`, `probeDefinition`, `mode.decision`) is catalogued in
`../test-doubles/tui-e2e.md`; reaching a decision gate from such a fixture is
[`decision-gates.md`](decision-gates.md).
