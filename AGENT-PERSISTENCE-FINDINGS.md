# Delegated-agent persistence investigation

## Status and recommendation

The current branch-keyed SQLite upsert design is not sufficient for correct `/tree` behavior.

The selected replacement design is implemented in the current branch as V2 persistence. New workspace lease/result paths carry physical `runInstanceId` alongside display IDs, while older direct callers remain compatibility-tolerated. The `/agents` UI now combines active and historical sessions across the current cwd in one view, replacing current-parent entries with marker-resolved active-branch checkpoints where available.

```text
Parent session tree
  tiny custom marker = causal reachability and ordering
             |
             v
SQLite
  immutable run instance + immutable run snapshot
             |
             v
Child session JSONL tree
  transcript file + exact child leaf ID
```

In concise terms:

- the parent tree determines **which run snapshots are reachable on a parent branch**;
- SQLite stores the immutable, structured snapshot payloads referenced by those markers;
- the child JSONL tree stores the model/tool conversation;
- every resumable snapshot identifies an exact child transcript leaf;
- each physical run has exactly one continuation head across the parent session;
- older branch checkpoints remain inspectable but cannot be resumed after the run continued elsewhere;
- the global run catalog remains a lossy query projection, not restoration authority.

This preserves unrestricted `/tree` navigation without supporting divergent continuations of one physical child, cloning child transcript files, or placing large run-state payloads in the parent JSONL. The system does not need to make every historical snapshot resumable: older snapshots exist for causality and inspection only; the session head is the sole continuation point.

Current status: the core V2 design and its high-value persistence/browser tests are implemented. The active-branch-only historical-browser recommendation below is superseded by the intentional unified cwd-wide Agents view. Payload minimization, garbage collection, and broader crash/restart matrices remain deferred hardening work, not correctness blockers.

## Compatibility decision

There is intentionally no migration requirement for either experimental predecessor:

- old parent custom entries such as `pi-coder:agent-run-state-v1` are ignored;
- current experimental `agent_run_states` rows that lack the new marker/snapshot identity and child leaf are ignored or removed;
- no old delegated agents need to remain resumable;
- terminal metadata from incompatible formats may be shown only if independently safe, but it must never be resumed by guessing.

The new marker type, snapshot schema, and payload version should therefore start cleanly.

A future schema migration/version policy remains optional hardening. The current snapshots carry an explicit payload version, and incompatible or invalid resumable snapshots fail with diagnostics rather than silently selecting another transcript state.

## What durable state is for

Durable state supports:

- restoring waiting agents after reload or restart;
- converting crashed `starting` or `running` agents into explicit `interrupted` agents;
- resuming interrupted or waiting children only after user action;
- retaining uncollected background terminal outcomes;
- reconnecting parent lifecycle state to a child transcript and workspace;
- preserving enough usage and mutation information for correct reporting and safe worker recovery;
- browsing historical transcripts through `/agents`.

The three persistence domains have different responsibilities:

```text
Parent tree
  causal branch history: which run snapshot existed at this parent point?

SQLite
  structured immutable run metadata and query projections

Child transcript
  child model/tool conversation and its own branch history
```

None of the three can replace the others without losing required semantics.

## Why the current SQLite upsert design is incorrect

The current implementation writes one state row per:

```text
(owner_session_id, run_id, branch_entry_id)
```

The branch entry is obtained from the current parent `SessionManager.getLeafId()`.

During one parent `agent` tool call, the parent leaf can remain the assistant tool-calling message while the child passes through several states:

```text
parent assistant tool call is durable
  child created
  child starting
  child running
  child waiting_for_parent
parent tool result becomes durable later
```

All of those state saves can therefore use the same parent leaf and overwrite the same SQLite row.

The result is causally incorrect: selecting the assistant tool-call entry, which occurred before the parent received the waiting result, can restore the later `waiting_for_parent` state.

A parent branch entry ID is a location in the parent tree. It is not a temporal sequence number for asynchronous extension state.

Timestamp guards do not solve this. They only choose which payload wins after the distinct causal states have already been collapsed into one key. Equal `Date.now()` values also make timestamp ordering ambiguous.

