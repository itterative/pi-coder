---
name: workspace-lifecycle
description: Workspace lease and collection invariants discovered during manual validation.
category: architecture
---

A no-change `workspace_results` row may outlive the lease that created it. Reconciliation must only release a task lease when `latestResult.runId === workspace.leaseRunId`; otherwise a new task lease can be released because of an older result. Collection must consume the retained agent result before releasing a no-change lease, so failed collection cannot strand an unleased retained run. Manual workspace collection flows must use `agent(action="spawn", isolation="worktree")`; foreground `start` results are returned directly and are not collectable.
