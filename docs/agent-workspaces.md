# Isolated agent workspaces

Isolated workers run in persistent Git worktrees under the pi-coder state directory. The parent checkout is not modified by worker execution or result collection. A result changes the parent only after an explicit `apply` action.

For the short agent-tool overview, see [`src/tools/agent/README.md`](src/tools/agent/README.md). For the complete disposable-repository checklist, see [`WORKSPACE-MANUAL-VALIDATION.md`](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md).

## Workspace lifecycle

1. **Setup** — select or create one of up to three persistent worktrees.
2. **Lease** — claim the worktree for a parent session and delegated run.
3. **Execution** — the isolated worker reads and changes only its worktree.
4. **Finalization** — collection commits remaining changes, creates a private result ref, and records a prepared result.
5. **Disposition** — the parent explicitly inspects, applies, retains, revises, resets, or discards the result.

No-change results create no durable ref and release the workspace for reuse. Changed results remain leased and outside the parent checkout until disposition. Workspaces are not silently merged, reset, rebased, applied, or deleted.

Applying uses the complete base-to-worker tree diff without creating a parent commit. The parent must be clean, still contain the recorded base revision, and pass Git patch checks. A failed apply leaves the parent, result, and lease intact.

## Lease invariants

- The lease identifies the owning parent session, display run ID, physical run instance, and lease kind (`setup` or `task`).
- A prepared result must match the task lease's run ID and physical run instance.
- A stale run ID cannot inspect or disposition a newer result.
- A no-change result is consumed before its lease is released, so collection failure does not strand an unleased result.
- Explicit reset returns a workspace to the current parent revision and removes result refs. Explicit discard removes the isolated workspace and saved refs.

## Revise

For isolated workers, `revise` is available only for a prepared changed result whose task lease is still owned by the current parent session. It is not normally available after `retain`, `apply`, `discard`, or no-change release. Collected non-mutating runs such as `reviewer` can be revised without a workspace; revision is restricted to the exact parent session and active parent-tree branch.

A revision has two identities:

- The **child session** continues: the original JSONL transcript and exact leaf are reopened, the original recorded model is used, and only the parent's guidance is sent as the next prompt.
- The **workspace result run** advances: a new logical run ID and physical run instance own the revised result. The returned new run ID is required for later isolated actions; the old ID is stale for isolated result disposition. For non-mutating runs, the old ID remains addressable as a deliberate fork point from its original child leaf.

Revision does not invalidate a result because its definition fingerprint or capabilities changed after the original run. It uses the complete definition snapshot persisted with the run; the child session remains authoritative for the conversation and recorded model. The current definition is informational only, while a missing or malformed persisted snapshot fails clearly because the original execution contract cannot be reconstructed.

### Divergent-history policy

Before starting the child, pi-coder reads the worktree `HEAD` and verifies that the recorded workspace `baseRevision` is an ancestor. This protects the existing result and the normal base-to-worker diff model when a worktree has been rebased, force-reset, or otherwise moved to unrelated history.

The chosen policy is **fail early and preserve state**:

- no child is started;
- no new lease is transferred;
- no workspace or result metadata is changed;
- the existing prepared result and lease remain available;
- the user must explicitly reconcile or reset the workspace before trying again.

Pi-coder does not silently update `baseRevision`, rebase the worktree, discard the old result, or accept an ambiguous divergent diff.

### Revise flow

```text
┌──────────────────────────────────────────────────────────────────────┐
│ agent(action="revise", runId=old, guidance=feedback)                 │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
                 ┌────────────────────────────────┐
                 │ Resolve parent-owned run and   │
                 │ prepared task lease/result     │
                 └───────────────┬────────────────┘
                                 │ invalid
                                 v
                         [Reject; preserve state]
                                 │ valid
                                 v
                 ┌────────────────────────────────┐
                 │ Read worktree HEAD and verify  │
                 │ baseRevision is its ancestor  │
                 └───────────────┬────────────────┘
                    divergent    │ descendant
                       v          v
              [Reject before   ┌──────────────────────────────┐
               child/transfer; │ Reserve new logical identity │
               preserve old]   └──────────────┬───────────────┘
                                              v
                 ┌────────────────────────────────────────────┐
                 │ Reopen original child session + exact leaf │
                 │ and send guidance as the sole next prompt  │
                 └─────────────────────┬──────────────────────┘
                                       │ setup/start failure
                                       v
                              [Reject; old lease remains]
                                       │ success
                                       v
                 ┌────────────────────────────────────────────┐
                 │ Transfer lease old → new, then finalize    │
                 │ the revised worktree as a prepared result  │
                 └─────────────────────┬──────────────────────┘
                                       │ transfer/finalize failure
                                       v
                 [Attempt new → old lease rollback; preserve error]
                                       │ success
                                       v
                 [Return new run/result ID; old ID is stale]
```

The old lease remains authoritative while the child continuation runs. Transfer occurs only after continuation succeeds. If transfer succeeds but result finalization fails, pi-coder attempts a compare-and-swap-style transfer back to the old run. A rollback failure does not replace the original finalization error; the workspace requires explicit recovery and should not be silently reused.

## Validation

Run automated checks with:

```bash
npm run test:run
npx tsc --noEmit
```

Use the manual checklist for no-change reuse, changed results, apply preflight failures, reset/discard, capacity, and reload/interrupted-run recovery.
