# Delegated-agent persistence investigation

## Scope

This note captures the current findings around delegated-agent persistence, resumption, SQLite storage, parent-session tree navigation, and child transcript branching.

## Original purpose of persistence

Durable run state exists primarily to support lifecycle recovery:

- restore delegated runs after a parent session reload or restart;
- reopen waiting children;
- mark crashed `starting`/`running` children as interrupted;
- allow explicit resume of interrupted or waiting runs;
- reconnect parent-side metadata to the child transcript;
- preserve usage, questions, progress, mutation state, and retained terminal results for `/agents`.

The parent-side record and child transcript serve different purposes:

```text
Parent run state
  status, task, definition identity, question, usage, workspace, transcript path

Child transcript
  actual model/tool conversation needed to continue the child
```

Normal in-process execution does not need durable persistence. Persistence matters when the process/session lifecycle interrupts the run or when past runs are browsed later.

## Storage history

### Previous design: parent-session custom entries

Run-state snapshots were appended to the parent Pi session JSONL as custom entries:

```text
pi-coder:agent-run-state-v1
```

This naturally followed the parent session tree, but had drawbacks:

- every state update increased the parent JSONL size;
- restoring required replaying the active parent branch;
- run-state storage was coupled to Pi session history;
- querying and cross-session browsing were awkward;
- the run state was not a normal database record.

### Current design: SQLite

The current implementation stores state in the extension-local SQLite database:

```text
<pi-coder-install>/.state/meta.sqlite
```

The schema contains:

- `agent_runs`: a lossy, query-oriented catalog projection used for past-run browsing;
- `agent_run_states`: authoritative state snapshots keyed by:
  - owner parent session;
  - run ID;
  - parent branch entry ID.

Child transcripts remain SDK JSONL files under:

```text
<pi-coder-install>/.state/agent-sessions/
  --<encoded-cwd>--/
    <parent-session-id>/
      <child-session-jsonl>
```

Current saves use one session-scoped synchronous `DatabaseSync` connection. State and catalog projection updates are written transactionally. Saves return failure immediately if the connection is closed or the transaction fails. Timestamp guards reject older snapshots, although equal timestamps and stronger revisions remain an open consideration.

## Legacy compatibility decision

There is intentionally **no migration requirement** for the old parent-session custom-entry format.

That means:

- old `pi-coder:agent-run-state-v1` entries are ignored;
- old resumable children are allowed to become unavailable;
- no import or fallback path is needed for those entries;
- this is acceptable because there are currently no agents that need preservation.

This is distinct from future state-payload evolution inside SQLite. A future payload version still needs an explicit policy.

## Current state-size question

`PersistedAgentRun` currently combines three categories of information.

### Strict resumption/recovery data

These are needed to safely reconstruct an active or waiting run:

- `ownerSessionId`;
- `runId`;
- agent name/source and definition fingerprint;
- task/title;
- status/background state;
- question for `waiting_for_parent`;
- child transcript path;
- parent and execution cwd;
- workspace ID and mutation authority;
- usage checkpoint;
- mutation report;
- timestamps.

### UI continuity data

These make restored runs look continuous in `/agents`:

- progress output;
- recent activity;
- phase and last tool activity;
- usage snapshot;
- timestamps.

### Retained terminal-result data

These support keeping completed/failed background outcomes visible without reopening the child:

- terminal content;
- terminal error;
- terminal error flag;
- source/file metadata for past-run presentation.

Therefore the current full JSON snapshot is conservative. It is not all strictly required to resume a live child. The state blob is cohesive and bounded, but it overlaps with the catalog projection.

The reviewer’s recommendation was to keep a bounded full `PersistedAgentRun` JSON snapshot in `agent_run_states`: fully normalizing the nested state would introduce more migrations and joins without obviously improving restore safety. The catalog should remain explicitly lossy and non-authoritative.

A possible future split would be:

```text
agent_run_states
  minimal branch-scoped resume envelope

agent_runs
  query-oriented catalog and retained terminal metadata
```

That would reduce duplication, but it also creates two models and more synchronization rules.

## Parent tree and SQLite state

The parent session tree is a real branch DAG. Parent-tree navigation cannot be blocked as a general policy.

Current SQLite state is branch-aware by associating snapshots with parent branch entry IDs and selecting snapshots whose entry IDs are on the active branch. This preserves parent-side state selection, but it does not by itself isolate the child transcript.

A state snapshot can exist on a common parent ancestor and therefore be visible from sibling parent branches. If a waiting/interrupted run is resumed on sibling branch B, the current implementation reuses the same child JSONL file. Returning to sibling A could then encounter a transcript advanced by B.

This is the main unresolved correctness issue.

## Proposed child-transcript solution

The child Pi session itself has a tree and a leaf pointer. Instead of cloning child JSONL files, persist the child leaf associated with each parent state snapshot:

```text
parent branch entry
  -> run state snapshot
      -> childSessionFile
      -> childSessionLeafId
```

On save:

- capture the current child session leaf ID;
- store it with the parent state snapshot.

On restore:

- open the shared child JSONL file;
- if the stored leaf ID is non-null, branch the child `SessionManager` to that leaf;
- if the stored leaf ID is null, reset the child leaf to the pre-message root state;
- continue the child from that exact child-tree point.

Example:

```text
Parent branch A state -> child leaf L1
Parent branches to B
B resumes -> child branches from L1 to L2
A is selected again
A restores -> child branches back to L1
```

The child JSONL remains one append-only tree, but each parent branch resumes from the correct child node.

A missing or invalid child leaf must fail safely. It must not silently use the transcript’s latest leaf, because the latest leaf may belong to another parent branch.

## Child-leaf payload compatibility

Adding `childSessionLeafId` creates a new resumable payload shape.

Because legacy migration is intentionally out of scope:

- old parent custom-entry records remain ignored;
- current SQLite snapshots created before the leaf field should not be guessed or backfilled;
- terminal snapshots can still be retained for browsing without a leaf;
- active, waiting, or interrupted snapshots missing the leaf should be rejected with a diagnostic;
- new snapshots should include the field, including `null` for a child with no messages yet.

A useful policy is:

```text
payload v1 without childSessionLeafId
  terminal       -> display only
  resumable      -> reject safely

payload v2 with childSessionLeafId
  resumable      -> restore from the exact child leaf
```

This is a payload-version policy, not a migration of the old parent-session entry format.

## Catalog consistency question

`agent_run_states` is branch-specific, but `agent_runs` is keyed only by `(owner_session_id, run_id)`. Therefore the catalog cannot represent divergent sibling-branch metadata independently.

The intended interpretation should be explicit:

- `agent_run_states` is authoritative for restoration;
- `agent_runs` is a lossy global browse/index projection;
- catalog values must not be used to decide which branch state to resume.

If `/agents` needs branch-specific historical metadata, the catalog would need a branch key too. Otherwise it should be treated as “latest observed projection” only.

There is also a potential consistency concern if state and catalog writes are allowed to make independent stale decisions. Current transactional writes and timestamp guards reduce this risk, but a monotonic revision/generation would be stronger than `Date.now()` alone.

## Save and stale-write handling

The persistence API currently has a synchronous `save()` contract. Making it async would require propagating `await` through many manager callbacks and lifecycle paths.

The selected approach is therefore:

- initialize a long-lived `DatabaseSync` connection during persistence loading;
- make `save()` perform a synchronous transaction;
- return `false` immediately on failure;
- close the connection explicitly during tree switches and shutdown;
- use monotonic application ordering and/or SQL guards to reject stale snapshots.

The current SQL guard uses `updatedAt`. Since `Date.now()` can produce equal values, a future improvement should add a per-run monotonic revision or writer sequence. Timestamps should remain display metadata, not the sole ordering authority.

## Lifecycle and `/tree`

Active running children are already protected by the `session_before_tree` guard. Waiting/interrupted runs may still be present when `/tree` occurs.

The current lifecycle handling now:

1. flushes pending writes for the old persistence writer;
2. closes the old database connection;
3. detaches persistence before shutdown;
4. avoids recording shutdown state at the newly selected branch leaf;
5. creates a new manager and restores state for the selected parent branch.

This prevents queued old-branch writes from being lost, but it does not solve shared child-transcript continuation. The child leaf pointer is intended to solve that remaining issue.

## Test coverage currently present

Existing tests cover:

- SQLite state loading;
- parent-session ownership;
- active branch filtering in a linear synthetic branch;
- transcript path confinement;
- synchronous save/reload;
- closed-storage save failure;
- stale timestamp ordering;
- catalog projection;
- child transcript discovery and browsing.

Important missing tests include:

- sibling parent-branch resume using a shared child transcript;
- saving and restoring `childSessionLeafId`;
- branching a child session to a saved leaf before resume;
- invalid/missing child leaf diagnostics;
- terminal snapshots without a child leaf;
- equal-timestamp or multi-writer ordering;
- rollback atomicity for state plus catalog;
- full lifecycle `/tree` and shutdown behavior with real persistence objects;
- future payload-version handling.

## Main decision points for follow-up

1. Add `childSessionLeafId` and use the child session tree for safe branch-specific resume.
2. Decide whether to keep the full JSON resume envelope or split minimal resume state from catalog/terminal metadata.
3. Decide whether the catalog is intentionally a global lossy projection or must become branch-specific.
4. Add a monotonic revision separate from display timestamps.
5. Define the future SQLite payload-version policy: retain decoders, migrate blobs, or reject incompatible resumable state.
