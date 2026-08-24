# Isolated Workspace Manual Validation

This checklist is for a separate validation agent/operator. It tests the current isolated-worker workspace lifecycle without changing pi-coder source code.

## Safety rules

- Use the dedicated disposable repository at `.workspace-validation/repo`, not the pi-coder checkout itself. The `.workspace-validation/` directory is gitignored.
- Do not automatically merge, reset, delete, or reuse a workspace. Every workspace disposition must be an explicit user action.
- The validation agent may create the test repository and its fixture files, but must not delete or reinitialize an existing `.workspace-validation/` directory without explicit approval.
- Approve worker mutations only when the command and path are expected.
- Record the workspace slug, run ID, result ID, base revision, worker revision, and durable ref from each result.
- Stop and report immediately if the parent checkout changes before an explicit `apply` action.
- When a test says “clean parent”, verify with `git status --short` before continuing.

## Test setup

1. From the pi-coder checkout, create the dedicated fixture repository if it does not already exist:

   ```bash
   TEST_ROOT="$PWD/.workspace-validation/repo"
   mkdir -p "$TEST_ROOT"
   cd "$TEST_ROOT"
   git init
   git config user.name "pi-coder workspace validation"
   git config user.email "workspace-validation@localhost"
   printf '# Workspace validation fixture\n' > README.md
   git add README.md
   git commit -m 'Initialize workspace validation fixture'
   ```

   If `.workspace-validation/repo` already exists, do not reinitialize or reset it. Inspect its state and either continue with a clean committed revision or ask the user before changing it.
2. Start pi from `.workspace-validation/repo` with pi-coder enabled and with a persisted parent session. Do not use `--no-session`.
3. Confirm the starting state:

   ```bash
   git status --short
   git log -1 --oneline
   ```

   The starting status must be empty before apply/reset tests. Keep the fixture repository available until all results have been recorded.
4. Use the built-in `worker` and `isolation: "worktree"` for isolated tasks. Example tool calls:

   ```text
   agent(action="spawn", agent="worker", isolation="worktree",
         task="Inspect the repository and report its files. Do not change anything.")

   agent(action="spawn", agent="worker", isolation="worktree",
         task="Create a new file named workspace-validation-marker.txt containing exactly `workspace test`. Do not change any other file.")
   ```

5. Collect terminal runs explicitly:

   ```text
   agent(action="collect", runId="<run-id>")
   ```

6. Use `/agents` for workspace inspection. Open **Workspaces**, select the workspace, and press `Enter` for details.

## A. No-change result and reuse

**Goal:** A clean worker result must not create a durable ref and must release its lease.

1. Run the no-change worker task above and collect it.
2. Verify the result says the parent checkout was not changed and no application is needed.
3. In `/agents` → **Workspaces**, verify:
   - the workspace is `available`;
   - it has no task lease;
   - Git is clean;
   - no durable result ref is reported.
4. Run another isolated worker and verify it can select/reuse the available workspace.

Expected: no parent diff, no durable ref, and no manual cleanup required for this workspace.

## B. Changed result, collection, and saved diff

**Goal:** Collection finalizes the worker tree but does not modify the parent checkout.

1. Start the marker-file worker and approve only the expected write.
2. Collect the completed run.
3. Verify:
   - the parent does not contain `workspace-validation-marker.txt`;
   - the result includes workspace ID, result ID, base revision, worker revision, commit range, and durable ref;
   - the workspace remains leased or otherwise excluded from automatic reuse;
   - the result is described as awaiting explicit disposition.
4. Open `/agents` → **Workspaces** → the workspace → `Enter`.
5. Press `i` and verify the inline diff contains only the marker file change. Press `Escape` or `q` to leave the diff.

Expected: the saved diff is readable and the parent remains unchanged.

## C. Retain disposition

Use a fresh changed result from section B, before applying or resetting it.

1. In workspace details, press `t`.
2. Confirm the action with `y` or `Enter`; cancel once with `n` or `Escape` in a separate run if desired.
3. Verify:
   - the parent remains unchanged;
   - the workspace lease is released;
   - workspace status is `review_required`;
   - the result and durable ref remain available;
   - a new isolated worker does not automatically select this workspace.

Expected: retain preserves the result for later review and does not apply it.

## D. Successful apply and post-apply state

Use a fresh changed result whose parent is still exactly at the recorded base revision and clean.

1. Confirm the parent is clean and at the result base revision:

   ```bash
   git status --short
   git rev-parse HEAD
   ```

2. In workspace details, press `a` and confirm with `y` or `Enter`.
3. Verify:
   - the marker file now exists in the parent checkout;
   - `git status --short` shows the applied file as an uncommitted parent change;
   - no parent commit was created;
   - the result becomes `applied`;
   - the workspace lease is released and the workspace is `review_required`, not automatically reusable.
