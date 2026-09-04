# Snapshot GC Manual Validation

This checklist is for a separate validation agent/operator. It exercises the delegated-run checkpoint and
working-state behavior that unit tests cannot reach: real provider turns, a real process death, real SQLite
WAL recovery, and what `/agents` shows afterward. It follows `docs/agent-snapshot-gc.md`; steps 1–3 of that
plan are implemented, so scenarios A–D apply now and E–F do not yet.

## Safety rules

- This repository's `.state/meta.sqlite` is real developer state. Copy it before any scenario that writes, and
  never delete the copy until every result is recorded. Use `VACUUM INTO`, not `cp`, whenever a parent session is
  attached: committed frames can still be sitting in `-wal`, and a plain file copy can miss them.

  ```bash
  sqlite3 .state/meta.sqlite "VACUUM INTO '.state/meta.sqlite.before-gc-validation-$(date -u +%Y%m%dT%H%M%SZ).bak';"
  ```
- Open the database with an ordinary connection, never `file:…?mode=ro`: a read-only connection cannot build the
  WAL index against a live `-shm` and fails with `SQLITE_IOERR`. WAL gives concurrent readers already.
- Do not kill the pi session you are working in. Scenario B needs a **second** pi instance in another terminal,
  so the session under test is the one that dies and the operator's own session survives to inspect it.
- Scenarios A and D need no killing and no second instance — they are observable while you work normally.
- Approve worker mutations only when the command and path are expected, as with any worker run.
- Record each number in the Results report rather than judging from memory; the whole point is the delta.
- A failure to restore is a finding even when it looks benign: report the exact diagnostic text.

## Test setup

1. Back up the metadata database and record the starting state.

   ```bash
   cp .state/meta.sqlite .state/meta.sqlite.before-gc-validation.bak
   sqlite3 'file:.state/meta.sqlite?mode=ro' "PRAGMA integrity_check;
     SELECT count(*), sum(length(payload_json)) FROM agent_run_snapshots;
     SELECT count(*) FROM agent_run_snapshots WHERE status IN ('running','starting');
     SELECT count(*) FROM agent_run_working_state;"
   ```

   `agent_run_working_state` must exist; if it does not, migration 17 has not run yet in this checkout — start
   pi once so the writer applies it, then re-measure.
2. Start pi in the pi-coder checkout with a persisted parent session. Do not use `--no-session`.
3. Note the parent session id, because markers are counted in that one transcript file:

   ```bash
   ls -t ~/.pi/agent/sessions/--home-sd-Repos-pi-coder--/*.jsonl | head -1
   ```

## Current state of this checkout (recorded 2026-09-04)

Step 6 ran here by hand, so scenarios A–E all apply; F always does. Measured result, in the file:

| | before | after |
| --- | --- | --- |
| `.state/meta.sqlite` | 82.7 MiB | 8.75 MiB |
| `agent_run_snapshots` | 12,795 rows / 67.3 MiB | 502 rows / 6.6 MiB |
| `running`/`starting` rows | 12,293 | 0 |

Backup of the pre-sweep state: `.state/meta.sqlite.before-gc-sweep-20260904T134432Z.bak` (86,433,792 B,
`integrity_check` ok). Every continuation head still resolved to a surviving row, every physical run kept at
least one row, and no row in a prunable status remained. Scenario A has since been measured against a live child
(see Run 1 at the end); B, C and D have not.

## A. One child run costs markers per boundary, not per message

This is the change's purpose, so measure it rather than assume it.

1. Record `snapshot rows`, `working rows`, and the transcript's marker count (section Setup, plus):

   ```bash
   sqlite3 'file:.state/meta.sqlite?mode=ro' "SELECT count(*) FROM agent_run_snapshots;"
   ```

2. Start a background `worker` long enough to produce many tool calls and at least one file change:

   ```text
   agent(action="start", agent="worker", background=true,
         task="Read the src/tools/agent/runs directory, summarize each module in a scratch note under the
               scratchpad, and report the file count. Make at least ten tool calls.")
   ```

3. While it runs, sample every ~20 seconds:

   ```bash
   SESSION=$(ls -t ~/.pi/agent/sessions/--home-sd-Repos-pi-coder--/*.jsonl | head -1)
   grep -c agent-run-snapshot-v2 "$SESSION"
   sqlite3 'file:.state/meta.sqlite?mode=ro' \
     "SELECT status, count(*) FROM agent_run_snapshots GROUP BY status;
      SELECT count(*), max(updated_at) FROM agent_run_working_state;"
   ```

   Expected: `agent_run_snapshots` grows only at boundaries (start, settled operation, terminal, tombstone), and
   the marker count tracks it one-for-one. `agent_run_working_state` stays at **one row per live run** and its
   `updated_at` advances continuously. A `running` row added per tool call means the seam regressed.
