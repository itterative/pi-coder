---
name: workspace-lifecycle
description: Workspace lease and collection invariants discovered during manual validation.
category: architecture
---

A no-change `workspace_results` row may outlive the lease that created it. Reconciliation must only release a task lease when `latestResult.runId === workspace.leaseRunId`; otherwise a new task lease can be released because of an older result. Collection must consume the retained agent result before releasing a no-change lease, so failed collection cannot strand an unleased retained run. Manual workspace collection flows must use `agent(action="spawn", isolation="worktree")`; foreground `start` results are returned directly and are not collectable. Foreground isolated `start`/`resume`/explicit cancellation must therefore prepare the workspace result directly, releasing verified no-change leases or retaining changed leases for disposition. `/agents` browsing runs the same safe no-change reconciliation; changed/uncertain leases remain protected. A lease with any matching catalog row is known, including terminal runs whose prepared result still awaits disposition; only a missing catalog row is orphaned. Past persisted startup/running metadata is displayed as interrupted because no live child handle is attached to a past transcript.