4. Do not discard the parent change yet if it is needed for another test. Otherwise remove it explicitly in the disposable repository and commit/reset the fixture as appropriate.

Expected: apply transfers the complete worker diff without creating a parent commit.

## E. Apply preflight failures

Use a fresh changed result for each failure case. The result must remain prepared and the lease must remain held after a failure.

### E1. Dirty parent

1. After collecting the worker result, create an unrelated uncommitted change in the parent.
2. Try `a` and confirm.
3. Verify apply fails with a clean-checkout error.
4. Verify the unrelated parent change is intact and the workspace/result remain available for explicit recovery.

### E2. Parent revision drift

1. After collecting the worker result, make and commit an unrelated parent change.
2. Try `a` and confirm.
3. Verify apply fails because the parent is no longer at the recorded base revision.
4. Verify the parent commit is unchanged by the failed apply.

### E3. Worker changed after preparation

1. After collection, edit or create a file directly in the recorded workspace worktree path.
2. Try `a` and confirm.
3. Verify apply fails because the worker tree is dirty or its HEAD changed.
4. Verify the parent remains unchanged and the lease/result are not silently released.

Expected for all three: failed preflight is non-destructive and leaves the workspace available for explicit inspection or disposition.

## F. Reset for reuse

Use a workspace with a prepared or applied changed result and a clean parent checkout.

1. In workspace details, press `r` and confirm with `y` or `Enter`.
2. Verify:
   - tracked worker changes are removed;
   - untracked worker files are removed;
   - durable result refs are removed;
   - prepared results are marked discarded where applicable;
   - base revision follows the current parent revision;
   - status is `available` and there is no lease.
3. Run a new isolated worker and verify the workspace can be selected again.

Note: reset requires a clean parent. It is intentionally destructive inside the isolated workspace but must not modify the parent checkout.

## G. Discard workspace

Use a workspace with a prepared or applied result that is no longer needed.

1. In workspace details, press `d` and confirm with `y` or `Enter`.
2. Verify:
   - the workspace worktree is removed;
   - saved result refs are removed;
   - the workspace no longer appears in `/agents` → **Workspaces**;
   - the parent checkout is unchanged.
3. Cancel one discard confirmation with `n` or `Escape` and verify nothing is removed.

Expected: discard removes only the explicitly selected isolated workspace and its saved results.

## H. Reload and interrupted isolated run

The earlier interruption test is not the same as reload. This test checks persistence across an extension/session reload while an isolated worker is still active.

1. Start an isolated worker with a task that keeps it active long enough to reload, for example:

   ```text
   Create workspace-reload-marker.txt, then run a command that waits for several minutes. Do not finish until the wait is interrupted. Do not change any other file.
   ```

   Approve the expected write and wait until the activity widget shows the worker as running.
2. Run `/reload` while the worker is still running. If the command is unavailable in the current UI, restart/continue the same persisted parent session instead and record which path was used.
3. After reload, verify:
   - the worker is shown as `interrupted`, not automatically restarted;
   - the run ID is retained for this exact parent session;
   - `/agents` → **Current** shows the interrupted run;
   - `/agents` → **Workspaces** shows the same workspace and its lease/state;
   - no tool call was replayed automatically;
   - the parent checkout was not modified.
4. Explicitly choose one recovery path:
   - press `r` on the interrupted run in `/agents`; or
   - use `agent(action="resume", runId="<run-id>")`.
5. Verify the resumed worker receives the safety instruction to inspect uncertain state first, continues in the same workspace, and eventually produces a normal terminal result.
6. Collect and disposition the result using the sections above.

Expected: reload preserves enough state for explicit recovery but never resumes or replays a worker automatically.

## I. Capacity and selection

Optional higher-coverage test.

1. Create three persistent workspaces by completing changed isolated tasks and retaining each result, or by otherwise leaving three explicit workspace records in place.
2. Start a fourth isolated worker from the same parent cwd.
3. Verify it reports workspace capacity instead of silently creating a fourth workspace.
4. Reset or discard one workspace explicitly, then verify a later isolated worker can create or reuse capacity.

Expected: the limit is three workspaces per cwd and capacity is never resolved through automatic deletion or reset.

## Results report

For each section record:

- pass/fail/blocked;
- exact run, workspace, and result IDs;
- relevant revisions and refs;
- parent `git status --short` before and after;
- observed UI status/action;
- any unexpected mutation, automatic cleanup, lease release, or focus behavior.

Do not “fix” a failed test in this run. Preserve the state when safe, report it, and let the implementation agent decide the next recovery step.
