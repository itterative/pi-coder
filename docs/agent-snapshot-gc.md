# Delegated-agent snapshot GC — design plan

Status: **steps 1–2 of §11 landed 2026-09-02; steps 3–7 remain.** Design was agreed in
`docs/agent-snapshot-gc.md` review; measurements are against `.state/meta.sqlite` of this checkout. Resolve
relative paths against the project root.

**Chosen direction (F′): keep at most one intermediate snapshot row per physical run, in a dedicated
non-authoritative "working state" table, and clear it at every checkpoint.**

- A **checkpoint** save (ask_user/`ask_parent` park, cancel, terminal outcome, removal tombstone,
  interruption/park, resume, accepted start, pre-execution) keeps today's behavior exactly: immutable row in
  `agent_run_snapshots` + parent-tree marker + continuation-head advance + catalog projection.
- An **intermediate** save (child progress / transcript-leaf change / file change) writes **one upserted row**
  in `agent_run_working_state` plus the existing in-place `agent_runs` catalog projection. No snapshot row, no
  marker append, no head write, no lease acquisition.
- At each checkpoint commit, the working row for that instance is cleared — this is the literal
  "clean up intermediates since the last checkpoint" rule, reduced from O(messages) deletes to one row.
- The 12,293 legacy intermediate rows are reclaimed by a one-time `DELETE`; the load path learns to tell a
  GC'd marker from a wiped database by inference instead of by stored tombstones.

Rejected variants and why: §10.

## 1. Problem (measured)

`.state/meta.sqlite` is **82.7 MiB** after 11 days of local development.

| table                             | rows   | payload                    |
| --------------------------------- | ------ | -------------------------- |
| `agent_run_snapshots`             | 12,795 | 67.3 MiB of `payload_json` |
| `agent_run_instances`             | 175    | —                          |
| `agent_run_continuation_heads`    | 175    | —                          |
| `agent_runs` (catalog projection) | 261    | ~0.9 MiB                   |
| `agent_run_continuation_leases`   | 0      | —                          |

12,795 snapshot rows for **175 physical runs** — average 73 rows per run, worst case 326
(`3056fbe7-…`: 311 of 326 rows are `running`).

| status               | rows   | bytes    |
| -------------------- | ------ | -------- |
| `running`            | 11,550 | 58.4 MiB |
| `starting`           | 743    | 2.3 MiB  |
| `removed`            | 224    | 2.5 MiB  |
| `completed`          | 219    | 3.7 MiB  |
| `canceled`           | 29     | 0.15 MiB |
| `waiting_for_parent` | 16     | 0.12 MiB |
| `interrupted`        | 11     | 0.10 MiB |
| `failed`             | 3      | 0.02 MiB |

Growth is not marginal: 2026-08-28 alone wrote **4,019 snapshots (3,841 of them `running`/`starting`,
21.1 MiB)** — roughly 1,100 durable saves per day. Concentration is per parent session; the three largest
owners hold 1,824 / 1,605 / 1,106 rows (11.4 / 17.1 / 5.2 MiB).

Two measurements define the target set precisely:

- Of the 12,293 `running`/`starting` rows, **all 12,293 are superseded**: combining
  `row_number() OVER (PARTITION BY run_instance_id ORDER BY created_sequence DESC) = 1` with a
  `running`/`starting` status matches **0 rows** — every run's newest row already carries a checkpoint status.
- **No `agent_run_continuation_heads` row points at a `running`/`starting` snapshot** (0 of 175).

So 60.7 MiB — **90% of the payload** — is already dead under the semantics we want. Each such row is dominated
by `progress.output` plus a duplicated `progress.lastAssistantMessage` (14,264 B each in the worst 33 KiB
row) and a full copy of `task` (up to 8 KiB) that already lives in `agent_run_instances.task`.

## 2. Root cause

`insertAgentRunSnapshotInDatabase()` (`src/tools/agent/storage/run-snapshots.ts:22`) always INSERTs a new
immutable row, and `SqliteAgentRunStateWriter.commitSnapshot()`
(`src/tools/agent/runs/persistence/state-writer.ts:219-247`) always appends the parent marker and advances
the continuation head. The write path has no notion of _why_ it was called, so one byte of new child output
is stored with the same weight as a terminal outcome.

The flood comes from one seam — the child-hook `persist` in `src/tools/agent/runs/manager.ts:160`:

```ts
persist: (run) => {
    void this.persistRun(run);
},
```

which `createChildFactoryContext` (`src/tools/agent/runs/child-setup.ts`) calls at lines 78, 83, and 114:

- `onSessionCreated` — once per run (stays a checkpoint).
- `onFileChanged` — every file-mutation notification.
- `updateTranscriptLeaf` inside `onProgress` — **every settled transcript leaf**, i.e. per tool call / turn.

Every other `persistRun` / `requireDurableCheckpoint` site in `manager.ts` (238, 279, 474, 715, 737, 976,
1134, 1291, 1385, 1458, 1626, 1683, 1822, 1911, 2028, plus the `checkpointOutcome` helper at 1908) is a
lifecycle boundary: accepted start, parked background run, guidance request, resume, settled operation,
interruption/shutdown-park, terminal outcome, removal tombstone, workspace-result attachment. Those keep
writing markers, and they are rare — measured 502 of 12,795 rows.

`AgentWorkspaceCheckpointRequest` already models the distinction as `kind: "intermediate" | "terminal"`
(`src/tools/agent/contracts/runs.ts:259`), so the vocabulary exists — reuse it.

## 3. What constrains deletion

Nothing in the schema. Verified:

- No foreign key references `agent_run_snapshots` (snapshots → `agent_run_instances` is the only FK in the
  family), and `PRAGMA foreign_key_list(agent_run_continuation_heads)` is **empty**: `heads.snapshot_id` is a
  bare pointer whose target's existence is never enforced.
- Both snapshot consumers already tolerate a row that is gone:
    - `presentation/sessions.ts:384-417` (the `/agents` active-branch checkpoint pass) does
      `if (!snapshot?.childSessionFile || !record) continue;` — a missing row silently falls through to the
      next-older marker; `sessionHeads` and the displayed checkpoint come from whatever survives.
    - `runs/persistence/load.ts` falls back the same way in `collectSessionHeads`, `collectBranchHeads`, and
      `resolveActiveRecords`, **but** pushes one diagnostic string per hole (`load.ts:139`, `load.ts:253`:
      `parent marker references a missing SQLite snapshot`).

