# `revise` Investigation

Status: investigation only; no implementation changes have been made.

This note records the current findings so the `revise` workflow can be fixed across multiple sessions. Do not modify `src/tools/agent/TODOS.md`; it is user-managed.

## Scope

The `revise` action is intended to continue work on an isolated worker result in the same persistent workspace after the parent provides feedback.

The main path is:

```text
agent(action="revise", runId, guidance)
  -> executeAgentAction()
  -> executeParentWorkspaceAction()
  -> resolve catalog run/workspace
  -> validate lease and prepared result
  -> reserve a new run identity
  -> transfer the workspace lease
  -> start a new foreground worker
  -> prepare the revised workspace result
```

Relevant files:

- `src/tools/agent/action-dispatch.ts`
- `src/tools/agent/workspaces/parent-actions.ts`
- `src/tools/agent/workspaces/results.ts`
- `src/tools/agent/workspaces/store.ts`
- `src/tools/agent/runs/manager.ts`
- `src/tools/agent/child.ts`
- `src/tools/agent/definitions/discovery.ts`
- `src/tools/agent/lifecycle.ts`

There is currently no execution-level regression test for `revise`. Existing tests cover parameter validation, rendering, isolated `spawn`/`collect`, and foreground finalization, but not the complete parent action.

## Confirmed findings

### 1. The revision prompt contains literal escape sequences

`src/tools/agent/workspaces/parent-actions.ts:158-162` currently builds the prompt with:

```ts
const revisionTask = [
    "Continue the delegated task in the existing isolated workspace. Inspect the current worktree and the previous result before making changes.",
    `Original task: ${record.task}`,
    `Parent feedback: ${params.guidance}`,
].join("\\n\\n");
```

The JavaScript string evaluates to literal backslash-`n` characters, not paragraph breaks. The child therefore receives a poorly formatted single prompt. Other prompt construction in this codebase uses `.join("\n\n")` and produces real newlines.

This matches the existing TODO note that the revise prompt is probably bad.

### 2. The reported ancestry error comes from an explicit safety guard

`src/tools/agent/workspaces/results.ts:62-65` checks:

```ts
const workerHead = await git(current.worktreePath, ["rev-parse", "HEAD"]);
if (!(await hasAncestor(current.worktreePath, current.baseRevision, workerHead))) {
    throw new Error(`Worker revision ${workerHead} is not based on workspace base ${current.baseRevision}.`);
}
```

The same ancestry assumption is used when applying a prepared result. It prevents a result whose Git history diverged from the workspace's recorded base from being treated as a normal workspace diff.

The historical workspace state associated with the TODO confirms the condition:

- recorded workspace base: `2a25160b7e79abcbd5519743a9c11aa02a07671c`
- later worktree result: `7d3594c78e875822279db770007e4562758f6abd`
- later result parent: `83df5bee30ffb767d7ed1ea5d340c514dd917ebd`
- `git merge-base --is-ancestor 2a25160... 7d3594c` fails

The earlier result `16dff4f` was based on `2a25160`. The worktree was subsequently rebased onto a different history, leaving the persisted workspace base stale. This explains the observed error exactly.

The guard may be correct as a safety policy, but the workflow must either preserve ancestry or explicitly support/reject divergent worktrees before starting a revision. It must not discover the problem only after the child has run.

### 3. A failed revision can strand the workspace lease

`parent-actions.ts:169-179` transfers the old lease to the new run before calling `manager.start()`:

```text
old run ID -> new run ID
then start the new worker
```

If the new worker reaches terminal state but `prepareForegroundWorkspaceResult()` fails during ancestry validation, the resulting state is:

- the new foreground run has been terminally removed and persisted;
- the workspace lease belongs to the new run ID;
- `workspace_results.latestResult` still belongs to the old run ID;
- no new prepared result was inserted;
- `executeAgentAction()` has no revise-specific rollback path.

Subsequent recovery is effectively blocked:

- the old run ID fails because the workspace is leased by the new run;
- the new run ID fails because the latest prepared result belongs to the old run;
- destructive workspace discard/recovery may be the only way out.

This is the highest-risk lifecycle defect. The same issue can occur for other failures after lease transfer, not only the ancestry check.

The transfer-before-start ordering was introduced when run-instance identity reservation was added. Earlier code started the worker first and transferred the lease afterward; that avoided this particular stranded-transfer window but had different concurrency/ownership tradeoffs.

### 4. `revise` creates a new child session rather than continuing the old transcript

`resume` reuses the existing child handle or reopens the persisted child session and exact transcript leaf. `revise` instead calls `manager.start()` with a new run identity and no `childSessionFile` or `childSessionLeafId`.

The new worker receives only:

- the generic revision instruction;
- the original catalog task;
- parent feedback;
- the existing worktree as its current directory.

It does not receive the previous child transcript, assistant findings, tool history, or explicit prior workspace revision metadata. This is potentially intentional—`revise` is a fresh worker pass in the same worktree—but it does not literally continue the child conversation and should be described/tested accordingly.

### 5. `revise` is only available while the original task lease remains held

`requireParentWorkspaceLease()` requires all of the following:

- the current parent session owns the lease;
- the lease still points to the requested run ID and instance;
- the lease kind is `task`;
- the latest workspace result is `prepared`.

Therefore revise works directly after a changed isolated `spawn` is collected or an isolated foreground run is finalized. It does not work after:

- `retain`, which intentionally releases the task lease;
- successful `apply`, which releases the task lease;
- `discard`, which makes the workspace reusable;
- no-change release.

