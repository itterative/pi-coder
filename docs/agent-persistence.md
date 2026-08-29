# Agent persistence and recovery

Pi-coder stores delegated-agent state in two places:

- **Child transcripts** are private JSONL sessions managed by Pi's `SessionManager`.
- **Run/workspace metadata** is stored in the extension's SQLite database.

The short overview is in [`src/tools/agent/README.md`](src/tools/agent/README.md). The implementation invariants are also summarized in the project memories under `.pi/agent/memory/agents/`.

## Storage

For a persisted parent session, child transcripts live under the installed extension's private state directory:

```text
.state/agent-sessions/--<encoded-cwd>--/<parent-session-id>/
```

The exact install root comes from `src/common/constants.ts`; the cwd encoding is centralized in `normalizeCwdForSessionDirectory()`. Private directories use mode `0700`, and `.state/` is gitignored.

SQLite run-state is scoped to the exact parent session and active parent-tree branch. Child transcripts do not contain the parent run ID, task/status, pending question, usage checkpoint, or retention state. The metadata catalog is a rebuildable projection; immutable V2 snapshots and parent-tree markers are authoritative for branch-correct restoration.

## Restoration rules

- Waiting children restore as `waiting_for_parent`.
- Runs starting or running during shutdown/crash restore as `interrupted`.
- Interrupted runs never restart, replay tools, or resume automatically.
- Resuming is user-driven and adds an instruction to inspect uncertain state first.
- Unmatched crash-time tool calls receive synthetic uncertain-outcome errors.
- Each resumable run must contain a complete persisted agent definition snapshot; missing or malformed snapshots fail fast with a recovery diagnostic.
- The persisted definition snapshot supplies the runtime contract. A current definition fingerprint mismatch is informational and does not invalidate the run.
- Persisted metadata cannot grant mutation authority; an edit-capable snapshot still requires the current built-in worker authorization.
- New, forked, cloned, and ephemeral parent sessions do not inherit children.

Collection, cancellation, and terminal-result eviction append removal tombstones but retain child files so `/agents` can browse historical work. Historical checkpoints without an exact child leaf are read-only or report an unavailable transcript rather than opening the physical session's latest leaf.

## V2 branch and continuation model

Each physical run has a globally unique internal run instance and a session-wide continuation head. Parent-tree markers point to immutable SQLite snapshots. Only the branch whose latest reachable marker equals the continuation head may resume a physical run; older sibling checkpoints remain read-only and are marked as continued elsewhere.

Before context construction, restoration selects the exact persisted child transcript leaf. The manager captures the leaf after each settled prompt and before terminal handle disposal. This prevents a historical browser row from accidentally opening a newer branch of the child conversation.

Checkpoint writes use SQLite continuation leases, expected-head compare-and-swap, and pending head reservations. Leases serialize competing processes and survive marker/head failures. Restoration may reclaim a lease immediately when the recorded Pi-process PID is conclusively dead; uncertain PID checks fall back to lease expiry. The expiry wait has a grace period, is abortable during shutdown or parent resume cancellation, and uses an unref'd timer.

## Revise persistence semantics

`resume` and `revise` use the persisted definition snapshot as the runtime contract. The current definition is compared only for an informational drift diagnostic.

`revise` continues a collected terminal child without creating a separate child conversation. For isolated workers it also advances workspace-result ownership:

1. Resolve the checkpoint authoritative for the exact parent session and active parent-tree branch.
2. For an isolated worker, confirm worktree ancestry before starting anything and require its prepared task lease.
3. Reuse the public run ID and reserve the existing physical run identity for the continued child.
4. Reopen the original child transcript at its persisted leaf.
5. Send only revision guidance as the next child message, using the model recorded in that session.
6. For an isolated worker, retain the existing workspace lease for the continued run identity.
7. For an isolated worker, finalize and persist a new prepared workspace result.

The public run ID remains stable across revision, so repeated `revise` actions continue the latest checkpoint rather than creating confusing new agent IDs. The child session and physical run identity remain the same; isolated workspace results still receive a new result record while retaining the existing lease. Legacy records without a physical `runInstanceId` are accepted for compatibility and receive a synthesized identity when revised. Definition drift does not reject a prepared result: the persisted definition snapshot supplies capabilities and the child session supplies transcript/model continuity.

## Failure and recovery semantics

The workspace lease remains with the same run identity while continuation setup and execution occur. Setup failures are marked explicitly and skip workspace-result finalization because no child prompt ran. If continuation or finalization fails, the existing lease and prior prepared result remain addressable for recovery; no ownership transfer is required.

A divergent worktree is rejected before child startup, lease transfer, or metadata mutation. Pi-coder does not silently rebase, reset, update the recorded base, or accept an ambiguous diff. See [Workspace lifecycle](docs/agent-workspaces.md).

## Browser behavior

`/agents` builds historical rows from the run catalog and active-branch checkpoint resolution rather than scanning every transcript. Opening a historical detail loads only that transcript and exact leaf. Live details reload on agent events and follow new content until the user scrolls up; `End` resumes following. Details are read-only and omit model thinking and potentially large tool-result output.

The event bus publishes bounded invalidation signals for run creation/restoration/progress/status/removal, workspace setup/lease/result/removal, and runtime restoration/reconciliation/reset/shutdown. Consumers must reload authoritative state from the manager or workspace registry.

## Diagnostics and future cleanup

`/agent-trace` keeps bounded sanitized in-memory timelines for recent runs. Saved traces use mode `0600` under `~/.pi/agent/traces/`. Traces do not contain tool-result contents or credentials.

Garbage collection is intentionally conservative and currently limited to reporting. Any future prune policy should remove only verified orphan transcripts first; snapshots and referenced transcripts must remain protected.