What does constrain it is that a save currently pins itself with an unremovable marker: every snapshot row
inserted today also gets a `pi-coder:agent-run-snapshot-v2` parent-tree entry, and markers are append-only
(measured 1:1 — owner `01a049ac`: 1,826 markers / 1,824 rows; owner `01a056eb`: 1,608 / 1,605). Consequences:

1. Two markers must never name **one mutable row**: `collectBranchHeads` resolves a branch to whatever the
   newest reachable marker's row says, so a shared, changing row would let an older sibling branch restore a
   newer state. This is the decisive reason the single working row lives in its **own table** (§4.2) rather
   than as a flagged row inside `agent_run_snapshots`.
2. Legacy rows are pinned, so reclaiming them leaves dangling markers. Functionally fine (both readers fall
   back); the only cost is diagnostic noise, which §4.5 removes by inference rather than by storing tombstones.
3. Marker-derived state stays coherent while §4.6's invariants hold.

Secondary cost of the same pinning, fix alongside: `loadAgentRunPersistence` fetches every marker-referenced
row's **full payload** with one `WHERE snapshot_id IN (?, ?, …)`, one placeholder per marker
(`run-snapshots.ts:135-155`). Restoring the largest session today parses 1,824 payloads and the placeholder
count grows with session history. Chunk it (~500 ids per statement).

## 4. Design

### 4.1 Classify every save

Thread an explicit intent from the lifecycle owner to the storage layer, defaulting to _checkpoint_ so a call
site that forgets to classify can never lose state:

```ts
type AgentRunCheckpointIntent = "checkpoint" | "intermediate";
save(record: PersistedAgentRun, intent?: AgentRunCheckpointIntent): Promise<boolean>;
```

- `AgentRunPersistence.save` / `AgentRunStateWriter.save` gain the parameter — a parameter, not a field on
  `PersistedAgentRun`, because it is call intent, not run state, and must not round-trip in `payload_json`.
- `AgentRunCheckpointStore.save(run, status?, intent = "checkpoint")` passes it through
  (`checkpoint-store.ts:93`, projecting in `saveNow` at 148).
- Only the child-hook seam (`manager.ts:160`) and `ChildSetupHooks.persist` pass `intermediate`:
  `onFileChanged` and `updateTranscriptLeaf` become intermediate, `onSessionCreated` stays a checkpoint.
  `checkpointOutcome` (parked background run, guidance request, terminal summary) stays a checkpoint.

### 4.2 The working-state table

New table, migration 17 (§4.7), one row per physical run at most:

```sql
CREATE TABLE IF NOT EXISTS agent_run_working_state (
    run_instance_id     TEXT PRIMARY KEY,
    owner_session_id    TEXT NOT NULL,
    run_id              TEXT NOT NULL,
    status              TEXT NOT NULL,      -- the unclean statuses only: starting | running
    child_session_file  TEXT,
    child_session_leaf_id TEXT,
    progress_json       TEXT NOT NULL,      -- bounded: output tail, recentActivity, toolCounts, phase
    updated_at          INTEGER NOT NULL
);
```

- An intermediate save is one statement:
  `INSERT INTO agent_run_working_state … ON CONFLICT (run_instance_id) DO UPDATE SET …`, plus the existing
  in-place `upsertAgentRunCatalogRecordInDatabase` (`storage/run-catalog.ts:91`) so `/agents` browsing stays
  current. `latest_snapshot_id` in the catalog keeps naming the last committed checkpoint — honest, since the
  checkpoint journal did not move.
- **Verified on the actual runtime binding, not assumed:** the vendored driver reports SQLite **3.52.0**
  (`node_modules/sqlite3` → `select sqlite_version()`), and a partial unique index plus
  `ON CONFLICT (…) WHERE … DO UPDATE` round-trips correctly in it. This design needs only plain
  `PRIMARY KEY` upsert, so it sits well inside that capability; the partial-index form is the alternative if
  we ever want several working rows per instance.
- Bounded by construction: 175 physical runs today ⇒ ≤175 rows of ~1-2 KB.
- `progress_json` deliberately excludes `task`, `definitionSnapshot`, `question`, `terminalContent`, and
  usage — everything in it is re-derivable from the child transcript or already durable elsewhere.
- A checkpoint commit clears it: `DELETE FROM agent_run_working_state WHERE run_instance_id = ?`. Because
  `status` is constrained to the unclean statuses, a leftover row always means "died between checkpoints".
- Best-effort by contract: if this process does not own the continuation lease
  (`ContinuationLeaseLedger.owns`, the predicate `acquireLeaseForSave` consults), drop the write, report
  `{ ok: true }`, and trace `persistence.intermediate_dropped`. Never auto-acquire or release a lease for an
  intermediate write, and never route it through `RefusedWriteReporter`, which would spend the session's one
  user warning on a write that carries no authority. `checkpoint-store.saveNow` keeps refusing when
  `continuationLeaseLost` is set, and `pendingPersistence` registration stays so `waitForPending` still
  fences removal tombstones against in-flight progress writes.

### 4.3 The checkpoint save, plus the per-checkpoint clean

Unchanged insert → marker-append → settle-head → catalog projection (`state-writer.ts:187-247`), then in the
same serialized save queue:

1. clear this instance's working row (§4.2), and
2. as a guard for data written by older binaries, delete this instance's **superseded legacy intermediates**
   — rows strictly below the newly committed head whose status is not checkpoint-worthy:

```sql
DELETE FROM agent_run_snapshots
 WHERE run_instance_id = ?
   AND created_sequence < ?                 -- the checkpoint just committed
   AND snapshot_id <> ?                     -- belt-and-braces: never the new head target
   AND status NOT IN ('waiting_for_parent', 'interrupted', 'completed',
                      'failed', 'aborted', 'canceled', 'removed');
```

Two precision requirements:

- **The rule must be status-aware, not purely positional.** Between two checkpoints of one long run there can
  legitimately sit an earlier checkpoint _of the same instance_ — a `waiting_for_parent` park, a `removed`
  tombstone, or a row that became a sibling branch's head. `collectBranchHeads` still needs those for
  read-only sibling history, so positional range deletion alone would corrupt branch browsing.
- **A prune failure must never fail a committed save**: catch, trace `persistence.gc_failed`, continue. GC is
  reclamation, never correctness.

This guard can never reclaim the backlog by itself: the 12,293 legacy rows belong to runs that are already
terminal and will never write another checkpoint. Hence the one-time sweep in §4.7.

### 4.4 Restoring across the checkpoint gap

The overlay is the one genuinely new mechanism, so keep it narrow and total:

- Load resolves records from markers as today. **After** that, for a record whose resolved status is unclean
  (`running`/`starting`), whose continuation lease is dead, and which is `resumable` on this branch
  (`load.ts:268-274` already computes `resumable` vs `readOnlyReason: "continued on another branch"`), take
  `childSessionLeafId` and `progress` from `agent_run_working_state` when the row exists for that
  `run_instance_id`, its `updated_at` is newer than the checkpoint's, and its leaf is a real entry of that
  exact child transcript.
- Everything else keeps using the checkpoint: clean parks, terminal outcomes, read-only sibling history, and
  any run whose working row was cleared by the next checkpoint. Authority for _branch state_ stays 100% with
  markers; the overlay only sharpens where an interrupted child stopped.
- This restores the exact crash fidelity we have today rather than trading it away: `manager.ts:418-429`
  refuses a V2 resumable record with no exact leaf, and `restore.ts:377` seeds `restoredProgress` from the
  record — both keep working because the overlay fills those two fields from durable storage.
- Contain the decision in one exported function (e.g. `applyWorkingStateOverlay(record, workingRow)`) with an
  `ENABLE_PID_LEASE_RECOVERY`-style kill switch (`persistence/lease-ledger.ts`), so the
  "checkpoint-leaf-only" behavior is one constant away.
- Never resume or replay automatically; the existing explicit-resume-only rule stands.

### 4.5 Superseded markers skip silently

Needed because the legacy backlog is marker-pinned. Replace the unconditional diagnostic with an inference
that needs no stored tombstone:

- Precompute once per load, from the fetched snapshot set: which `run_instance_id`s still have a surviving
  row, and their `MIN(created_sequence)`.
- A marker naming a **missing** row whose instance still has a surviving row is a **reclaimed intermediate** →
  skip it with no diagnostic, letting the branch resolve to the next-older surviving checkpoint. This matches
  what `presentation/sessions.ts:413` already does silently.
- A marker naming a missing row whose instance has **no** surviving row keeps today's hard diagnostic: that is
  the real "database was wiped or never written" case the message exists for, so the fail-fast rule survives.

The asymmetry is deliberate and safe: the inference leans on the surviving journal, so any prune that
respected §4.6's protected set can only ever produce the silent case.

### 4.6 Invariants to preserve

1. **The continuation head always names a surviving, fully valid checkpoint row.** Keeps
   `JournalHeadExpectations.verify()` honest and keeps
   `initializeAgentRunContinuationHeads()`' `excluded.created_sequence > …created_sequence` guard
   (`persistence/journal-heads.ts:19-60`) from downgrading or stranding a head. Corollaries: intermediate
   saves never touch the head, and no prune may delete a head target.
2. **Every row in `agent_run_snapshots` is immutable once its marker is committed** — which is why mutable
   working state is a separate table (§4.2) and why growth is stopped at the writer.