## Why `childSessionLeafId` alone is insufficient

Persisting an exact child leaf fixes shared child-transcript contamination, but it does not create a missing parent-tree boundary.

For example, if `starting`, `running`, and `waiting_for_parent` all overwrite the row attached to one parent assistant entry, adding a child leaf merely makes that incorrectly selected waiting state point to the correct waiting child leaf. The parent still sees future state at an earlier parent-tree point.

Correctness requires both:

1. a distinct parent-tree marker for each committed parent-visible checkpoint;
2. an exact child transcript leaf in the referenced immutable snapshot.

## Selected architecture

### Parent custom markers

Each committed checkpoint appends a small custom entry to the parent session tree. A marker should contain only identity and validation data, for example:

```ts
interface AgentRunSnapshotMarkerV2 {
    version: 2;
    snapshotId: string;
    runInstanceId: string;
    runId: string;
}
```

The custom entry type should be new and should not reuse the legacy entry identifier.

The marker is the causal commit point. Its position in the parent tree determines whether the snapshot is visible on a branch.

Restoration walks the active parent branch in order and keeps the latest reachable marker for each run instance. A SQLite snapshot that has no reachable parent marker is not part of parent state.

### Single-continuation invariant

A physical run may be resumed only from its latest committed marker anywhere in the owning parent session.

For each run instance, restoration determines both:

```text
branchHead  = latest valid marker reachable from the active parent leaf
sessionHead = latest valid committed marker anywhere in the parent session tree
```

The run is actionable only when `branchHead.snapshotId === sessionHead.snapshotId` and the status itself is resumable. If the IDs differ, the active branch contains historical state that has already continued on another branch.

A stale checkpoint remains available for transcript inspection, but it belongs in Past and must not be installed as a resumable manager run. The UI should describe it as “continued on another branch.” The user can navigate to the branch containing the session head or start a new physical agent; resuming the stale run is not allowed.

The session head should be derived from valid parent markers in append order, not from the lossy catalog. A SQLite snapshot without a marker cannot become the continuation head. V2 now also maintains a SQLite continuation-head CAS row and short-lived lease: competing processes serialize the checkpoint transaction and a stale expected head is rejected before continuation.

This policy prevents sibling parent branches from creating competing child continuations and substantially reduces child JSONL ambiguity. It also means restoration does not need to reconcile multiple valid resumable child leaves: it validates and selects the leaf only for the session head, while stale leaves are used solely for read-only transcript inspection.

### Internal run-instance identity

The user-facing run ID, such as `scout-1`, is not a safe database identity by itself.

A parent can branch to a point before `scout-1` was created and create another branch-local `scout-1`. Those are different physical runs even though they have the same owner session and display ID.

Every physical run should therefore receive an immutable internal UUID:

```text
runInstanceId = globally unique physical run identity
runId         = branch-local user-facing action ID
```

SQLite primary and foreign keys should use `runInstanceId`. Parent actions may accept the concise `runId` at the user-facing boundary, but must reject ambiguity and authorize workspace leases/results with the resolved physical `runInstanceId`.

This avoids collisions between sibling branches in snapshots, child transcript metadata, catalogs, and workspace records.

### Normalized immutable SQLite storage

Rather than storing the entire run as one opaque `state_json`, split stable run identity from changing snapshots.

A proposed shape is:

```text
agent_run_instances
  run_instance_id       primary key
  owner_session_id
  run_id                 user-facing display ID
  title
  agent
  agent_source
  agent_file_path
  definition_fingerprint
  task
  background
  mutating
  workspace_id
  parent_cwd
  execution_cwd
  started_at

agent_run_snapshots
  snapshot_id            primary key
  run_instance_id        foreign key
  payload_version
  status
  child_session_file
  child_session_leaf_id
  updated_at
  question_json
  progress_json
  usage_checkpoint_json
  usage_snapshot_json
  terminal_content
  terminal_error
  terminal_is_error
  mutation_report_json
  created_sequence       database ordering/debugging only
```

