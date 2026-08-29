# `revise` Investigation

Status: investigation plus implementation passes. The continuation/session flow, original-model selection, lifecycle discovery, early divergent-history rejection, non-isolated read-only continuation, and stable run identity are implemented; broader recovery coverage remains open.

This note records the findings and remaining work so the `revise` workflow can be fixed across multiple sessions. Do not modify `src/tools/agent/TODOS.md`; it is user-managed.

## Scope

The `revise` action continues a collected terminal child run after the parent provides feedback. Isolated worker results continue in the same persistent workspace; collected non-mutating runs such as reviewer continue in their original execution cwd without a workspace.

The main path is:

```text
agent(action="revise", runId, guidance)
  -> executeAgentAction()
  -> executeParentWorkspaceAction()
  -> resolve the active-branch run checkpoint (and workspace when isolated)
  -> validate lease and prepared result
  -> reserve the existing run identity
  -> start a foreground continuation using the original child session
  -> retain the workspace lease for that identity
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

Regression coverage now includes an end-to-end temporary-Git/SQLite test in `test/tools/agent-revise-e2e.test.ts` covering the registered background `start`/`collect`/`revise` lifecycle. Focused manager and parent-action tests remain useful for failure-specific cases not covered by that scenario.

## Confirmed findings

### 1. The revision prompt contained literal escape sequences (resolved)

`src/tools/agent/workspaces/parent-actions.ts:158-162` currently builds the prompt with:

```ts
const revisionTask = [
    "Continue the delegated task in the existing isolated workspace. Inspect the current worktree and the previous result before making changes.",
    `Original task: ${record.task}`,
    `Parent feedback: ${params.guidance}`,
].join("\\n\\n");
```

The JavaScript string evaluates to literal backslash-`n` characters, not paragraph breaks. The child therefore receives a poorly formatted single prompt. Other prompt construction in this codebase uses `.join("\n\n")` and produces real newlines.

This matches the existing TODO note that the revise prompt is probably bad. The current implementation no longer constructs this synthetic task/context prompt; it sends only the revision guidance as the next child message.

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

The guard is correct as a safety policy. The current `revise` path now performs this ancestry check before run identity reservation or child startup, rejects divergence, and preserves the existing result and lease. It does not silently normalize or accept divergent worktrees.

### 3. A failed revision could strand the workspace lease (partially resolved)

The earlier implementation transferred the old lease to a new run before calling `manager.start()`. The current implementation retains the public and physical run identity, so the existing lease remains valid while the continued worker starts.

If the new worker reaches terminal state but `prepareForegroundWorkspaceResult()` fails during ancestry validation, the resulting state is:

- the new foreground run has been terminally removed and persisted;
- the workspace lease remains associated with the same public run ID;
- `workspace_results.latestResult` still belongs to the prior result record for that run;
- no new prepared result was inserted;
- `executeAgentAction()` has no revise-specific rollback path.

Subsequent recovery is effectively blocked:

- the stable run ID must continue to resolve the prior physical result identity;
- a mismatched physical run instance would fail because the latest prepared result belongs to the prior continuation;
- destructive workspace discard/recovery may be the only way out.

The earlier transfer-before-start ordering was introduced when run-instance identity reservation was added. Stable identity reuse now avoids that handoff window entirely: the existing lease protects the workspace through continuation and finalization. Focused action-level tests cover continuation failure, stable lease retention, finalization failure, and divergent worktree behavior; real temporary-Git state assertions for some failure paths remain.

### 4. `revise` created a new child session rather than continuing the old transcript (resolved)

`resume` reuses the existing child handle or reopens the persisted child session and exact transcript leaf. `revise` starts a new manager run wrapper with the existing run identity and the persisted `childSessionFile` and `childSessionLeafId`.

The continued worker receives only:

- the generic revision instruction;
- the original catalog task;
- parent feedback;
- the existing worktree as its current directory.

It did not receive the previous child transcript, assistant findings, tool history, or explicit prior workspace revision metadata. The current implementation passes the original `childSessionFile` and exact persisted leaf to `startContinuation()`, so the child runtime reopens that transcript and appends only the revision guidance. The public run ID remains stable; the continued child reuses the same physical identity, while workspace finalization creates a new result record.

### 5. Isolated `revise` is only available while the original task lease remains held

For isolated worker results, `requireParentWorkspaceLease()` requires all of the following:

- the current parent session owns the lease;
- the lease still points to the requested run ID and instance;
- the lease kind is `task`;
- the latest workspace result is `prepared`.

Therefore revise works directly after a changed isolated background `start` is collected or an isolated foreground run is finalized. It does not work after:

- `retain`, which intentionally releases the task lease;
- successful `apply`, which releases the task lease;
- `discard`, which makes the workspace reusable;
- no-change release.

This may be correct, but the user-facing contract should make it explicit. If retained/review-required results should also be revisable, the lease/result model needs a separate path.

## 6. Non-isolated revision uses active-branch authority

Non-mutating revisions now resolve through the manager's checkpoints loaded from or written to the active parent branch, rather than the cross-branch catalog. The exact parent session is still required. The stable non-mutating run checkpoint is updated after each revision, so a later `revise` continues the latest child leaf rather than unexpectedly forking from the original request; isolated workers continue to use workspace lease/result ownership.

## Secondary inconsistencies

### Model configuration was bypassed (resolved)

`parent-actions.ts` calls:

```ts
const discovered = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
```

Initial `start` (foreground or background) goes through `lifecycle.discover(ctx)`, which applies persisted built-in model configuration and advisor availability. `revise` bypasses that lifecycle method, so a revised built-in worker may lose its configured model override and use the parent model instead.

This is not the direct cause of the ancestry error, but it made revise behavior inconsistent with initial execution. The current path uses the lifecycle discovery callback, and reopened child sessions prefer the model recorded in their transcript over the current definition's model override.

### Definition/capability drift is informational for resume and revise

Restorable runs now persist the complete definition used at startup. `resume` and `revise` use that snapshot for the runtime contract while comparing the current definition only to report informational drift. A changed definition or capability set does not invalidate the run; a missing or malformed persisted snapshot fails clearly because the original contract cannot be reconstructed.

Normal isolated runs remain restricted to the built-in edit-capable worker. Persisted metadata cannot grant mutation authority: an edit-capable snapshot still requires current built-in-worker authorization. The persisted snapshot supplies the role/tools contract, while the child session remains authoritative for conversation/model continuity.

### Legacy run-instance compatibility may reject valid results

`resolveParentWorkspaceRun()` compares the latest workspace result's `runInstanceId` directly with the catalog record's `runInstanceId`. Older catalog records can receive synthesized physical IDs while older workspace results may still have a null run-instance ID. Such a pair can be reported as a newer/mismatched result even when it is the matching historical result.

This is a compatibility edge rather than the main current failure, but it should be covered if revise is made persistence-safe.

### Stable run IDs after successful revise

A successful revise retains the same public and physical identity, for example `worker-1`. The parent continues using that same `details.runId` for subsequent `inspect`, `apply`, `discard`, or another `revise` action; repeated revision resolves the latest persisted child leaf.

This stable-ID behavior keeps the parent UI focused on one agent while each isolated revision still creates a new workspace result record.

### Isolated mutation deadlocks are a broader related risk

The user-managed TODO documents a Pi agent-loop issue where mutation preflight can acquire a mutation lock before execution, while the lock is released only after the corresponding result. A second mutation in the same child batch can then wait forever during preflight.

This affects isolated workers generally, including revised workers, but it is not specific to the lease/result handoff. Keep it separate from the revise lifecycle fix.

## Recommended repair sequence

The first implementation pass addressed the prompt/session continuation and partial lease-handling work described above. The following items remain investigation/fix work.

### Phase 1: Expand observability and regression coverage

The current pass added focused manager and parent-action tests plus an end-to-end registered-tool test with a fake child, real child transcript, temporary Git repository, and SQLite workspace metadata. Extend that coverage with real failure-state and disposition cases. Cover:

1. changed isolated background `start` -> `collect` -> `revise`;
2. capture the exact revision prompt and assert real paragraph newlines;
3. assert the continued worker uses the same workspace and the same public/physical run identity;
4. assert the returned result is prepared under the stable identity;
5. assert the stable public ID remains valid and identifies the revised result;
6. force a divergent worker HEAD and verify failure state, lease owner, latest result, and recoverability;
7. test a child/setup/start failure while the existing lease remains held;
8. test the behavior after retain/apply/discard explicitly;
9. test configured worker model/definition behavior;
10. test legacy nullable/synthesized run-instance combinations.

Also add a focused prompt-rendering assertion so the escaped-newline regression cannot return.

### Phase 2: Fix prompt and definition resolution

- The revision prompt/session continuation fix is complete.
- The current path uses lifecycle discovery for diagnostics, then uses the persisted definition snapshot and child transcript. Definition changes intentionally do not invalidate resume/revise; missing snapshots fail clearly.
- The current implementation deliberately preserves the public and physical run identity while continuing the old child session. Preserve and document this stable-ID behavior in future changes.

### Phase 3: Preserve lease ownership during revision

The stable public/physical identity removes the lease handoff window: continuation and result finalization run while the existing lease remains held. Failure coverage should continue to verify that the prior prepared result and lease remain recoverable, and that another worker cannot claim the workspace during revision.

### Phase 4: Decide divergent-history policy — chosen

The implementation chooses **fail early and preserve state**. `revise` checks the current worktree HEAD against the recorded base before starting a child or transferring the lease. A divergent worktree is rejected with an explicit reconciliation/reset message, while the existing result and lease remain intact. The alternatives considered were:

1. **Fail early and preserve state:** preflight the workspace ancestry before lease transfer and tell the parent to reset/reconcile explicitly.
2. **Normalize before revision:** explicitly rebase/reset the workspace and update persisted base/result metadata only through a safe, user-visible operation.
3. **Support divergent results:** define how to compute and apply a tree diff from a divergent worker head, including conflict checks and durable result refs, without weakening safety.

Do not silently update `baseRevision` or discard the prior result. The existing safety guard is protecting against ambiguous application.

### Phase 5: Validate manual lifecycle behavior

Use a disposable repository and the manual workspace checklist. Add a dedicated revise section that records:

- stable run ID and original result ID;
- stable run ID and revised result ID;
- workspace lease before/after;
- base and worker revisions before/after;
- prompt received by the revised child;
- behavior for clean descendant history;
- behavior for intentionally divergent history;
- recovery after child failure, cancellation, shutdown, and finalization failure.

## Current conclusion

The issue is not one isolated rendering or parameter bug. Before the first implementation pass, the strongest confirmed chain was:

```text
rebased/divergent worktree
  -> ancestry guard fails during revised result preparation
  -> the stable run identity remains associated with the existing lease
  -> the prior prepared result remains available until a revised result is finalized
  -> revise remains recoverable through the same run ID
```

The prompt/session portion is now corrected: revise reopens the original child transcript, preserves its recorded model, and sends only the revision guidance. Collected non-mutating runs now resolve through active-branch manager checkpoints and retain a stable public/physical identity while continuing from the latest child leaf without a workspace. The existing isolated lease remains held through continuation and finalization without an ownership handoff. The divergent-history decision is now settled: isolated revisions fail before child startup when ancestry is broken. Remaining work is broader real-state failure coverage, explicit disposition behavior, definition validation, legacy compatibility, and manual lifecycle validation.
