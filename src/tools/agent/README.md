# Agent tool

`pi-coder` provides an in-process `agent` tool for delegated exploration and permission-gated implementation.

## Quick reference

```text
agent(action="list")
agent(action="start", agent="scout", task="Investigate ...")
agent(action="start", agent="worker", isolation="worktree", background=true, task="Implement ...")
agent(action="status", runId="worker-1")
agent(action="collect", runId="worker-1")
agent(action="continue", runId="worker-1", guidance="...")
agent(action="cancel", runId="worker-1")
agent(action="inspect", runId="worker-1")
agent(action="apply", runId="worker-1")
agent(action="discard", runId="worker-1")
agent(action="continue", runId="worker-1", guidance="...")
```

- `start` runs a child in the foreground by default; set `background=true` for asynchronous execution. While a foreground `start` or `continue` is running in the TUI, press Ctrl+Alt+B to move it to the background. Background results explain how to collect the eventual result.
- `scout` is read-only, `reviewer` can run permission-gated commands, and only the built-in `worker` can edit.
- Background `start` returns immediately. Collect terminal background results explicitly; do not poll or sleep while waiting.
- Isolated workers use persistent Git worktrees. Changed results remain outside the parent checkout until an explicit `apply`.
- `/agents` browses delegated runs and isolated workspaces.

## Continue at a glance

`continue` resumes a waiting or interrupted child, or continues a collected terminal child run in the existing child conversation. Waiting and interrupted runs use their existing live or restored handle; collected runs reopen the persisted child session and exact transcript leaf. For an isolated collected run, it keeps the same workspace; for a non-mutating run such as `reviewer`, it reuses the original execution cwd without a workspace. Resolution is restricted to the exact parent session and active parent-tree branch. It uses the persisted definition snapshot (including capabilities and role prompt), preserves the recorded model, and sends the supplied guidance as the next prompt. A current definition fingerprint mismatch is informational; snapshots without the definition contract fail clearly. It keeps the same public run ID; continue using that ID for later actions.

Before continuing a collected isolated run, the worktree `HEAD` must descend from the recorded workspace base. Divergent history is rejected without starting the child or changing the existing result. The existing workspace lease remains held throughout continuation and finalization; failures preserve it for explicit recovery.

## More documentation

- [Agent tool reference](docs/agent-tool.md) — actions, child roles, capabilities and gates, safety boundaries, prompt design, and diagnostics.
- [Workspace lifecycle](docs/agent-workspaces.md) — isolated worktrees, result disposition, leases, and the continuation flow chart.
- [Persistence and recovery](docs/agent-persistence.md) — child transcripts, snapshots, restoration, and restart behavior.
- [Manual workspace validation](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md) — disposable-repository lifecycle checklist.
- [Manual snapshot GC validation](src/tools/agent/SNAPSHOT-GC-MANUAL-VALIDATION.md) — checkpoint-vs-frame counts, `kill -9` restore at the working leaf, resume-without-replay, and the kill-switch equivalence run.
- [Implementation plan](src/tools/agent/PLAN.md) — architecture and deferred work.
- [Revise investigation](src/tools/agent/REVISE-INVESTIGATION.md) — historical findings and remaining engineering work.

## Development checks

```bash
npm run test:run
npx tsc --noEmit
```

Provider and lifecycle behavior also require the manual checks in the linked documentation.

### Changing delegated-run persistence

The layered rules are in [Persistence and recovery](docs/agent-persistence.md) and
`docs/agent-snapshot-gc.md`. The two that are easiest to break silently:

- A **checkpoint** save (status transition, guidance park, terminal outcome, tombstone) writes a snapshot row,
  appends one `pi-coder:agent-run-snapshot-v2` parent marker, and advances the continuation head. An
  **intermediate** frame writes only `agent_run_working_state` and the catalog projection: never a marker, never
  the head. `SqliteAgentRunStateWriter.persistQueued` owns that branch, and the only `intermediate` senders are
  `onFileChanged` and `updateTranscriptLeaf` in `runs/child-setup.ts`.
- `agent_run_continuation_heads` must always name a surviving, valid checkpoint row, and
  `agent_run_snapshots` rows stay immutable once marked. Mutable per-run state belongs in its own table, because
  two markers naming one changing row would let an older sibling branch restore a newer state.

Covered by `test/tools/agent-run-working-state.test.ts` (frame storage, the overlay gate matrix, and the
child-hook seam) and the V2 cases in `test/tools/agent-persistence-v2.test.ts`. Run
[Manual snapshot GC validation](src/tools/agent/SNAPSHOT-GC-MANUAL-VALIDATION.md) after changing the save
branching, the overlay gates, or leaf resolution: an interrupted run restoring at the wrong transcript leaf
passes every unit test.

### Changing what a child may do

The layers and their rules are in [Capabilities, grants, and gates](docs/agent-tool.md#capabilities-grants-and-gates). In short:

- `definitions/types.ts` — capability names, baseline grants, implications, and the authority ladder.
- `child/grant.ts` — the only place a declaration becomes a decision for one child.
- `child/capabilities/` — one unit per capability: its tools, read roots, and registered extension.
- `child/gates/` — one file per authorization surface, installed in the fixed order in `gates/index.ts`.
- `child/prompt/` — the four run-mode profiles and the paragraphs they place.

Pinned by `test/tools/agent-child-gates.test.ts` (which gates a child arms, in order) and
`test/tools/agent-child-decisions.test.ts` (the resulting allow/block truth table). Use
`test/tools/child-run-fixture.ts` for new child-side tests rather than hand-writing an option bag.

### Changing child compaction

A child compacts its own transcript, and it does so through pi-coder's replacement path: `child/index.ts`
lists `pi-coder-compaction` as its own hidden extension entry (not a capability — nothing grants or revokes
it, and it registers no tools). See `src/modules/compaction/` for the cascade and its config file.

No suite can prove the provider call works, so after changing the cascade, the request shape, or the child
extension list, run the manual pass:

1. Make compaction fire cheaply — lower `compaction.reserveTokens` and `compaction.keepRecentTokens` in
   `.pi/settings.json`, or pick a small-context model — and start a scout whose task reads many files.
2. Open `/agents`, select the run, and confirm its trace records `session.compaction_start` and
   `session.compaction_end` with a reason, and that the run keeps going afterward.
3. Read the child's session JSONL: the `compaction` entry's `details.strategy` names the route that ran,
   its `usage` is non-zero (so session totals keep counting summarization work), and `summary` opens with
   pi's `## Goal` section, which is what the transcript preview renders.
4. Repeat once against a provider that ignores `tool_choice` (for example the local llama.cpp provider).
   The expected outcome is `strategy: "serialized"` in the entry, not a stalled or failed run.