The exact columns can be refined, but the important split is:

- stable task/definition/run identity is written once;
- dynamic lifecycle state is stored in immutable snapshots;
- structured nested values remain bounded JSON where relational decomposition has little query value;
- fields needed for validation, joins, browsing, and transcript selection are proper columns.

This provides useful schema migrations without normalizing every nested progress or usage field into many low-value columns.

### Snapshot variants and payload size

The current implementation validates bounded snapshot identity, paths, status, and child-leaf references. It stores the bounded `PersistedAgentRun` payload in each immutable snapshot for correctness and simpler recovery.

Status-aware payload variants and moving stable fields entirely out of repeated payloads would reduce storage overhead, but are deferred optimization work. Progress and terminal text remain bounded, so payload growth does not affect branch correctness.

### Catalog projection

`agent_runs` should remain a query-oriented projection for:

- `/agents` past-session discovery;
- transcript inventory;
- response previews;
- workspace lease reconciliation;
- cross-session browsing.

It must not be used for restoration.

The catalog should use `runInstanceId` as identity. Its status is best understood as the latest globally committed observation for that physical run, not the state of every parent branch.

A branch-local `removed` marker should not necessarily erase the physical transcript from the global catalog. Collection means the run is no longer retained on that parent branch; it does not mean the child transcript never existed.

The active `/agents` view should use the active manager and resolved parent markers. The past view may use the catalog, but must not imply branch-specific state unless it also resolves the relevant parent marker.

## Commit protocol and failure behavior

Parent JSONL appends and SQLite transactions cannot be made physically atomic together. V2 therefore holds a renewable SQLite continuation lease across the active child operation and uses short transactions for each checkpoint. A competing process blocks or rejects as stale.

For a checkpoint whose child state is already durable:

```text
1. Acquire/renew the physical-run continuation lease and compare the expected session head inside `BEGIN IMMEDIATE`.
2. Insert the immutable run instance/snapshot and reserve the new continuation head as `pending`; commit that snapshot reservation.
3. Begin another immediate transaction, renew/verify the lease, append the parent marker, clear `pending`, and update the head/catalog projection while the DB lock is held.
4. If marker/head completion fails, retain the pending barrier until lease expiry; reload reconciles it from marker reachability.
5. Continue holding the lease while the child is active; release it at waiting/terminal state.
```

The parent marker remains the branch restoration record; the SQLite head/lease prevents concurrent writers from producing competing continuations. A failed marker append leaves an unreachable committed snapshot, which is safe to prune later.

### Failure matrix

| Failure point | Result | Recovery |
|---|---|---|
| Child append fails | No snapshot or marker | Report child failure |
| Snapshot insert fails | No parent marker | Existing parent state remains authoritative |
| Parent marker append fails | An unreachable committed snapshot and pending head reservation remain until lease expiry | Existing parent state remains authoritative; reload clears/reconciles the pending barrier; prune later |
| Head/projection commit fails after marker append | Marker and snapshot remain valid; pending head barrier blocks stale writers until reconciliation | Reconcile from parent markers on next load |
| Catalog update fails | Resumption remains valid | Warn and rebuild/reconcile projection later |
| Snapshot referenced by marker is missing | Corrupt checkpoint | Reject with a diagnostic; never guess |
| Child file or leaf is missing | Non-resumable checkpoint | Reject with a diagnostic; never use latest leaf |

A DB-first marker protocol is safe because incomplete writes produce unreachable database rows, not parent markers that point to absent state.

Immutable snapshots eliminate stale snapshot overwrites. Parent marker order, not timestamps, determines branch state. A database insertion sequence can help diagnostics and global catalog ordering, while `updatedAt` remains display metadata.

## Child transcript selection

### The child JSONL remains append-only

The child session format preserves entries with `id` and `parentId`, so an uncommitted crash tail or an old internal branch may remain on disk. That does not make divergent parent-agent continuations a supported feature. The important rule is that reopening a file must not select its latest physical leaf when restoring a specific committed checkpoint.

The session-head snapshot must store the transcript reference as one unit:

