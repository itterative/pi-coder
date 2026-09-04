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

SQLite run-state is scoped to the exact parent session and active parent-tree branch. Child transcripts do not contain the parent run ID, task/status, pending question, usage checkpoint, or retention state. Three kinds of durable run state exist, and only the first two are authoritative for restoration:

- **Snapshots** (`agent_run_snapshots`) — one immutable row per checkpoint, each pinned by a parent-tree marker when it is committed.
- **Continuation heads** (`agent_run_continuation_heads`) — one row per physical run naming its current checkpoint; this is the durable "which checkpoint are we at".
- **Working state** (`agent_run_working_state`) — at most one mutable row per physical run holding the latest progress frame. It is a recovery hint, never journal state, and it is referenced by no marker.

The run catalog (`agent_runs`) stays a rebuildable projection. Branch-correct restoration is decided by parent-tree markers over immutable snapshots; the single exception is the child transcript _leaf_ of a crash-interrupted run, described under [Checkpoints and progress frames](#checkpoints-and-progress-frames).

## Restoration rules

- Waiting children restore as `waiting_for_parent`.
- Runs starting or running during shutdown/crash restore as `interrupted`.
- Interrupted runs never restart, replay tools, or resume automatically.
- Resuming is user-driven and adds an instruction to inspect uncertain state first.
- Unmatched crash-time tool calls receive synthetic uncertain-outcome errors.
- Each resumable run must contain a complete persisted agent definition snapshot; missing or malformed snapshots fail fast with a recovery diagnostic.
- A crash-interrupted run may restore at its working row's child leaf rather than its checkpoint leaf; see [Checkpoints and progress frames](#checkpoints-and-progress-frames).
- The persisted definition snapshot supplies the runtime contract. A current definition fingerprint mismatch is informational and does not invalidate the run.
- Persisted metadata cannot grant mutation authority; an edit-capable snapshot still requires the current built-in worker authorization.
- New, forked, cloned, and ephemeral parent sessions do not inherit children.

Collection, cancellation, and terminal-result eviction append removal tombstones but retain child files so `/agents` can browse historical work. Historical checkpoints without an exact child leaf are read-only or report an unavailable transcript rather than opening the physical session's latest leaf.

## V2 branch and continuation model

Each physical run has a globally unique internal run instance and a session-wide continuation head. Parent-tree markers point to immutable SQLite snapshots. Only the branch whose latest reachable marker equals the continuation head may resume a physical run; older sibling checkpoints remain read-only and are marked as continued elsewhere.

Before context construction, restoration selects the exact persisted child transcript leaf. The manager captures the leaf after each settled prompt and before terminal handle disposal, and on every progress frame in between. This prevents a historical browser row from accidentally opening a newer branch of the child conversation.

Checkpoint writes use SQLite continuation leases, expected-head compare-and-swap, and pending head reservations. Leases serialize competing processes and survive marker/head failures. Restoration may reclaim a lease immediately when the recorded Pi-process PID is conclusively dead; uncertain PID checks fall back to lease expiry. The expiry wait has a grace period, is abortable during shutdown or parent resume cancellation, and uses an unref'd timer. A released run can still be checkpointed: releasing drops the in-process lease claim immediately, so a later write — such as the removal tombstone `collect` stores after a background terminal result — takes a lease of its own instead of relying on one that is still being released.

## Checkpoints and progress frames

Every durable run write declares why. A **checkpoint** is a lifecycle boundary — accepted start, child transcript creation, guidance request, resume, settled operation, interruption or shutdown park, terminal outcome, removal tombstone, workspace-result attachment. A **progress frame** is the child reporting movement: a transcript-leaf advance or a file change. Callers that do not say get `checkpoint`, so a missed classification can only ever write too much, never too little.

A checkpoint writes an immutable snapshot row, appends one `pi-coder:agent-run-snapshot-v2` parent-tree marker, advances the continuation head, and refreshes the catalog projection — as two `IMMEDIATE` transactions, since the marker append is the commit point. A progress frame writes one upserted `agent_run_working_state` row plus the catalog projection in a single transaction: no snapshot row, no marker, no head write, no lease acquisition. It never overwrites the checkpoint journal, and the head therefore always names a surviving, fully valid checkpoint.

Two rules follow from that split and must not be relaxed:

- **A snapshot row is immutable once its marker is committed, and mutable state never lives in that table.** Two markers naming one changing row would let an older sibling branch resolve to a newer state than it reached.
- **A frame is best-effort.** It is stored only while this process owns the run's continuation lease, and dropped otherwise with a `persistence.progress_dropped` trace. It never uses the refused-write channel, which is reserved for writes that carry authority and is budgeted to one user warning per session. A frame whose status is a checkpoint boundary is dropped rather than upgraded: every status transition already writes its own checkpoint, so upgrading a late frame would append a marker after the run's real terminal one.

On restore, markers still decide which checkpoint a branch gets. After that, one narrow overlay may sharpen _where inside that child transcript_ the child stopped: for a run whose checkpoint is unclean (`starting`/`running`), that is `resumable` on this branch, whose continuation lease is not held by a live process, and whose working row is newer, names the same physical run and the same child transcript, and carries a leaf that really exists in that transcript, the leaf and progress come from the working row. Every other record — a clean park, a terminal outcome, a tombstone, read-only sibling history — keeps exactly what its marker describes, and `updatedAt` always stays the checkpoint's because the frame narrows where the child stopped, not when the parent last checkpointed. `ENABLE_WORKING_STATE_OVERLAY` reverts leaf resolution to checkpoint-only; frames keep being written while it is off, so switching it back on needs no repair pass.

The committed checkpoint clears the run's working row, so a frame can never outlive the checkpoint that absorbed it, and a parent transcript can never be rewritten: when the snapshot GC reclaims intermediate rows, their markers stay behind. A marker whose row is gone is therefore resolved by inference — the same physical run still has a surviving row means the checkpoint was reclaimed, so the marker is skipped silently and the branch falls back to the older checkpoint; a run with no surviving row at all keeps the loud `parent marker references a missing SQLite snapshot` diagnostic, because that is the genuine wiped-database case.

## Continue persistence semantics

`continue` uses the persisted definition snapshot as the runtime contract. The current definition is compared only for an informational drift diagnostic.

For a collected terminal child, `continue` continues it without creating a separate child conversation. For isolated workers it also advances workspace-result ownership:

1. Resolve the checkpoint authoritative for the exact parent session and active parent-tree branch.
2. For an isolated worker, confirm worktree ancestry before starting anything and require its prepared task lease.
3. Reuse the public run ID and reserve the existing physical run identity for the continued child.
4. Reopen the original child transcript at its persisted leaf.
5. Send only continuation guidance as the next child message, using the model recorded in that session.
6. For an isolated worker, retain the existing workspace lease for the continued run identity.
7. For an isolated worker, finalize and persist a new prepared workspace result.

The public run ID remains stable across continuation, so repeated `continue` actions continue the latest checkpoint rather than creating confusing new agent IDs. The child session and physical run identity remain the same; isolated workspace results still receive a new result record while retaining the existing lease. Legacy records without a physical `runInstanceId` are accepted for compatibility and receive a synthesized identity when continued. Definition drift does not reject a prepared result: the persisted definition snapshot supplies capabilities and the child session supplies transcript/model continuity.

## Failure and recovery semantics

The workspace lease remains with the same run identity while continuation setup and execution occur. Setup failures are marked explicitly and skip workspace-result finalization because no child prompt ran. If continuation or finalization fails, the existing lease and prior prepared result remain addressable for recovery; no ownership transfer is required.

A divergent worktree is rejected before child startup, lease transfer, or metadata mutation. Pi-coder does not silently rebase, reset, update the recorded base, or accept an ambiguous diff. See [Workspace lifecycle](docs/agent-workspaces.md).

## Browser behavior

`/agents` builds historical rows from the run catalog and active-branch checkpoint resolution rather than scanning every transcript. Opening a historical detail loads only that transcript and exact leaf. Live details reload on agent events and follow new content until the user scrolls up; `End` resumes following. Details are read-only and omit model thinking and potentially large tool-result output.

The event bus publishes bounded invalidation signals for run creation/restoration/progress/status/removal, workspace setup/lease/result/removal, and runtime restoration/reconciliation/reset/shutdown. Consumers must reload authoritative state from the manager or workspace registry.

## Diagnostics and cleanup

`/agent-trace` keeps bounded sanitized in-memory timelines for recent runs. Saved traces use mode `0600` under `~/.pi/agent/traces/`. Traces do not contain tool-result contents or credentials.

Growth is prevented at the write path rather than cleaned up afterwards: progress frames never enter the snapshot table, so a long child run leaves one marker per lifecycle boundary instead of one per tool call, and its mutable state stays one row. Committed snapshots and the transcripts they reference stay protected — nothing reclaims a row whose marker is still resolvable to a surviving checkpoint of another run, a continuation head target, or the newest row of a run.

The one deletion path is for intermediate snapshots written before frames existed. It removes only rows failing that protected set, and because markers cannot be rewritten it relies on the silent-skip inference above; `presentation/sessions.ts` already skipped unreadable markers the same way. `PRAGMA auto_vacuum` is deliberately left at `0`: steady-state writes free almost no pages, so the freelist stays near empty (`freelist_count = 0` measured after the sweep) and there is nothing for autovacuum to reclaim — the file still grows, but only from new checkpoint rows at roughly 6 KB each, which is insert volume rather than fragmentation. Enabling it would also require an exclusive rebuild that cannot run inside a migration transaction. Shrink the file only inside a deliberate maintenance action, with `VACUUM` followed by `PRAGMA wal_checkpoint(TRUNCATE)` — in WAL mode the rewrite is itself written through the WAL. Design, measurements, and the executed sweep are in [Snapshot GC](docs/agent-snapshot-gc.md); the operator checklist for behavior unit tests cannot reach is [`src/tools/agent/SNAPSHOT-GC-MANUAL-VALIDATION.md`](src/tools/agent/SNAPSHOT-GC-MANUAL-VALIDATION.md).
