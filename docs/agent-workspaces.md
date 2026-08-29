# Isolated agent workspaces

Isolated workers run in persistent Git worktrees under the pi-coder state directory. The parent checkout is not modified by worker execution or result collection. A result changes the parent only after an explicit `apply` action.

For the short agent-tool overview, see [`src/tools/agent/README.md`](src/tools/agent/README.md). For the complete disposable-repository checklist, see [`WORKSPACE-MANUAL-VALIDATION.md`](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md).

## Workspace lifecycle

1. **Setup** — select or create one of up to three persistent worktrees.
2. **Lease** — claim the worktree for a parent session and delegated run.
3. **Execution** — the isolated worker reads and changes only its worktree.
4. **Finalization** — collection commits remaining changes, creates a private result ref, and records a prepared result.
5. **Disposition** — the parent explicitly inspects, applies, retains, continues, resets, or discards the result.

No-change results create no durable ref and release the workspace for reuse. Changed results remain leased and outside the parent checkout until disposition. Workspaces are not silently merged, reset, rebased, applied, or deleted.

Applying uses the complete base-to-worker tree diff without creating a parent commit. The parent must be clean, still contain the recorded base revision, and pass Git patch checks. A failed apply leaves the parent, result, and lease intact.

## Lease invariants

- The lease identifies the owning parent session, display run ID, physical run instance, and lease kind (`setup` or `task`).
- A prepared result must match the task lease's run ID and physical run instance.
- A stale run ID cannot inspect or disposition a newer result.
- A no-change result is consumed before its lease is released, so collection failure does not strand an unleased result.
- Explicit reset returns a workspace to the current parent revision and removes result refs. Explicit discard removes the isolated workspace and saved refs.

## Continue

For isolated workers, `continue` is available for a prepared changed result whose task lease is still owned by the current parent session. It is not normally available after `retain`, `apply`, `discard`, or no-change release. Collected non-mutating runs such as `reviewer` can be continued without a workspace; continuation is restricted to the exact parent session and active parent-tree branch.

A revision keeps the same public agent identity:

- The **child session** continues: the original JSONL transcript and exact leaf are reopened, the original recorded model is used, and only the parent's guidance is sent as the next prompt.
- The **run identity** remains stable: the public run ID and physical run instance are reused, so the parent UI continues to show one agent and repeated revisions continue the latest checkpoint.
- The **workspace result** advances to a new result record while retaining the existing workspace lease. Use the same run ID for later isolated actions.

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

### Continue flow

```text
┌──────────────────────────────────────────────────────────────────────┐
│ agent(action="continue", runId=old, guidance=feedback)               │
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
                 │ baseRevision is its ancestor   │
                 └───────────────┬────────────────┘
                    divergent    │ descendant
                       v          v
              [Reject before   ┌──────────────────────────────┐
               child/transfer; │ Retain existing run identity │
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
                 ┌─────────────────────────────────────────────┐
                 │ Retain the existing lease, then finalize    │
                 │ the continued worktree as a prepared result │
                 └─────────────────────┬───────────────────────┘
                                       │ finalization failure
                                       v
                 [Preserve the prior result and lease; return error]
                                       │ success
                                       v
                 [Return the same run ID with the continued result]
```

The existing lease remains authoritative while the child continuation runs. No ownership transfer is required because the public and physical run identity remain stable. If result finalization fails, the prior prepared result and lease remain available for explicit recovery.

## Validation

Run automated checks with:

```bash
npm run test:run
npx tsc --noEmit
```

Use the manual checklist for no-change reuse, changed results, apply preflight failures, reset/discard, capacity, and reload/interrupted-run recovery.