```ts
interface ChildTranscriptReference {
    childSessionFile: string;
    childSessionLeafId: string | null;
}
```

`null` explicitly means the child root before any child entry. It must not mean “leaf unknown” or “use latest.” Snapshot versions that do not contain this semantic are incompatible.

### Parent tree switching

Suppose sibling parent branches reference two checkpoints of one physical run. The older checkpoint is historical only:

```text
Parent branch A -> snapshot SA -> child leaf L1
Parent branch B -> snapshot SB -> child leaf L2 (session continuation head)
```

On `/tree` to A:

1. shut down and detach the old manager without writing state at the newly selected parent leaf;
2. scan markers reachable on parent branch A and resolve `SA`;
3. scan valid markers for the run across the session and identify `SB` as the session head;
4. expose `SA` as historical state marked “continued on another branch”;
5. allow transcript inspection at `L1`, but do not install an actionable resumable run.

On `/tree` to B, `branchHead` and `sessionHead` both identify `SB`. If its status is waiting or interrupted, it may be installed as resumable. Before building child context, validate `L2` and explicitly select it. If the stored leaf is `null`, call `resetLeaf()`.

Normal resume therefore continues only from the session-head child leaf. It never intentionally creates a sibling continuation from an older parent checkpoint. If an uncommitted crash tail exists, recovery may append from the last committed leaf, but that is a repair of the one continuation head—not a continuation of the stale parent branch.

### Never use the latest child leaf as fallback

`SessionManager.open()` reconstructs a default leaf from the latest appended entry. That default is unsafe for branch-specific restoration.

All restoration paths must immediately branch or reset using the snapshot reference before any of the following:

- building child session context;
- resolving the restored model from child context;
- computing branch usage;
- repairing interrupted tool calls;
- resuming the child;
- displaying a branch-specific transcript.

An absent or invalid leaf is a hard diagnostic for resumption.

### Interrupted tool-call repair

Current restoration repairs unmatched tool calls immediately after opening the child file. That can mutate the wrong child branch and means passive `/tree` browsing changes history.

The corrected rule is:

1. select and validate the snapshot’s child leaf;
2. restore the run without mutating the child transcript;
3. on explicit `resume`, repair unmatched calls on that selected child branch;
4. persist the resulting repaired child leaf and parent marker before continuing.

Repair should never happen against `SessionManager.open()`’s default latest leaf.

### Durable child checkpoint timing

A snapshot may reference only a child entry that has already been appended to the child JSONL.

Pi emits child `message_end` listeners before its internal `SessionManager.appendMessage()` call. Therefore an ordinary `message_end` callback cannot immediately assume the new leaf is durable. The implementation needs an explicit post-persistence checkpoint mechanism, or must schedule/read the leaf only after the append has completed.

Checkpoints should occur at meaningful durable boundaries, not token updates:

- child session materialization;
- operation start once the relevant child prompt boundary is durable;
- durable assistant/tool-result message boundaries when needed for crash recovery;
- mutation checkpoints where uncertain filesystem effects matter;
- `waiting_for_parent`;
- terminal completion/failure/cancellation;
- graceful interruption/shutdown;
- explicit removal/collection.

A crash between a child append and its parent marker can leave an unreferenced child tail. Restoration must ignore that tail. Losing uncommitted progress is safer than attaching a sibling branch or assuming an uncertain tool completed.

## Transcript browser behavior

Every transcript reader must become leaf-aware.

### Default scope policy

The implemented `/agents` view intentionally combines historical sessions across the current cwd. This supports unified browsing without making historical entries resumable.

```text
Current
  live and restored runs from the active parent runtime

Past
  cwd-wide historical child sessions from the durable catalog
  with current-parent matching files replaced by marker-resolved checkpoints

Active-parent checkpoint view
  exact marker/snapshot/child-leaf selection
  stale checkpoints remain read-only and are labeled continued elsewhere
```

The catalog remains a projection for cwd-wide discovery, while restoration authority remains with parent markers and validated snapshots. This is a deliberate product choice rather than the earlier active-branch-only archive policy. Orphan files may remain retained for inspection or future cleanup, but they never become resumable state without a valid marker and snapshot.

