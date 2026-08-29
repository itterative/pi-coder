---
name: workspaces
description: Detailed isolated worker worktrees, setup, leases, and result disposition.
category: architecture
keep_updated: true
---

# Agent workspaces

## Pool and setup

- Isolated workers use a persistent user-managed pool of up to three Git worktrees under project-local `.state/workspaces/`. Selection is stable and requires a compatible ready workspace that is not leased; capacity is reported instead of silently creating a fourth. `listAgentWorkspaces(cwd, options)` names its optional workspace-directory and missing-worktree inclusion controls.
- Leases transfer from setup provisioning to the task run and do not expire automatically. A safely checkpointed inactive physical slot may be recycled for another logical worker while its older result remains durable; active and uncheckpointed leases remain excluded from automatic reuse.
- If no ready workspace exists, an internal setup worker prepares the new worktree with permission-gated, non-interactive Bash (default timeout ten minutes). Setup is visible in Current/browser activity but is not a normal collectable run or mailbox result.

## Results

- Collection finalizes the worker tree. Existing worker commits are preserved; remaining changes are committed as a final private pi-coder result commit. Changed results receive a durable private ref; no-change results receive no durable ref.
- A changed result leaves the parent checkout untouched and keeps its immutable result ref until disposition, but its safely checkpointed inactive physical slot may be recycled for another logical worker. The parent may inspect, apply, retain, reset/reuse, discard, or continue it through `agent` actions or `/agents`; destructive TUI actions require confirmation. Manual reset/discard can also clear an inactive task lease owned by another session, so an abandoned slot can be recovered without reopening that session. Durable active task leases and setup leases remain protected. Isolated continuation reopens the original child session with its original model, keeps the same workspace, and sends only parent guidance as the next message, while retaining the same public and physical run identity. Collected non-mutating runs such as reviewer can also be continued without a workspace, reusing their original execution cwd and child session. Continuations keep the public run ID stable so the parent UI continues to show one agent and repeated revisions continue the latest checkpoint. Isolated continuation rejects a worktree whose current HEAD is not descended from its recorded base before starting the child or transferring the lease; reconciliation/reset is explicit. New isolated work is conservatively rejected while the parent checkout is dirty until parent snapshot/materialization is designed. Workspaces are never merged, reset, or deleted implicitly.
- Applying uses the complete base-to-worker tree diff without creating a parent commit. Safe preflight requires a clean parent whose revision still contains the recorded base; Git's patch check decides whether later unrelated commits conflict. An `applying` result state protects the reservation across a crash so a later apply request can classify the parent as unapplied, applied, or uncertain. Failures leave the workspace and lease intact.

## Lease invariants

- A no-change result may outlive its creating lease. Reconciliation may release a lease only when the matching result's `runId` equals the lease's `leaseRunId`; an older result must not release a newer lease.
- Collection must consume a retained no-change result before releasing its lease, so a failed collection cannot strand an unleased retained run. Reset returns freshly projected workspace state immediately.
- Store, lifecycle, and result helpers retain the workspace/workspace ID as their positional subject and take named lease options for session/run ownership, workspace directories, and lease-instance controls. Shared option types prevent IDs and optional-directory values from being silently swapped.

## Target shared-slot/checkpoint design

The agreed direction is to make physical workspace slots reusable while preserving logical worker identity. Intermediate and terminal checkpoints remain permanently associated with the physical workspace where they were captured; a logical worker must resume only in that same workspace. If an interrupted worker X in A is checkpointed and A is reused by Y, X becomes parked and waits for A rather than moving to B. Every normally observed intermediate or terminal transition—including waiting for parent guidance, completion, failure, abort, and cancellation—must checkpoint after the operation settles; a cancellation request is not itself a safe boundary. Reuse is allowed only after a safe boundary or verified-dead/expired owner, and checkpointing must capture dirty tracked/non-ignored untracked state before reset. PID/renewable lease health checks should guard this handoff. If a normally observed checkpoint fails, the worker remains protected as interrupted. Multiple workers may have durable checkpoints/results for one slot, so exact result/checkpoint lookup must replace `latestResult` as the lifecycle authority. Result actions use persisted result IDs when available (or exact run instances for legacy records), immutable result refs, and compare-and-set reservation tokens before apply/retain/discard side effects. Reservations include owner PID recovery after a dead process and grace period; reset/discard/recycling reject in-flight reservations. Parent restart must leave parked/occupied workers persisted for explicit continuation rather than reopening them in a reused worktree. See `docs/agent-workspaces.md` for the target lifecycle and the deferred parent-working-tree design gap.