4. `collect` the result and re-sample. Expected: the run's working row is **gone** (the terminal checkpoint
   cleared it), and no new `running` snapshot row remains.

## B. Crash between checkpoints restores at the working leaf

The only scenario that proves the overlay is correct against a real transcript and a real dead process.

1. Start a background `worker` as in A.2, then kill **that** parent process mid-run. In a second terminal, the
   pid to kill is the pi you launched there. From inside the session under test instead, a delayed self-kill
   works and needs no external terminal:

   ```bash
   pi_pid=$(ps -o ppid= -p "$$" | tr -d ' ')
   nohup sh -c "sleep 12; kill -9 $pi_pid" >/dev/null 2>&1 &
   disown
   ```

   Expected: pi dies about twelve seconds later with no shutdown path taken — that is the point. A child bash
   process may survive it, which is realistic and does not affect the assertions below.

2. Confirm the last durable checkpoint is unclean before reopening:

   ```bash
   sqlite3 'file:.state/meta.sqlite?mode=ro' \
     "SELECT h.run_instance_id, s.status, s.child_session_leaf_id, w.child_session_leaf_id, w.updated_at > s.updated_at
      FROM agent_run_continuation_heads h
      JOIN agent_run_snapshots s ON s.snapshot_id = h.snapshot_id
      LEFT JOIN agent_run_working_state w ON w.run_instance_id = h.run_instance_id;"
   ```

   Expected: `s.status` is `running` or `starting`, a working row exists, its leaf differs from the checkpoint
   leaf, and its timestamp is newer.
3. Reopen the same parent session (`pi --resume`, choose that session) and check the restored run.

   Expected: `/agents` lists it as **interrupted**, opening its detail shows the child conversation up to the
   working leaf rather than the older checkpoint leaf, and no diagnostic appears containing
   `missing SQLite snapshot`, `no exact child transcript leaf`, or `could not be reopened`.
4. Confirm the lease was left behind correctly:

   ```bash
   sqlite3 'file:.state/meta.sqlite?mode=ro' "SELECT run_instance_id, owner_pid, lease_until FROM agent_run_continuation_leases;"
   ```

   Expected: either no row, or a row whose `owner_pid` is the dead process — the documented dead-PID fast path
   reclaims it instead of waiting for expiry.

## C. Resume actually continues the child conversation

Do scenario B first; then in the reopened session:

```text
agent(action="continue", runId="worker-1", guidance="Finish the remaining summary and report the file count.")
```

Expected: the run resumes from the working leaf, closes unmatched tool calls left by the interruption instead
of replaying them, does not repeat work that the transcript already records, and reaches a terminal outcome that
writes one new checkpoint.

## D. Clean park leaves no hint

1. Start a background child that asks for guidance (`ask_user`/`ask_parent`), then answer or collect it.
2. While it is parked, check the table:

   ```bash
   sqlite3 'file:.state/meta.sqlite?mode=ro' \
     "SELECT s.run_instance_id, s.status,
             (SELECT count(*) FROM agent_run_working_state w
               WHERE w.run_instance_id = s.run_instance_id) AS working_rows
        FROM agent_run_snapshots s WHERE s.status = 'waiting_for_parent';"
   ```

   Expected: the parked checkpoint has **zero** working rows attached to its instance, because a clean park is
   a checkpoint and the overlay must never apply to one.

## E. Reclaimed legacy markers

Applicable now: step 6 removed 12,293 intermediate rows from this checkout while their parent markers stayed in
40 older transcripts. Resume an older parent session that has delegated runs — the pre-sweep backup's
`owner_session_id` values name candidates — and expect each run to resolve to its last surviving checkpoint
with **no** diagnostic. A `parent marker references a missing SQLite snapshot` message at that point is a step-4
regression, not intended behavior; so is a run that disappears from `/agents` entirely.

## F. Kill-switch equivalence (optional, cheap)

Set `ENABLE_WORKING_STATE_OVERLAY = false` in `src/tools/agent/runs/persistence/stored-record.ts`, re-run
scenario B step 3, and confirm the run still restores — at its checkpoint leaf. That is the rollback path, and it
must be a degraded restore rather than a failure. Revert the constant afterwards.