### Current runs

Current manager/browser items should carry both child file and child leaf. Transcript formatting should use:

```text
SessionManager.open(file)
SessionManager.branch(leaf) or resetLeaf()
SessionManager.getBranch()
```

It must not call `getBranch()` directly on the default latest leaf.

### Historical runs

Historical entries must resolve a specific committed parent marker/snapshot and show only its child leaf. A stale branch checkpoint is read-only and should be labeled “continued on another branch” when its snapshot differs from the physical run’s session head.

A generic child file may still contain an uncommitted crash tail or internal branches. The browser must not present its latest physically appended leaf as the state of a parent checkpoint. An explicit future child-tree browser may expose those branches diagnostically, but normal history remains snapshot-leaf based.

The catalog may store the latest committed `snapshotId` for physical-run browsing, while active-branch views always resolve parent markers and compare the branch head with the session head.

## Parent lifecycle and `/tree`

Tree navigation remains blocked only while a child is actively streaming or waiting on mutation permission. General `/tree` blocking is not acceptable and is not part of this design.

For a permitted tree switch:

1. complete any marker/catalog operation already in progress;
2. detach persistence for the old manager;
3. dispose the old child handles without appending shutdown state to the new parent leaf;
4. create a new manager;
5. resolve markers from the selected parent branch;
6. compare each branch head with the physical run’s session-wide continuation head;
7. expose superseded branch checkpoints as read-only Past entries;
8. restore exact child leaves for actionable heads without transcript repair;
9. wait for explicit user action before resuming interrupted children.

Waiting and interrupted children are quiescent, so the session continuation head should already identify its exact committed child leaf before tree navigation begins.

## Filesystem and workspace caveat

Parent and child transcript trees do not roll back the filesystem.

Navigating to a point before a same-checkout worker mutation does not undo that mutation. Isolated worker worktrees also retain their physical state independently of transcript selection.

Persisted mutation reports, workspace leases, and interrupted-resume guidance therefore remain necessary. A resumed worker must inspect current filesystem/worktree state and must never assume that an uncommitted or interrupted tool had no effect.

This limitation is orthogonal to transcript persistence and cannot be solved by SQLite or session branching alone.

## Garbage collection

Immutable snapshots and child session trees are append-only, so they require an explicit retention policy eventually.

Potential garbage includes:

- SQLite snapshots inserted before a parent marker append failed;
- run instances with no reachable markers;
- child transcript tails not referenced by any committed snapshot;
- child files belonging to deleted parent sessions;
- old terminal snapshots superseded on all retained parent branches.

Garbage collection must be conservative. It should not remove a snapshot or child entry merely because it is not on the currently active branch; sibling parent branches may still reference it.

A safe first release can retain orphans and defer pruning. Correctness is more important than immediate reclamation.

## Proposed restoration algorithm

```text
load the parent active branch and all parent-session entries
collect and validate v2 snapshot markers
for each run instance:
  branchHead  = last marker reachable on the active branch
  sessionHead = last committed marker in parent-session append order
fetch referenced snapshots and run instances in one SQLite query
for each branchHead:
  validate owner session, run identity, payload version, paths, and status
  if branchHead differs from sessionHead:
    expose historical read-only state marked continued elsewhere
  else if removed:
    omit from active manager and retain as branch history
  else if terminal:
    restore bounded retained result without resuming
  otherwise:
    require child file and explicit child leaf semantic
    open child session
    branch/reset to stored leaf
    validate current definition and mutation authority
    install waiting/interrupted run without repairing or prompting
```

`starting` and `running` snapshots restore as `interrupted`. They never automatically replay.

## Test requirements

### Parent causal ordering

- Multiple snapshots during one parent tool call produce distinct parent markers.
- Selecting the assistant tool-call entry does not see a later waiting snapshot.
- Selecting the subsequent tool result does see the waiting snapshot.
- A sibling branch resolves only markers on its ancestry.
- A branch-local removed marker remains visible as branch history without rewriting sibling markers.
- Sibling branches may safely contain different physical runs with the same display `runId` because `runInstanceId` differs.
- A branch checkpoint older than the session head is classified as historical and cannot resume.
- Only the branch containing the physical run’s latest committed marker can resume it.