This may be correct, but the user-facing contract should make it explicit. If retained/review-required results should also be revisable, the lease/result model needs a separate path.

## Secondary inconsistencies

### Model configuration is bypassed

`parent-actions.ts` calls:

```ts
const discovered = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
```

Initial `start`/`spawn` goes through `lifecycle.discover(ctx)`, which applies persisted built-in model configuration and advisor availability. `revise` bypasses that lifecycle method, so a revised built-in worker may lose its configured model override and use the parent model instead.

This is not the direct cause of the ancestry error, but it makes revise behavior inconsistent with initial execution.

### Definition/capability validation is weaker than resume

`resume` restoration validates definition fingerprints and mutation capability. `revise` only looks up the current definition by name. It does not explicitly verify that the current definition still matches the recorded source/capability identity or that it remains mutation-capable.

Normal isolated runs are initially restricted to the built-in edit-capable worker, but definition changes, missing definitions, legacy records, and future custom definitions should receive a deliberate policy rather than relying on `workspaceId` to infer isolation.

### Legacy run-instance compatibility may reject valid results

`resolveParentWorkspaceRun()` compares the latest workspace result's `runInstanceId` directly with the catalog record's `runInstanceId`. Older catalog records can receive synthesized physical IDs while older workspace results may still have a null run-instance ID. Such a pair can be reported as a newer/mismatched result even when it is the matching historical result.

This is a compatibility edge rather than the main current failure, but it should be covered if revise is made persistence-safe.

### New run IDs are expected after successful revise

A successful revise transfers ownership from, for example, `worker-1` to `worker-2`. The parent must use the returned new `details.runId` for subsequent `inspect`, `apply`, `discard`, or another `revise` action. Reusing the old ID should be rejected once the new result exists.

This is correct stale-run protection, but the result text and prompt guidance should make the ID transition obvious.

### Isolated mutation deadlocks are a broader related risk

The user-managed TODO documents a Pi agent-loop issue where mutation preflight can acquire a mutation lock before execution, while the lock is released only after the corresponding result. A second mutation in the same child batch can then wait forever during preflight.

This affects isolated workers generally, including revised workers, but it is not specific to the lease/result handoff. Keep it separate from the revise lifecycle fix.

## Recommended repair sequence

These are investigation conclusions, not implemented changes.

### Phase 1: Add observability and regression coverage

Add an execution-level test around the real registered tool/action path using a fake child and temporary Git repository/workspace metadata. Cover:

1. changed isolated `spawn` -> `collect` -> `revise`;
2. capture the exact revision prompt and assert real paragraph newlines;
3. assert the new worker uses the same workspace and a new run/run-instance identity;
4. assert the returned result is prepared under the new identity;
5. assert the old ID is stale and the new ID is the only valid disposition ID;
6. force a divergent worker HEAD and verify failure state, lease owner, latest result, and recoverability;
7. test a child/setup/start failure after lease handoff;
8. test the behavior after retain/apply/discard explicitly;
9. test configured worker model/definition behavior;
10. test legacy nullable/synthesized run-instance combinations.

Also add a focused prompt-rendering assertion so the escaped-newline regression cannot return.

### Phase 2: Fix prompt and definition resolution

- Change the revision task join to real newlines.
- Decide whether revision should use `lifecycle.discover(ctx)` or a shared definition-resolution helper that applies the same configuration and validation policy as initial start.
- Decide whether the new child session is intentionally fresh. If yes, document that revise continues the workspace task, not the prior transcript. If no, define how transcript/session continuation and branch identity should work.

### Phase 3: Make lease handoff failure-safe

Choose and test one ownership strategy:

- transfer only after the new run has been successfully created and is ready to execute; or
- retain transfer-before-start but provide an atomic/compensating rollback that restores the old lease when no new result was prepared; or
- create a first-class revision reservation/state in persistence so an interrupted handoff is recoverable and visible.

The chosen approach must preserve stale-run protections and must not allow another worker to claim the workspace during the handoff.

### Phase 4: Decide divergent-history policy

There are three broad options:

1. **Fail early and preserve state:** preflight the workspace ancestry before lease transfer and tell the parent to reset/reconcile explicitly.
2. **Normalize before revision:** explicitly rebase/reset the workspace and update persisted base/result metadata only through a safe, user-visible operation.
3. **Support divergent results:** define how to compute and apply a tree diff from a divergent worker head, including conflict checks and durable result refs, without weakening safety.

Do not silently update `baseRevision` or discard the prior result. The existing safety guard is protecting against ambiguous application.

### Phase 5: Validate manual lifecycle behavior

Use a disposable repository and the manual workspace checklist. Add a dedicated revise section that records:

- original run ID and result ID;
- revision run ID and result ID;
- workspace lease before/after;
- base and worker revisions before/after;
- prompt received by the revised child;
- behavior for clean descendant history;
- behavior for intentionally divergent history;
- recovery after child failure, cancellation, shutdown, and finalization failure.

## Current conclusion

The issue is not one isolated rendering or parameter bug. The strongest confirmed chain is:

```text
rebased/divergent worktree
  -> ancestry guard fails during revised result preparation
  -> lease was already transferred to the new run
  -> old prepared result remains associated with the old run
  -> revise becomes unrecoverable through normal run IDs
```

Independently, every revision currently receives a malformed prompt because of the escaped-newline join. These should be addressed first, followed by a deliberate decision about whether divergent worktree histories are supported or must be rejected before starting the child.
