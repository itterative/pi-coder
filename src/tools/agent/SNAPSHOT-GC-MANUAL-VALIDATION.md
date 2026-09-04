# Snapshot GC Manual Validation

This checklist is for a separate validation agent/operator. It exercises the delegated-run checkpoint and
working-state behavior that unit tests cannot reach: real provider turns, a real process death, real SQLite
WAL recovery, and what `/agents` shows afterward. It follows `docs/agent-snapshot-gc.md`; steps 1–3 of that
plan are implemented, so scenarios A–D apply now and E–F do not yet.

## Safety rules

- This repository's `.state/meta.sqlite` is real developer state. Copy it before any scenario that writes, and
  never delete the copy until every result is recorded.
- Do not run scenario E or F before `docs/agent-snapshot-gc.md` steps 4–6 land: they delete rows.
- Approve child mutations only when the command and path are expected, as with any worker run.
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

1. Start a background `worker` as in A.2, then kill the parent process mid-run. The reliable way is from
   inside pi itself, which walks up from the tool's own shell to the pi process and leaves a delayed kill:

   ```bash
   pi_pid=$(ps -o ppid= -p "$$" | tr -d ' ')
   nohup sh -c "sleep 12; kill -9 $pi_pid" >/dev/null 2>&1 &
   disown
   ```

   Expected: pi dies about twelve seconds later with no shutdown path taken — that is the point. A child bash
   process may survive it, which is realistic and does not affect the assertions below. If you would rather not
   kill your own session, use a separate terminal and `kill -9 <pid>` on the pi process you started.

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

## E. Reclaimed legacy markers (only after steps 4–6)

Skip until `docs/agent-snapshot-gc.md` step 6 has run. Then reopen the oldest parent session with delegated
runs — the backup copy from Setup names one — and expect the run to resolve to its last surviving checkpoint
with **no** diagnostic. A `parent marker references a missing SQLite snapshot` message at that point is a step-4
regression, not intended behavior.

## F. Kill-switch equivalence (optional, cheap)

Set `ENABLE_WORKING_STATE_OVERLAY = false` in `src/tools/agent/runs/persistence/stored-record.ts`, re-run
scenario B step 3, and confirm the run still restores — at its checkpoint leaf. That is the rollback path, and it
must be a degraded restore rather than a failure. Revert the constant afterwards.

## Results report

| scenario | observed | expected | pass |
| --- | --- | --- | --- |
| A. snapshot rows during one run | | boundaries only | |
| A. marker count during one run | | equals snapshot rows | |
| A. working rows during one run | | 1 per live run | |
| A. working rows after terminal | | 0 | |
| B. unclean checkpoint + working row | | differs, newer | |
| B. restore leaf after `kill -9` | | working leaf | |
| B. diagnostics | | none | |
| C. resume continues, no replay | | yes | |
| D. parked run | | 0 working rows | |
| §12 file size before / after | | flat, then ~9 MiB after step 6 | |

Also record whether the run's `agent_runs` catalog row kept up with progress (`updated_at`, `response_preview`),
since browsing depends on it while the checkpoint journal deliberately does not move.