### Child transcript selection

- Two parent branches may reference different historical leaves in one child JSONL.
- Each branch’s transcript inspection selects its referenced child leaf.
- A stale parent checkpoint cannot be resumed or create a sibling child continuation.
- Returning to the session-head branch permits continuation from its committed child leaf.
- Explicit `null` resets the child leaf.
- Missing and foreign child leaf IDs fail safely.
- No code path falls back to the latest child leaf.
- Transcript browser output is limited to the selected child leaf.

### Repair and crash safety

- Interrupted repair runs only after explicit resume.
- Repair affects only the selected child branch.
- A snapshot is not created for a child entry that is not yet durable.
- An unmarked child tail is ignored after recovery.
- Unmatched mutating tool calls become uncertain rather than being replayed.

### Commit protocol

- SQLite insertion failure appends no parent marker.
- Parent marker failure leaves an unreachable committed snapshot but no committed parent marker/head update.
- Catalog failure does not invalidate a committed marker/snapshot.
- A marker referencing a missing snapshot produces a diagnostic.
- State snapshots are immutable and cannot be overwritten by equal timestamps.

### Lifecycle and browser

- Active browser entries use the active snapshot leaf.
- Unified cwd-wide Past entries retain historical sessions from other parent sessions.
- Current-parent matching files are replaced by exact marker/snapshot/leaf checkpoints.
- Past catalog entries are clearly distinguished from branch-resolved entries.
- Historical entries remain read-only regardless of browser scope.
- Real `session_tree` restoration and old-manager detachment are covered by the lifecycle persistence integration test.
- Workspace lease reconciliation uses physical run-instance identity.

## Implementation outline

1. Add internal `runInstanceId` to manager, persistence, catalog, workspace, and browser contracts.
2. Add normalized `agent_run_instances` and immutable `agent_run_snapshots` migrations.
3. Define and validate the new small parent marker payload.
4. Replace branch-keyed state upserts with the expected-head continuation transaction: lease/CAS check, snapshot insertion, marker append, head update, and commit.
5. Remove restoration authority from `agent_run_states` and eventually drop or leave the experimental table unused.
6. Add `childSessionLeafId` to child factory/handle and snapshot contracts.
7. Compute both active-branch and session-wide continuation heads for every physical run.
8. Classify superseded branch checkpoints as read-only history and reject resume actions for them.
9. Select the stored child leaf immediately after opening and before context construction.
10. Defer interrupted repair until explicit resume.
11. Capture child leaves only after settled child operations and before terminal/disposal persistence; add an explicit SDK callback later if post-append timing requires it.
12. Make current and historical transcript readers leaf-aware.
13. Keep the unified Agents view marker-resolved for current-parent active-branch runs while showing durable historical sessions across the cwd without losing physical run and child-leaf identity.
14. Change the catalog to physical `runInstanceId` identity and document it as a projection.
15. Add stale-resume, sibling-parent, child-leaf, browser-merge, commit-failure, interrupted-repair, and `session_tree` lifecycle tests. Broader crash/restart matrix coverage remains optional follow-up work.
16. Update delegated-agent documentation and project memories after implementation.

## Final recommendation

Proceed with lightweight parent markers backed by normalized immutable SQLite snapshots.

The non-negotiable invariants are:

- parent marker reachability defines parent branch state;
- marker order, not timestamps, defines causal order;
- snapshots are immutable;
- physical runs have UUID instance identities independent of branch-local display IDs;
- child transcript references always include an exact leaf;
- each physical run has one session-wide continuation head;
- only a branch whose head equals that continuation head may resume the run;
- stale branch checkpoints remain inspectable but read-only;
- branch selection occurs before context construction, repair, resume, or transcript display;
- parent marker append is the commit point;
- catalog data is a rebuildable projection and never restoration authority;
- incompatible or missing state is rejected rather than guessed.
