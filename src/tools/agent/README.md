# Agent tool

`pi-coder` provides an in-process `agent` tool for delegated exploration and permission-gated implementation.

## Quick reference

```text
agent(action="list")
agent(action="start", agent="scout", task="Investigate ...")
agent(action="spawn", agent="worker", isolation="worktree", task="Implement ...")
agent(action="status", runId="worker-1")
agent(action="collect", runId="worker-1")
agent(action="resume", runId="worker-1", guidance="...")
agent(action="cancel", runId="worker-1")
agent(action="inspect", runId="worker-1")
agent(action="apply", runId="worker-1")
agent(action="discard", runId="worker-1")
agent(action="revise", runId="worker-1", guidance="...")
```

- `start` runs a child in the foreground; `spawn` runs it in the background.
- `scout` is read-only, `reviewer` can run permission-gated commands, and only the built-in `worker` can edit.
- `spawn` returns immediately. Collect terminal background results explicitly; do not poll or sleep while waiting.
- Isolated workers use persistent Git worktrees. Changed results remain outside the parent checkout until an explicit `apply`.
- `/agents` browses delegated runs and isolated workspaces.

## Revise at a glance

`revise` continues a changed isolated result in the same workspace and child conversation. It reopens the original child session and exact transcript leaf, preserves the recorded model, and sends only the supplied guidance as the next prompt. It returns a new logical run ID for the revised result; use that ID for later disposition.

Before starting the child, revise verifies that the worktree `HEAD` descends from the recorded workspace base. Divergent history is rejected without starting the child, transferring the lease, or changing the existing result. Lease transfer happens only after continuation succeeds, with rollback attempted if transfer or finalization fails.

## More documentation

- [Agent tool reference](docs/agent-tool.md) — actions, child roles, safety boundaries, prompt design, and diagnostics.
- [Workspace lifecycle](docs/agent-workspaces.md) — isolated worktrees, result disposition, leases, and the revise flow chart.
- [Persistence and recovery](docs/agent-persistence.md) — child transcripts, snapshots, restoration, and restart behavior.
- [Manual workspace validation](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md) — disposable-repository lifecycle checklist.
- [Implementation plan](src/tools/agent/PLAN.md) — architecture and deferred work.
- [Revise investigation](src/tools/agent/REVISE-INVESTIGATION.md) — historical findings and remaining engineering work.

## Development checks

```bash
npm run test:run
npx tsc --noEmit
```

Provider and lifecycle behavior also require the manual checks in the linked documentation.