3. **Protected set** for any prune or sweep: the head target of every instance, the newest row of every
   instance, and every row whose status is checkpoint-worthy (§4.3's list). Under §4.2 new runs accumulate no
   rows outside that set at all, so it only ever has to be applied to legacy data and misclassified writes.
4. **`save()` keeps its boolean contract**; only the intermediate path gained best-effort semantics.
5. **Markers never alias a mutable row** (§3.1), so branch-head resolution is unaffected by GC.

### 4.7 Reclaiming the backlog

Migration **17** (highest existing was 16, `storage/metadata.ts:336`) **creates `agent_run_working_state`
only** — schema, no deletes. That is what landed in step 2, and the split is deliberate: a migration that
both changes schema and removes data cannot be reverted without a restore, and the sweep must be reviewable
as a report first (§11 step 6, resolving §9.1). Migrations run serialized under
`migrateSqliteDatabase`'s transaction + `PRAGMA user_version` sequencing (`src/common/sqlite.ts:357-395`).

The bulk `DELETE` is an explicit maintenance action that removes every `agent_run_snapshots` row failing
§4.6's protected set — head target of any instance, newest row of any instance, checkpoint-worthy statuses.
§1 proves this predicate is exactly the 12,293-row / 60.7 MiB intermediate set, and that no head or newest row
is touched, so the sweep cannot strand a journal.

Shrinking the file: `PRAGMA auto_vacuum` is currently `0` (none) with WAL journaling, so deletes only build a
freelist. Measured on a copy of the live database, `VACUUM` took **0.086 s** and reclaimed 82.7 MiB →
14.6 MiB (the stub variant), `integrity_check` ok — cheap at this size, but exclusive-write and growing with
the database, so never per prune pass. `VACUUM` cannot run inside a transaction, so the maintenance action
runs it after its delete transaction, and enabling `auto_vacuum = INCREMENTAL` there (which itself needs one
full `VACUUM`) means later prunes never need a manual one.

Because the sweep, the §4.3 per-checkpoint guard, and any future maintenance command must apply the _same_
protected-set predicate, express it once (`pruneAgentRunSnapshotsInDatabase`, §6) and call it from all three,
so the paths cannot drift.

### 4.8 Where per-run persistence state lives, and what this change consolidates

There is no single persistence coordinator today. One run's persistence status is stated in four durable and
in-process places at once, across **three identity spaces**:

| owner                                                                                              | per-run state                                                                                                                                        | key             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `AgentRun` (`runs/run-state.ts:31-103`)                                                            | `childSessionLeafId`, `childSessionFile`, `status`, `resumable`, `continuationLease`, `continuationLeaseLost`, `usageCheckpoint`, `restoredProgress` | logical `id`    |
| `AgentRunRegistry.runs` (`runs/registry.ts:11`)                                                    | live ownership, terminal retention                                                                                                                   | `runId`         |
| `AgentRunCheckpointStore.persistedRuns` / `.pendingPersistence` (`runs/checkpoint-store.ts:18-19`) | last successfully written record; in-flight write fence for removal tombstones                                                                       | `runId`         |
| `JournalHeadExpectations.expected` / `.known` (`persistence/journal-heads.ts:77-78`)               | **which checkpoint we believe is head** (CAS)                                                                                                        | `runInstanceId` |
| `ContinuationLeaseLedger.active` / `.lost` (`persistence/lease-ledger.ts:46-47`)                   | lease claim + sticky loss                                                                                                                            | `runInstanceId` |
| `SqliteAgentRunStateWriter.saveTail` / `.pendingAcquisitions`                                      | save serialization (global by design)                                                                                                                | promise chain   |

The durable tables split the same way: `agent_run_continuation_heads` (`snapshot_id`, `created_sequence`,
`pending`) is the durable "which checkpoint", `agent_run_continuation_leases` the durable lease, `agent_runs`
the lossy projection, and `workspace_checkpoints` / `workspace_results` a fifth per-run persistence home keyed
by `workspaceId` + `runInstanceId`.

The split is not accidental: `AgentRunLeaseCoordinator` and `AgentRunCheckpointStore` each carry a doc comment
saying they deliberately do not decide _when_ persistence happens, and `AGENTS.md` requires keeping the
collaborator split. But this change adds three more per-run facts (last intent, what we believe the working row
holds, pruned-through point), which is a good trigger to give the **journal** view one owner instead of four.

**Consolidate: one `AgentRunJournalState`, owned by the writer, keyed by `runInstanceId`.**

```ts
type AgentRunWorkingStatus = "starting" | "running";

interface RunJournalEntry {
    head?: string; // absorbed from JournalHeadExpectations; step 3 adds lastIntent and working
}
```

- It **absorbs `JournalHeadExpectations`** rather than wrapping it. As landed, `expected` + `known` became one
  `Map<runInstanceId, { head?: string }>` where **entry presence** is the "already looked" flag and
  `head: undefined` means "looked, the row was empty" — a separate `headAdopted` boolean was dropped because
  it would have been a second source of truth for the same fact. The adopt-on-first-read rule is unchanged:
  the first look records whatever the row holds, every later read must agree.
- The `runId ↔ runInstanceId` index **did not move here** (deviation from the first draft of §11 step 1): the
  journal is private to `SqliteAgentRunStateWriter`, so reaching it from `manager.ts:229` would mean routing
  identity resolution through the persistence facade — new indirection, no state actually consolidated, and
  `AgentRunJournalState` would have to start tracking runs it never writes to. The two-source precedence
  (registry, then checkpoint cache) stays where it is, as one expression.
- `agent_run_continuation_heads` stays the durable authority; the entry is this process's _belief_ about it.
  Preserve the documented asymmetry: after a marker-append failure the writer still reports success and adopts
  the snapshot as head, because the parent transcript already references it.
- The manager and `AgentRunCheckpointStore` ask it questions ("is this run at checkpoint S?", "did the last save
  land as intermediate?"); no other in-process reader consults `agent_run_continuation_heads` to answer a local
  question.

**Explicitly do not merge:**

1. `ContinuationLeaseLedger` — keep it separate and _reference_ it (`ownsLease(runInstanceId)`); never absorb
   its timers or sticky lost-set. Its "drop the in-process claim before awaiting the `DELETE`" ordering is a
   live TOCTOU fix asserted by `test/tools/agent-persistence-v2.test.ts` ("persists a save whose lease was
   released in the same turn") after having reproduced only under CPU starvation; a merged class makes that
   ordering easy to silently undo. `run.continuationLease` / `run.continuationLeaseLost` also stay on `AgentRun`,
   because the on-loss callback needs the run object to abort it.
2. `AgentRunCheckpointStore.persistedRuns` — different key space (`runId`), different job (project a live run
   into a record; fence removal against in-flight saves), different reset trigger: `replace()` /
   `setPersistence()` clear it on restore and branch switch, while journal expectations must survive a full
   save/commit cycle.
3. `saveTail` — one global queue is intentional; per-run queues would reorder against SQLite's single
   `IMMEDIATE` write lock while pretending to add concurrency.

This is the codebase's established remedy for scattered captured state: `createAgentRunStateWriter` was the same
"assembled" case and became a class whose fields are the state clusters, each ordering invariant documented
above the one method that enforces it (see the `complexity-hotspots` memory). The test is that
`AgentRunJournalState` must own real state — if it ends up a pass-through over the heads table, prefer two maps
and a comment over an indirection layer, per that memory's ban on tiny wrappers.

Validation addition (§7.8): assert the journal entry and `agent_run_continuation_heads` cannot disagree after
(a) a committed save, (b) a marker-append failure, and (c) a lost lease — the three paths where the in-process
belief updates without a straightforward successful write.

## 5. Reclamation math

Measured rows are marked ✅ (copy of the live database, never written back); estimated rows say so and are
**not** yet verified.

| state                                                                | payload  | file                             |
| -------------------------------------------------------------------- | -------- | -------------------------------- |
| today                                                                | 67.3 MiB | 82.7 MiB ✅                      |
| stub superseded rows in place (rejected — see §10)                   | 7.3 MiB  | 14.6 MiB ✅                      |
| delete superseded rows, ids kept in a `pruned(snapshot_id)` registry | 6.6 MiB  | 9.8 MiB ✅ (registry = 1.1 MiB)  |
| delete superseded rows, **no** registry — §4.5 infers instead        | 6.6 MiB  | ~8.7 MiB (estimated, unverified) |
| additionally drop the 224 `removed` tombstone payloads (2.5 MiB)     | ~4.1 MiB | unverified                       |

Steady state under §4.2–§4.3 is flat by construction: `agent_run_snapshots` holds checkpoints only (today's
502 checkpoint rows across 175 runs average ~13 KiB each) and `agent_run_working_state` holds ≤1 row per live
run. Per-checkpoint row size, not row count, is then what remains to attack — §9.4.

## 6. Implementation surface

| File                                                                                                     | Change                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/tools/agent/contracts/runs.ts`                                                                      | `AgentRunCheckpointIntent`; `AgentRunPersistence.save(record, intent?)`; a `AgentRunWorkingState` record type                                                                                                                                                                                                |
| `src/tools/agent/storage/metadata.ts`                                                                    | migration 17: create `agent_run_working_state`; run the backlog sweep through the shared prune helper; deferred-VACUUM decision (§4.7)                                                                                                                                                                       |
| `src/tools/agent/storage/run-snapshots.ts`                                                               | `pruneAgentRunSnapshotsInDatabase(db, { runInstanceId, headSnapshotId, throughSequence })` implementing the §4.6 protected set; chunk the `IN (...)` in `listAgentRunSnapshotsInDatabase` (~500/statement); new `storage/run-working-state.ts` for the upsert/read/clear                                     |
| `src/tools/agent/runs/persistence/state-writer.ts`                                                       | branch on intent: intermediate = working-state upsert + catalog projection (no lease churn, best-effort when the lease is not ours); checkpoint = existing reserve/commit + §4.3 clear-and-prune                                                                                                             |
| `src/tools/agent/runs/persistence/journal-heads.ts`                                                      | `JournalHeadExpectations` grows into `AgentRunJournalState` (§4.8): one entry per `runInstanceId` with head + `headAdopted` + `lastIntent` + working-row belief + the `runId <-> runInstanceId` index; keep the exported `HeadRow`/`snapshotIdOf` shapes and `initializeAgentRunContinuationHeads` unchanged |
| `src/tools/agent/runs/persistence/load.ts`                                                               | §4.5 silent skip in `SnapshotValidator.recordFor` and `resolveActiveRecords`; surviving-instance predicate computed once; §4.4 overlay applied after marker resolution                                                                                                                                       |
| `src/tools/agent/runs/checkpoint-store.ts`                                                               | pass intent through `save`/`saveNow`; keep "the manager decides when a checkpoint is required" as this file's stated contract                                                                                                                                                                                |
| `src/tools/agent/runs/manager.ts`, `runs/child-setup.ts`                                                 | `ChildSetupHooks.persist(run, intent)`; `onFileChanged` + `updateTranscriptLeaf` send `intermediate`                                                                                                                                                                                                         |
| `src/tools/agent/runs/restore.ts` / `persistence/stored-record.ts`                                       | `applyWorkingStateOverlay(record, workingRow, { leafIsValid })` + kill switch                                                                                                                                                                                                                                |
| `src/tools/agent/presentation/sessions.ts`                                                               | verify only — it already skips missing rows; confirm the checkpoint display degrades gracefully to an older surviving checkpoint                                                                                                                                                                             |
| `test/helpers/agent-doubles.ts`                                                                          | extend the persistence double for `intent` (no hand-built literals, no new `any`)                                                                                                                                                                                                                            |
| `docs/agent-persistence.md:20,76`, `src/tools/agent/README.md`, `.pi/agent/memory/agents/persistence.md` | replace "GC is report-only; snapshots and referenced transcripts must remain protected" with the new policy, §4.6's invariants, §4.5's skip rule, and §4.4's overlay contract                                                                                                                                |

## 7. Validation

Focused first: `npx vitest run test/tools/agent-persistence.test.ts test/tools/agent-persistence-v2.test.ts
test/tools/agent-lifecycle-persistence.test.ts test/tools/agent-run-snapshot-shape.test.ts`, then
`npm run test:run`, `npx tsc --noEmit`, `npm run typecheck:tests`.

1. An `intermediate` save creates no snapshot row, appends no marker, leaves
   `agent_run_continuation_heads` byte-identical, upserts exactly one `agent_run_working_state` row (second
   save updates it in place — assert row count 1 and the newer leaf), and refreshes `agent_runs`.
2. A `checkpoint` save inserts + marker-appends + settles the head + clears the working row + prunes only
   unprotected rows below the new head; a prune failure still reports `{ ok: true }` for the committed save.
3. Lease loss mid-flight drops intermediate writes silently (trace event, no `RefusedWriteReporter` warning)
   and the next checkpoint proceeds normally.
4. §4.5 both directions: missing row + surviving sibling for the instance ⇒ restores from the older surviving
   checkpoint with **no** diagnostic; missing row + no surviving row ⇒ keeps the
   `parent marker references a missing SQLite snapshot` diagnostic.
5. §4.4 matrix: overlay applies for unclean + dead lease + `resumable`; never for `waiting_for_parent`,
   terminal, read-only "continued on another branch", a leaf absent from that transcript, or a working row
   older than the checkpoint; kill switch restores checkpoint-only behavior.
6. Migration 17: a fixture mixing statuses ends at protected rows only, leaves zero working rows, and is
   idempotent on re-run; the shape test keeps covering corrupt-field coercion.
7. Per-checkpoint vs per-message regression guard: a simulated 50-turn background run produces ~1 snapshot row
   per checkpoint and exactly 1 working row, and the parent session gains ~1 marker per checkpoint instead of
   ~1 per turn.
8. §4.8: `AgentRunJournalState` and `agent_run_continuation_heads` cannot disagree after a
   committed save, a marker-append failure (which still adopts the snapshot as head), or a lost lease.

Manual — required, because this is provider/child-session behavior tests cannot cover (follow the checklist in
`src/tools/agent/README.md`): run a `worker` with ≥20 tool calls and `kill -9` the parent mid-run; reopen the
session and confirm the run restores as `interrupted` at the **working** leaf, `resume` reopens the child
transcript with correct context and unmatched tool calls repaired, and `/agents` shows the older checkpoint
without error. Repeat for a background run parked on `ask_parent`, and for `/tree` navigation onto a sibling
branch whose newest marker was reclaimed by the backlog sweep.

## 8. Risks

| Risk                                                                 | Mitigation                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Prune deletes a row a live branch head depends on                    | §4.6 protected set + head-target exclusion; §7.2 asserts the head is never pruned                                                               |
| Overlay picks a leaf ahead of what the checkpoint journal proves     | gated on unclean status + dead lease + `resumable`; leaf validated against that transcript; cleared at the next checkpoint; kill switch (§4.4)  |
| Two markers aliasing one mutable row breaks sibling branch semantics | structurally impossible: working state is a separate table and is never marker-referenced (§3.1)                                                |
| Intermediate writes stop reaching storage, so a crash looks stale    | the working row _is_ the crash record and is written per event; `agent_runs` still refreshes for browsing                                       |
| Old sessions show coarser history                                    | intended (§4.5): the transcript and the catalog still list the run; only the intermediate branch checkpoints collapse to the last surviving one |
| `save()` best-effort semantics mask a real checkpoint regression     | only the intermediate path is best-effort; checkpoint failures keep failing loudly                                                              |
| Migration 17 rewrites live state                                     | copy the database first (established practice per the existing `.bak` files) and `PRAGMA integrity_check` after                                 |
| `VACUUM` cannot run inside the migration transaction                 | detect at implementation time; defer via a `needs_vacuum` flag (§4.7)                                                                           |

## 9. Open questions

1. ~~Migration 17 vs explicit action~~ — **decided in §11 step 6**: schema in the migration, the bulk delete
   behind an explicit maintenance action with a dry-run report and confirmation.
2. Retention for _checkpoint_ rows: keep forever, or budget by age — e.g. drop `removed` tombstone payloads
   and non-current-session checkpoints after N days, always keeping the newest row per instance?
3. §4.4's overlay gate: is "unclean status + dead lease + resumable" the right condition, or should it also
   require the working row's `run_id`/`status` to agree with the checkpoint beyond identity?
4. Payload normalization next: dedupe `progress.output` vs `progress.lastAssistantMessage`, reference
   `agent_run_instances.task` instead of copying it, and drop `terminalContent` from `removed` tombstones —
   that is the only lever left once row count is fixed (~13 KiB average per checkpoint row).
5. Should `agent_run_working_state` also serve the live UI (`/agents` progress for runs of _other_ sessions),
   or stay strictly a recovery record?
6. ~~§4.8's `AgentRunJournalState`~~ — **decided in §11 step 1**: land it first as a behavior-preserving
   refactor, gated on the 22 existing V2 cases passing unmodified.

## 10. Rejected alternatives

- **Stub superseded rows in place** (`payload_json` replaced by a tiny pruned marker + `pruned_at` column,
  loader skips stubs). Safe and reclaims 67.3 → 7.3 MiB, but leaves ~0.5 KiB per reclaimed row forever
  (14.6 MiB vs ~8.7 MiB measured), adds a column and a row state every reader must understand, and only makes
  sense because it can _also_ clean the legacy backlog — which §4.5 + §4.7 do with plain deletes.
- **Stop writing intermediates entirely, hinting the leaf from `agent_runs`** (an earlier draft of this plan).
  Fewest bytes, but it makes restore read a documented "rebuildable, lossy projection" during branch
  selection — `docs/agent-persistence.md:20` and the persistence memory both say the catalog is never
  authority — and it loses the exact crash leaf. The dedicated working-state table gets the same growth
  profile without either cost.
- **Write a snapshot row + marker per message and `DELETE` them at the next checkpoint** (plain F, no
  working table). Zero restore change and the smallest diff, but it keeps ~1,100 two-transaction saves/day
  plus ~1,800 permanent marker entries per long session, and the delete still leaves dangling markers, so it
  needs §4.5 anyway. It is the natural fallback if the §4.4 overlay review comes out negative — and the
  migration/helper work below is shared, so choosing it later costs nothing already done.
- **Store the checkpoint-vs-intermediate flag on `agent_run_snapshots`.** Rejected in §3.1: it invites mutable
  rows into the immutable, marker-pinned table.

## 11. Implementation plan

Seven steps, ordered so every read-side tolerance ships **before** any delete and the only irreversible action
is last. Each step ends with `npm run check` (typecheck, `typecheck:tests`, lint, `format:check`, `test:run`,
knip) plus the focused files from §7, and each is revertable alone except step 6, which is gated by a database
copy. Tracked in the runtime TODO list as `step0`…`step7`.

### Step 0 — baseline (no code)

1. Copy the live database the way the leaf/`created_sequence` migrations already did:
   `cp .state/meta.sqlite .state/meta.sqlite.before-snapshot-gc-<ts>.bak` (it is a runtime artifact, not
   source, and `.state/` is gitignored).
2. Record §1's numbers as the _before_ column of §12, plus `ls -l .state/meta.sqlite*` and the marker count of
   the largest parent session file.
3. Capture the pre-existing test/lint/knip baseline so a pre-existing failure is never blamed on this work.

### Step 1 — `AgentRunJournalState` (behavior-preserving refactor, §4.8) — ✅ landed

- The three §7.8 cases were written first and confirmed green **against the old class**, then green again after
  the move. "Watch it fail" was wrong in the first draft of this plan: a characterization net must pass before
  and after, or the refactor is not behavior-preserving. The three are `adopts an existing continuation head on
first sight`, `refuses later saves and strands a pending reservation when the marker append fails`, and
  `settles each reservation when one writer commits repeatedly` — the last is what a careless map merge breaks,
  since it asserts `pending = 1` never accumulates.
- `JournalHeadExpectations` became `AgentRunJournalState` in `persistence/journal-heads.ts`: one
  `Map<runInstanceId, { head?: string }>`, where **entry presence** replaces the separate `known` Set. Two
  deviations from §4.8's sketch, both recorded there: no `headAdopted` boolean (it would be a second source of
  truth for entry presence), and no `createdSequence` in the entry (nothing reads it; the heads row holds the
  durable sequence).
- The `runId ↔ runInstanceId` index **did not move** — §4.8 explains why the writer-private journal cannot own a
  resolution the manager needs.
- **Acceptance met:** the 22 pre-existing `test/tools/agent-persistence-v2.test.ts` cases passed unmodified;
  1,660 tests, `tsc --noEmit`, and `typecheck:tests` all clean.

### Step 2 — storage primitives, read side inert — ✅ landed

- Migration **17** creates `agent_run_working_state` only (§4.2). No deletes in any migration: that split stayed
  in, so schema change and data loss are never one revertable unit (§4.7, §9.1).
- New `storage/run-working-state.ts`: `upsertAgentRunWorkingStateInDatabase`,
  `readAgentRunWorkingStateInDatabase`, `clearAgentRunWorkingStateInDatabase`, plus `isAgentRunWorkingStatus` and
  the `AgentRunWorkingStatus` union. The write input narrows `status`, so a checkpoint-boundary status is a
  **compile error**; the table's `CHECK` is the runtime write guard (tested by asserting the constraint error),
  and the `upsert` runtime status check was removed once the type made it unreachable. The read side keeps
  validating, because a row written by another build is untrusted data.
- `applyWorkingStateOverlay(record, working, { leaseIsHeld, leafExists })` in `persistence/stored-record.ts` plus
  `ENABLE_WORKING_STATE_OVERLAY = false`. The two world facts are injected parameters, so the gate matrix is a
  pure unit test and the step-3 caller has to prove them rather than assume them.
- Chunked `listAgentRunSnapshotsInDatabase` (§3) at 500 placeholders, now also deduplicating ids and tolerating
  holes — one real parent transcript holds 1,826 markers, so an oversized `IN (...)` was reachable.
- **Deferred to step 3:** the `load.ts` call site. A path no writer can feed yet is dead code that only
  direct-storage tests could reach, so step 3 lands writer, wiring, and enablement together and tests the
  end-to-end path with a real save.
- **Acceptance met:** 16 new cases in `test/tools/agent-run-working-state.test.ts` — single-row upsert and clear,
  `CHECK` rejection, unreadable payload, a real v16 → v17 upgrade of an existing file, "saves still write
  nothing", `ENABLE_WORKING_STATE_OVERLAY === false`, the overlay gate matrix, and the chunked fetch; 1,676
  tests, both typechecks, eslint, and prettier clean.

### Step 3 — intent threading + the writer branch (the behavior change)

- `AgentRunCheckpointIntent` in `contracts/runs.ts`; `save(record, intent?)` on `AgentRunPersistence`,
  `AgentRunStateWriter`, and `AgentRunCheckpointStore.save` (default `"checkpoint"`). Extend the shared doubles
  in `test/helpers/agent-doubles.ts` so they **record** the intent — `save: async () => true` would otherwise
  swallow the new parameter and every test would pass while intent was ignored.
- `SqliteAgentRunStateWriter.save` branches: `intermediate` → working upsert + catalog projection, no lease
  acquisition, best-effort drop when `ContinuationLeaseLedger.owns()` is false; `checkpoint` → the existing
  reserve/commit path untouched.
- Add `lastIntent` / `working` to the journal entry (§4.8) so the belief has one home.
- **Only then** switch the seam: `ChildSetupHooks.persist(run, intent)` sends `intermediate` from
  `onFileChanged` and `updateTranscriptLeaf`; `onSessionCreated` and `checkpointOutcome` stay `checkpoint`.
  Never split the writer branch and the seam switch across commits — a switched seam with an unbranched writer
  is the one combination that silently loses the crash leaf.
- Enable `ENABLE_WORKING_STATE_OVERLAY` in this same step.
- **Acceptance:** §7.1–§7.3, §7.5–§7.7, plus a real 20+-turn background run measured against §12.
- **Expected test fallout** (update to assert "one marker per checkpoint" explicitly rather than loosening a
  count): `commits immutable snapshots through parent markers and rejects stale branch resume`,
  `restores V2 branch checkpoints and browses their exact child leaves`,
  `restores starting and running checkpoints as interrupted without replaying them`, and
  `agent-lifecycle-persistence.test.ts`'s detach case. `persists a save whose lease was released in the same
turn`, `preserves commit ordering when snapshot, marker, or catalog writes fail`, and
  `keeps a committed snapshot when head projection commit fails after marker append` must pass **unchanged** —
  they are the checkpoint path and the TOCTOU ordering that this design must not disturb.

### Step 4 — read-side tolerance for reclaimed rows (§4.5)

- Surviving-instance predicate computed once per load; silent skip in `SnapshotValidator.recordFor` and
  `resolveActiveRecords`; the no-surviving-row diagnostic stays word-for-word, since it is user-visible and
  asserted by `reports a marker that references a missing snapshot without restoring it` (extend that case with
  the surviving-sibling direction instead of replacing it).
- **Acceptance:** §7.4 both directions; `presentation/sessions.ts` verified only (§6).

### Step 5 — per-checkpoint prune guard (§4.3)

- `pruneAgentRunSnapshotsInDatabase` implementing the §4.6 protected set, called after checkpoint commit for
  that instance only, inside the serialized save queue, traced as `persistence.gc_failed` on failure so a prune
  can never fail a committed save.
- **Acceptance:** §7.2 (head never pruned), §7.3, and a status-awareness test proving a `waiting_for_parent` row
  sitting between two checkpoints of the same instance survives.

### Step 6 — backlog sweep (irreversible, gated)

1. Restore `tools/report-agent-gc.mjs` from stash `0ccdbf0…` and drive its prune section with the **same** step-5
   helper in dry-run mode, so "what would be deleted" is reviewed as a report first.
2. Re-check §1's predicate against the live file — step 3 has been writing since, so confirm all
   `running`/`starting` rows are still non-head, non-newest, and that no head targets one.
3. Run it behind an **explicit maintenance action**, not a migration (resolves §9.1 in favor of
   reviewability): print the plan, require confirmation, `DELETE`, `VACUUM` outside any migration transaction,
   then `PRAGMA integrity_check`. Enabling `auto_vacuum = INCREMENTAL` in the same action means later prunes
   never need a manual VACUUM (§4.7).

### Step 7 — docs, memory, manual validation

- `docs/agent-persistence.md:20` (the catalog-authority line must state §4.4's narrow overlay exception) and
  `:76` (GC is no longer report-only), `src/tools/agent/README.md`'s manual checklist (add the `kill -9` restore
  case and a "one marker per checkpoint" confirmation), `.pi/agent/memory/agents/persistence.md`, plus this
  doc's status line and §12's _after_ column.
- Then run the §7 manual sequence on a real run, both before and after step 6.

### Deferred on purpose

Payload normalization (§9.4), checkpoint-row retention budgets (§9.2), the live-UI role for the working table
(§9.5), debouncing intermediate saves, and the 1.3 GB of isolated worktrees (Appendix B). Each is its own
decision with its own blast radius; the trap is letting step 3 grow into them.

## 12. Verification and measurement

Fill in as each step lands; the work is done when the last columns match §5's prediction.

| signal                         | before (step 0) | after step 3             | after step 6                  |
| ------------------------------ | --------------- | ------------------------ | ----------------------------- |
| `.state/meta.sqlite` size      | 82.7 MiB        | flat (no deletes yet)    | target ~8.7 MiB (unverified)  |
| `agent_run_snapshots` rows     | 12,795          | flat                     | 502                           |
| `running`/`starting` rows      | 12,293          | none created per message | 0                             |
| `agent_run_working_state` rows | table absent    | ≤ 1 per live run         | 0 at rest                     |
| markers in one long session    | 1,826           | checkpoints only         | unchanged (step 6 is DB-only) |
| durable saves per day          | ~1,100          | ~1,100 single statements | same                          |

Two gates that are not test suites:

- **Manual gate for step 3, before it is trusted** — provider and child-session behavior is not covered by
  tests (`AGENTS.md`), so run the `src/tools/agent/README.md` checklist plus §7's `kill -9` case and confirm the
  interrupted run restores at the **working** leaf and `/agents` opens both the live run and an older
  checkpoint with no diagnostics.
- **Soak gate for step 6** — after the sweep, use agents normally for a day and re-measure: row count must stay
  in the hundreds, not thousands. Only then delete the step-0 `.bak`.

## Appendix A — reproducing the measurements

All numbers came from read-only queries plus a copy of the live database in a scratch directory
(`sqlite3 'file:.state/meta.sqlite?mode=ro' …`; the copy was never written back).

```sql
-- size and shape
SELECT count(*), sum(length(payload_json)) FROM agent_run_snapshots;
SELECT status, count(*) n, sum(length(payload_json)) bytes
  FROM agent_run_snapshots GROUP BY status ORDER BY n DESC;

-- the prune target, and the proof it is entirely superseded
WITH ranked AS (
  SELECT snapshot_id, run_instance_id, status, length(payload_json) bytes,
         row_number() OVER (PARTITION BY run_instance_id ORDER BY created_sequence DESC) rn
  FROM agent_run_snapshots)
SELECT count(*), sum(bytes) FROM ranked WHERE status IN ('running','starting') AND rn > 1;  -- 12293 / 60.7 MiB
SELECT count(*)              FROM ranked WHERE status IN ('running','starting') AND rn = 1;  -- 0
SELECT count(*) FROM agent_run_continuation_heads h JOIN agent_run_snapshots s USING (snapshot_id)
 WHERE s.status IN ('running','starting');                                                    -- 0

-- schema freedom: no FK protects a snapshot row
SELECT sql FROM sqlite_master WHERE sql LIKE '%REFERENCES%agent_run_snapshots%';             -- only snapshots->instances
PRAGMA foreign_key_list(agent_run_continuation_heads);                                       -- empty
```

Simulated reclaim on the copy — the stub form was measured (14.6 MiB); the delete form was measured **with** a
prune registry (9.8 MiB) and the no-registry figure is arithmetic, not yet verified. Measured timings: the
12,293-row `UPDATE` took 0.20 s, `VACUUM` took 0.086 s, `PRAGMA integrity_check` = ok.

```sql
UPDATE agent_run_snapshots
   SET payload_json = json_object('snapshotId', snapshot_id, 'pruned', 1)
 WHERE status IN ('running','starting')
   AND snapshot_id NOT IN (SELECT snapshot_id FROM agent_run_continuation_heads);
VACUUM;
```

Marker pinning per parent session (≈ one marker per save, which is what §4.2 stops):

```bash
for f in ~/.pi/agent/sessions/*/*.jsonl; do
  printf '%s %s\n' "$(grep -c agent-run-snapshot-v2 "./$f")" "$f"
done | sort -rn | head
```

One-single-working-row mechanics probe (passed on the CLI at 3.50.2 and on the runtime binding at 3.52.0):

```sql
CREATE TABLE w(run_instance_id TEXT, kind TEXT, seq INTEGER);
CREATE UNIQUE INDEX w_one_working ON w(run_instance_id) WHERE kind='working';
INSERT INTO w VALUES('r1','working',1);
INSERT INTO w VALUES('r1','working',2)
  ON CONFLICT (run_instance_id) WHERE kind='working' DO UPDATE SET seq=excluded.seq;
INSERT INTO w VALUES('r1','checkpoint',10);
SELECT group_concat(kind||':'||seq, ' ') FROM w;   -- working:2 checkpoint:10 checkpoint:11
```

## Appendix B — operational notes

- The live database is `.state/meta.sqlite`: `openAgentMetadataDatabase()` (`storage/metadata.ts:350-367`)
  resolves `dirname(workspacesDir)/meta.sqlite`, and that is the only file containing
  `agent_run_snapshots`. The 45 KB `.state/workspaces/meta.sqlite` is a dead remnant of an earlier layout
  (`no such table: agent_run_snapshots`) — maintenance tooling must use the same resolution.
- `.state/` also holds 117 MB of stale database copies (`meta.sqlite.backup-20260830T100009Z` and its
  `-pristine` twin at 60,387,328 B each, plus three 405,504 B `meta.sqlite.before-*-migration-*.bak` /
  `before-created-sequence` files) that predate the leaf and `created_sequence` migrations. `.state/` is
  runtime data, not source, but confirm before deleting. `.state/workspaces/` separately holds 1.3 GB of
  isolated worktrees — a distinct retention question, out of scope here.
- The parked dry-run report script lives in git stash `0ccdbf040be633195333a0fb6c7c07dcb9190c0f` at
  `tools/report-agent-gc.mjs` (reachable through that stash commit's third parent, not `git stash list`
  index 0). Reuse it as the reporting half of this work: it already classifies orphan transcripts, missing
  transcript references, protected/unreachable snapshots, and reclaimable bytes without deleting anything.