## Results report

| scenario | observed | expected | pass |
| --- | --- | --- | --- |
| A. snapshot rows during one run | 5 at accept, 4 at cancel, **0 across 100 s of frames** | boundaries only | ✅ |
| A. marker count during one run | 5 then 9, one per row, **flat mid-run** | equals snapshot rows | ✅ |
| A. working rows during one run | exactly 1; `updated_at` advanced ≥5× while the child transcript grew 8 → 26 lines | 1 per live run | ✅ |
| A. working rows after terminal | 0; head points at the `removed` tombstone | 0 | ✅ |
| A. continuation heads | 1, unmoved by frames | 1 per live run | ✅ |
| A. child transcripts | 1 | 1 per run | ✅ |
| A. `agent_runs` catalog row | one endpoint reading after the run: `status=removed`, `updated_at` = the terminal write, `response_preview` holding mid-run child text (`Round 3 step b:`) — so frame writes do reach the catalog, but the sampler never tracked it over time | browsing tracks frames | ⚠️ not sampled |
| B. unclean checkpoint + working row | checkpoint leaf = child entry 6, transcript end = entry 13, 7 entries apart | differs, newer | ✅ inferred, see Run 2 |
| B. restore leaf after `kill -9` | the resume's `interrupted` checkpoint carries entry 13, the working leaf, while keeping the checkpoint's `updated_at` | working leaf | ✅ |
| B. diagnostics | none reported; head names a surviving checkpoint; working row cleared to 0 by the park | none | ✅ |
| C. resume continues, no replay | **yes** — `worker-2` quoted the entry-13 `bash` command character for character and described `roll.py` as written (24 lines, trial-division `prime_count`, `sum(i*i) % 1000003`), with no tool calls and no replayed rounds | yes | ✅ |
| D. parked run | park cleared the working row to 0 ✅; a `continue` added no second physical run and no second child transcript ✅; **the reappearing working row was never observed** — sampling started after the child had already settled | 0 working rows | ⚠️ partial |
| §12 file size before / after | 82.7 MiB → 8.75 MiB at step 6. Run 1's 9 rows hold 38,718 B of payload (avg 4,302 B/row); the file is unchanged at 9,170,944 B with `freelist_count = 0`, so those bytes came from free pages, not growth | flat, then ~9 MiB after step 6 | ✅ |

### Run 1 — 2026-09-04, scenario A and the cancel boundary

A background `worker` (`worker-1`, instance `c116b35a`) ran about three minutes of paced tool calls confined to
the scratchpad while a sampler polled the database every 2 s. The baseline was clean: this parent session
(`01a06113-…`) had never persisted a run before, so every row above is attributable to the frame design rather
than to older code.

Two things §4.2 did not predict:

1. **A boundary writes several checkpoints, not one.** Accept produced 5 rows and 5 markers (`starting`×4 —
   three sharing `updated_at` to the millisecond — then `running`), and the cancel produced 4 more (`running`,
   `canceled`×2, `removed`) within 83 ms. A short run therefore costs 9 rows where the design assumed ~3. This
   is **not** a regression from steps 1–4: the pre-existing `scout-1` rows from 2026-09-02 show the same
   `canceled`/`canceled`/`removed` shape. **Now reproduced and attributed in a unit test** —
   `test/tools/agent-checkpoint-fanout.test.ts` writes the identical nine-row sequence with no provider call and
   names the sites: the `onSessionCreated` hook in `child-setup.ts:87` duplicating `createChildSession`
   (manager.ts:1135), and `checkpointOutcome` (manager.ts:1912) persisting usage with the default `checkpoint`
   intent, so it appends a marker on the accepted-background summary and again on cancel. See
   `docs/agent-snapshot-gc.md` §9.7 and §11 step 8: `checkpointOutcome` has since been reclassified to a
   progress frame, which takes a canceled run from 9 checkpoints to 7. A live re-measurement should therefore
   show **7** rows for this shape: `starting` x3 (one with no leaf, then the `onSessionCreated`/
   `createChildSession` pair), `running` x2, `canceled` x1, `removed` x1. Nine means the reclassification
   regressed; anything above nine means the detached-launch path adds a boundary the unit fixture does not.
