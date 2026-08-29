# Isolated agent workspaces

Isolated workers run in persistent Git worktrees under the pi-coder state directory. The parent checkout is not modified by worker execution or result collection. A result changes the parent only after an explicit `apply` action.

For the short agent-tool overview, see [`src/tools/agent/README.md`](src/tools/agent/README.md). For the complete disposable-repository checklist, see [`WORKSPACE-MANUAL-VALIDATION.md`](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md).

## Target shared-slot lifecycle

The long-term design separates a physical workspace slot from a logical worker and its durable checkpoints/results. The current implementation still retains changed results until explicit disposition; the rules below define the target behavior for shared workspace reuse.

- A checkpoint—intermediate or terminal—is permanently associated with the physical workspace in which it was captured. Its metadata includes the originating workspace ID, run instance, checkpoint sequence, base revision, Git ref, and matching child-transcript leaf.
- A logical worker's workspace identity is immutable. If worker X belongs to workspace A and A is later assigned to worker Y, X may be parked but can resume only after reclaiming A. X must never be resumed in workspace B, even if B is otherwise available. Parent restart leaves a parked or occupied worker as a persisted run for explicit continuation instead of reopening it in the current occupant's worktree.
- Every normally observed intermediate or terminal transition creates a checkpoint before that state is exposed for reuse or recovery. This includes waiting for parent guidance, completed, failed, aborted, and canceled states; cancellation must wait for the abort/operation to settle before snapshotting. A live worker executing a prompt, tool call, or permission wait cannot be reset underneath itself. An interrupted or parked worker must first have its current tracked/non-ignored untracked tree checkpointed; if its process is gone, the recovery path performs that checkpoint before reset.
- PID liveness and renewable/expiring leases protect the handoff. A live owner blocks takeover. A conclusively dead process or expired lease permits recovery, but Git snapshotting and database reassignment still require a guarded recycle transition.
- Reusing a slot does not delete its older checkpoints or results. Multiple logical workers may therefore have durable records associated with one workspace over time. Workspace-level `latestResult` is only a display projection; actions resolve an exact persisted result ID (or exact run instance for legacy records) and use its immutable Git ref rather than the mutable worktree. Apply, retain, and discard reserve the exact prepared result with a compare-and-set token before side effects, so competing dispositions cannot silently act on the same result. Reservations carry the owner PID and are recoverable only after a dead owner and grace period; reset, discard, and recycling reject in-flight reservations.
- Resuming X restores X's latest checkpoint into A, verifies A's expected revision and clean state, reopens X's original child transcript with the original execution path, and sends only the requested guidance plus an explicit checkpoint-resume notice. If A is currently used by Y, X remains parked rather than moving to another path.
- A terminal checkpoint may later be finalized as a disposition result, but an intermediate checkpoint is only for recovery/resumption and is not automatically eligible for apply/retain/discard. Final disposition should operate on an exact durable result. Applying or inspecting an old result must not depend on the current contents of the reused worktree.
- If a normally observed checkpoint cannot be persisted, the worker remains protected as interrupted and its workspace must not be reused. The existing foreground cancellation path currently starts abort without awaiting it, so the implementation must settle cancellation before checkpointing rather than treating the cancel request itself as the safe boundary.

The intended allocation order is: genuinely free compatible slots first, then safely checkpointed inactive slots ordered by a fair least-recently-used policy. Active workers and setup operations are never evicted. Parked workers waiting for their original slot must be visible to the scheduler so repeated reuse does not starve continuation indefinitely.

A checkpoint ref protects Git-visible state, not ignored files, running processes, or external environment state. Workspace setup compatibility must therefore be checked when restoring a checkpoint.

### Deferred design gap: parent working-tree changes

The initial shared-slot implementation remains conservative about the parent working tree. Applying a worker result currently requires a clean parent and leaves the applied changes uncommitted. A later worker based only on parent `HEAD` cannot see those changes. New isolated work is therefore currently rejected while the parent checkout is dirty. The broader design gap remains to be revisited after gaining more operational experience; possible future solutions include snapshotting/materializing the parent working tree or changing apply semantics.

## Workspace lifecycle

1. **Setup** — select or create one of up to three persistent worktrees.
2. **Lease** — claim the worktree for a parent session and delegated run.
3. **Execution** — the isolated worker reads and changes only its worktree.
4. **Finalization** — collection commits remaining changes, creates a private result ref, and records a prepared result.
5. **Disposition** — the parent explicitly inspects, applies, retains, continues, resets, or discards the result.

No-change results create no durable ref and release the workspace for reuse. Changed results remain outside the parent checkout and retain their immutable result refs until disposition, but an inactive physical slot may be explicitly recycled for another logical worker after its checkpoint/result is durable. Recycling resets the physical worktree to the current parent `HEAD` and transfers its lease without deleting the older worker's checkpoints or results. Workspaces are never silently merged, applied, or deleted; scheduler recycling is the deliberate reset/rebase operation used to reuse a protected inactive slot.

Applying uses the complete base-to-worker tree diff without creating a parent commit. The parent must be clean, still contain the recorded base revision, and pass Git patch checks. Application records an `applying` result state before changing the parent; a later apply request reconciles whether the patch was applied, was not applied, or left an uncertain checkout. Preflight failures leave the parent, result, and lease intact, while uncertain application state remains protected for explicit recovery.

## Lease invariants

- The lease identifies the owning parent session, display run ID, physical run instance, and lease kind (`setup` or `task`).
- A prepared result must match the task lease's run ID and physical run instance.
- A stale run ID cannot inspect or disposition a newer result.
- A no-change result is consumed before its lease is released, so collection failure does not strand an unleased result.
- Explicit reset returns a workspace to the current parent revision and removes result refs. Explicit discard removes the isolated workspace and saved refs. Both manual clearing actions may be performed from another session once the durable task run is no longer active; active task leases and setup leases remain protected.

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
