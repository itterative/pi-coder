---
name: workspaces
description: Detailed isolated worker worktrees, setup, leases, and result disposition.
category: architecture
keep_updated: true
---

# Agent workspaces

## Pool and setup

- Isolated workers use a persistent user-managed pool of up to three Git worktrees under project-local `.state/workspaces/`. Selection is stable and requires a compatible ready workspace that is not leased; capacity is reported instead of silently creating a fourth. `listAgentWorkspaces(cwd, options)` names its optional workspace-directory and missing-worktree inclusion controls.
- Leases transfer from setup provisioning to the task run and do not expire automatically. The workspace remains excluded from automatic reuse while a task result is under review.
- If no ready workspace exists, an internal setup worker prepares the new worktree with permission-gated, non-interactive Bash (default timeout ten minutes). Setup is visible in Current/browser activity but is not a normal collectable run or mailbox result.

## Results

- Collection finalizes the worker tree. Existing worker commits are preserved; remaining changes are committed as a final private pi-coder result commit. Changed results receive a durable private ref; no-change results receive no durable ref.
- A changed result leaves the parent checkout untouched and keeps its lease until explicit disposition. The parent may inspect, apply, retain, reset/reuse, discard, or revise it through `agent` actions or `/agents`; destructive TUI actions require confirmation. Revision reopens the original child session with its original model and sends only parent guidance as the next message, while using a new logical run identity for result ownership. Revision rejects a worktree whose current HEAD is not descended from its recorded base before starting the child or transferring the lease; reconciliation/reset is explicit. Workspaces are never merged, reset, or deleted implicitly.
- Applying uses the complete base-to-worker tree diff without creating a parent commit. Safe preflight requires a clean parent whose revision still contains the recorded base; Git's patch check decides whether later unrelated commits conflict. Failures leave the workspace and lease intact.

## Lease invariants

- A no-change result may outlive its creating lease. Reconciliation may release a lease only when the matching result's `runId` equals the lease's `leaseRunId`; an older result must not release a newer lease.
- Collection must consume a retained no-change result before releasing its lease, so a failed collection cannot strand an unleased retained run. Reset returns freshly projected workspace state immediately.
- Store, lifecycle, and result helpers retain the workspace/workspace ID as their positional subject and take named lease options for session/run ownership, workspace directories, and lease-instance controls. Shared option types prevent IDs and optional-directory values from being silently swapped.