2. **Those duplicate `running`/`starting` rows are exactly what step 5 would reclaim.** Neither status is in
   §4.6's checkpoint-worthy list, so a per-checkpoint guard keeping only the newest row per instance plus head
   targets would drop them, while `canceled`/`removed` stay protected. Step 5 remains skipped on this checkout —
   nothing accumulates *mid-run*, which is the regression that mattered — but this raises its value for legacy
   databases a little.

### Run 2 — 2026-09-04, scenario B: crash between checkpoints

A background `worker` (`worker-2`, instance `15d9ef4c`) was accepted at 15:36:37, worked until the parent process
was killed, and was reconciled by the relaunched pi at 15:37:43.

- Accept wrote 5 rows and 5 markers; the last two carry child leaf `a903acbf` = **entry 6** of the child
  transcript.
- The transcript reached **entry 13** (`2de0073a`) before the kill: 7 entries of progress with no checkpoint, no
  head movement, and one working row. `gc-check-b/roll.py` exists on disk, so the progress was real tool calls
  rather than chatter.
- The relaunched process wrote 3 `interrupted` rows and 3 markers. The first carries leaf `2de0073a` while
  `updated_at` stays at the checkpoint's 15:36:37 — a frame's leaf at a checkpoint's timestamp, which is §4.4's
  stated contract and not what a plain reopen would produce.
- All three rows carry the *new* process's `ownerPid`, which is also the evidence that the dying process parked
  nothing. That is what makes this the crash path whatever signal was sent: a graceful shutdown would have parked
  under the old pid and left the resume nothing to reconcile.
- After the park: the head names the newest `interrupted` row, `agent_run_working_state` is empty, and no
  `missing SQLite snapshot` diagnostic appeared.

Why this is a pass on inference rather than capture: the working row was cleared by the resume before the
collector ran, so `working_leaf == interrupted_leaf` was never observed directly. The chain replacing it is that
`record.childSessionLeafId` is the only leaf the restore path reads (`restore.ts:374`), `selectChildSessionLeaf`
can only move a leaf *backward* with `branch(leafId)` and throws when the id is absent, and no graceful park
happened. Run the collector between kill and relaunch anyway: it takes seconds, the resume destroys the evidence,
and capture beats elimination.

The gap this run leaves is C — whether continuing `worker-2` reopens the child at entry 13 and proceeds without
replaying work it already finished. That is also the part a scripted process-death test would have to cover
against a real transcript to be worth its name.

### Run 3 — 2026-09-04, scenario C: continuing the crashed run

`worker-2` was continued with an instruction to answer three questions from its own conversation history and call
no tools. Scoring it against the child transcript rather than against its prose:

| what it reported | ground truth | match |
| --- | --- | --- |
| last action was `cd /tmp/pi-coder-scratchpad-zdgfdb/gc-check-b && python3 roll.py 50 && awk 'END{print NR" lines"}' roll.py` | entry 13's persisted `toolCall.arguments.command`, identical | ✅ exact |
| it never saw that call's result (`No result provided`) | entry 13 has no matching tool result; the crash left it unmatched | ✅ synthetic uncertain-outcome path |
| created the directory and `roll.py`; nothing else | entry 9/10 `mkdir`, entry 11/12 write, `roll.py` on disk is 24 lines with the shape it described | ✅ |
| zero of 8 rounds, no codewords, invented none | nothing else in the transcript | ✅ |

Because the accept checkpoint's leaf was **entry 6**, none of that content was reachable from the checkpoint:
proving it held entries 7-13 in context proves the restore landed on the frame's leaf. This is the behavioral
confirmation Run 2 could only infer, so B and C now stand on capture and behavior rather than elimination.

Cost accounting, which is the finding worth carrying forward. `worker-2` ended at **18 snapshot rows and 18
markers**, split by status: `starting` 4, `running` 5, `interrupted` 5, `completed` 3, `removed` 1. §4.2 predicts
about 4 for that lifecycle (accept, park, resume, terminal), so **every boundary writes 3-5 checkpoints instead of
one** — `worker-1`'s identical shape (4 `starting`, 2 `running`, 2 `canceled`, 1 `removed`) confirms it is not
specific to the crash path. The one `removed` is the collect tombstone, which is correct. Still three orders of magnitude
below the pre-frame one-marker-per-save behavior, but it is now the dominant cost and the thing worth fixing.
Sampling caveats: the collector started after the continued child had already settled, so a reappearing working
row was never observed, and the run was short enough that mid-run frames were a handful rather than a stream.
