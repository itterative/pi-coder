# Agent tool

`pi-coder` provides an in-process `agent` tool for delegated exploration and permission-gated implementation.

## Actions

```text
agent(action="list")
agent(action="start", agent="scout", title="Persistence audit", task="Investigate in the foreground ...")
agent(action="spawn", agent="scout", title="Concurrent reconnaissance", task="Investigate concurrently ...")
agent(action="status", runId="scout-1")
agent(action="collect", runId="scout-1")
agent(action="resume", runId="scout-1", guidance="...")
agent(action="cancel", runId="scout-1")
agent(action="spawn", agent="worker", task="Implement and validate the requested change")
```

Each run has a short human-readable title. Supply `title` on `start` or `spawn`; when omitted, pi-coder derives one from the first task line. The stable run ID remains the authoritative identifier and is displayed alongside the title.

`list` returns the currently tracked run IDs, titles, statuses, tasks, and next actions. Use it after compaction or session restoration instead of relying on dynamic parent prompt state.

A child may call `ask_parent` to pause its current turn. The parent receives its question and partial findings, may investigate independently, and resumes the retained child session by run ID. A `waiting_for_parent` result is paused rather than finished; a later `agent resume <run-id>` result should reach either another waiting state or `completed`. Collapsed TUI results show the pending question or a final-result preview, while expanded results include full details and usage.

In TUI mode, a foreground child may instead call its restricted `ask_user` tool when a preference, clarification, or decision genuinely requires direct end-user input. The existing pi-coder question component opens under a title such as `scout asks: ...`; the selected or custom answer returns to the same child turn, which then continues normally. Canceling the dialog gives the child a recoverable cancellation result. Aborting the parent operation or shutting down closes an active child dialog. Outside TUI mode, direct interaction returns an explicit unavailable result and tells the child to use `ask_parent` instead.

`spawn` returns immediately and lets up to four children execute concurrently. A bounded above-editor activity widget shows running (`●`), waiting (`?`), ready (`✓`), and failed (`!`) runs along with each live run's current sanitized tool action plus a short preview of its latest assistant response; it also retains up to three recent ready/failed rows. It updates asynchronously as child progress arrives. Waiting and terminal background changes are also coalesced in a bounded parent mailbox. After active parent work settles—or immediately when the parent is already idle—the mailbox sends one hidden custom message with `deliverAs: "followUp"` and `triggerTurn: true`. It automatically starts a parent mailbox turn without interrupting active work or injecting full child output. The marker contains only run IDs, statuses, and short question/result previews. Do not routinely poll with `status`: the spawn result explicitly tells the parent that an automatic notification will arrive when the child finishes or needs guidance. `status` remains available for deliberate inspection or recovery; after a terminal notification, `collect` returns and consumes the retained result. For an isolated worker, collection first finalizes the worktree into a workspace result and returns its workspace/result IDs and revisions; if the worker produced no changes, no durable ref is created and the lease is released for reuse. Changed results receive a durable ref, remain leased, and must be explicitly applied, retained, reset, or discarded; collection does not modify the parent checkout. A background child cannot open `ask_user`, because an unsolicited dialog could race the parent TUI; it pauses through `ask_parent` instead and can be resumed without becoming foreground. `status`, `resume`, `cancel`, and `collect` report only usage accrued since the previous parent tool result for that run.

The extension publishes typed lifecycle events on pi's shared `pi-coder:agent-event` channel. Run events cover creation, restoration, progress, status transitions, and removal; workspace events cover setup, leases, results, and removal; runtime events cover restoration, reconciliation, reset, and shutdown. Events contain cwd, timestamp, IDs, and bounded state metadata only—not transcripts or full output. They are invalidation/observation signals; consumers should reload authoritative state from the manager or workspace registry.

Up to four starting, running, waiting, or interrupted runs consume active capacity. The latest 20 uncollected background terminal results are retained separately; older IDs become stale. Runs have no TTL. Ephemeral parent sessions retain runtime-local behavior, but persisted parent sessions durably restore paused/interrupted runs and uncollected terminal results.

## Browse delegated sessions

Use `/agent-sessions` to open an overlay for delegated-agent sessions. The **Current** tab shows runs tracked by the active parent session, while **Past** lists durable child sessions stored for the current cwd. Titles, status, usage, and worker changed-file summaries are persisted in private metadata sidecars alongside child transcripts. Use Tab or Left/Right to switch tabs, Enter to open a read-only session detail view, `r` to resume an interrupted current run from its persisted transcript, and `c` to cancel a waiting or interrupted current run. Escape goes back or closes. Resuming from the browser uses a built-in safety instruction to inspect the current state first; waiting-for-parent runs still require guidance through `agent resume`. Canceling from the browser sends the parent an explicit user-canceled message telling it not to respawn or resume the run unless the user asks. The detail view shows session metadata, read/accessed paths, changed files, and the available transcript; it does not switch to or replay a child session.

## Browse isolated workspaces

Use `/agents` to open the unified agent browser. Its Current and Past tabs show delegated sessions (including internal workspace-setup agents), while Workspaces lists isolated workspaces for the current cwd, including setup state, lease state, Git clean/dirty state, changed-file counts, worktree path, and whether the workspace is available, leased, or requires review. Each project is limited to three persistent workspaces; reaching capacity reports the existing workspace leases instead of silently creating another worktree. Enter opens read-only session or workspace metadata. The workspace details view directly exposes `i` inspect diff, `a` apply, `t` retain, `r` reset for reuse, and `d` discard; the diff viewer stays in that same overlay and destructive actions require confirmation. While `/agents` is open, its visible overlay retains keyboard focus over nested non-overlay components. Workspaces marked `review_required` or holding a task lease are deliberately excluded from automatic reuse until explicitly dispositioned.

## Durable child sessions

When the parent has a persisted pi session, child transcripts are stored relative to this installed extension at `<pi-coder-install>/.state/agent-sessions/--<encoded-cwd>--/<parent-session-id>/`; the parent-session directory uses mode `0700`. The cwd layer mirrors pi's `--<encoded-cwd>--` session-directory format, while the extension-local root isolates multiple installed copies and avoids collisions with pi or other extensions. The install and storage locations are exported from `src/common/constants.ts`, cwd encoding is centralized in `normalizeCwdForSessionDirectory()`, and `.state/` is gitignored. The extension directory must be writable, and uninstalling or replacing that directory may remove its durable child transcripts. Versioned run-state entries are journaled in the parent session without entering LLM context. Reload, restart/continue, and switching away from and back to the exact parent session restore its active runs. New, forked, and cloned parent sessions have different IDs and do not inherit those children. In-place `/tree` navigation rebuilds runs from the newly selected branch; navigation is blocked while a child is actively streaming or waiting for mutation permission, so first let it pause/finish or cancel it.

A child paused at `ask_parent` restores as `waiting_for_parent`. A child that was starting or running when shutdown/crash occurred restores as `interrupted`; it never restarts, replays a tool, or resumes automatically. The user can press `r` in `/agent-sessions` to continue the persisted transcript, or explicitly direct the parent to use `agent resume`; either path uses a safety instruction to inspect uncertain tool outcomes first. Any unmatched crash-time tool calls receive synthetic error results saying their outcome is uncertain, so a worker must inspect checkout state before retrying. Current agent definitions are fingerprinted and revalidated, and persisted metadata cannot grant or remove worker mutation capability.

Uncollected background terminal outcomes restore from bounded parent metadata without reopening their child transcript. Collection, cancellation, and terminal-result eviction append a removal tombstone but retain the child transcript so `/agent-sessions` can browse past work. Child transcripts contain raw conversation and tool-result content rather than sanitized trace previews; keep the private storage directory confidential. A later explicit prune policy can remove old transcripts, and parent sessions deleted outside pi may leave orphan directories until that policy is added.

## Built-in worker

The built-in `worker` operates in the existing checkout with `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`. Only one worker may be starting, running, or waiting at a time, while read-only scouts can continue concurrently. Foreground and background workers are supported.

Every worker `edit`, `write`, and `bash` call enters the shared abort-aware permission queue and opens a parent-visible prompt labelled with its title and run ID. Approvals are one-shot and never become parent or child session rules. File paths remain cwd-confined with sensitive and symlink escapes blocked before prompting. Bash honors configured denial and sandbox/direct policy; unresolved commands default to sandbox when bubblewrap is available and the prompt permits toggling to direct mode. Mutation calls are serialized through completion, so concurrent child tool calls cannot overlap mutations.

The activity widget shows `waiting_for_permission` while a gate is queued or open. Canceling the run closes or removes its prompt. Successful `edit`/`write` paths are tracked in a terminal mutation report. Because approved bash and concurrent parent activity can change arbitrary checkout files, the report explicitly warns when attribution may be incomplete; inspect the final diff before committing.

## Agent definitions

The built-in `scout` and `worker` require no configuration. Custom definitions use Markdown with YAML frontmatter:

```markdown
---
name: reviewer
description: Inspect architecture and identify risks
tools: [read, grep, find, ls]
model: provider/model-id
---

Agent-specific instructions go here.
```

Locations:

- user: `~/.pi/agent/agents/*.md`
- project: nearest `.pi/agents/*.md`, only when pi trusts the project

Definitions are sorted by path. Within one scope, the first valid duplicate wins and later files warn. Trusted-project definitions override user definitions with an informational diagnostic. Built-in names `scout` and `worker` are reserved.

Custom definitions cannot raise the read-only capability ceiling. Unsupported tools are removed with a warning; every enabled `read`, `grep`, `find`, and `ls` path is confined to the working directory and sensitive paths remain blocked.

## Manual stabilization checklist

Run these checks after changing child sessions, providers, lifecycle handling, or rendering:

1. Start `scout` with OpenAI Codex OAuth and, separately, one API-key provider.
2. Have the child call `ask_parent`; verify the compact result shows its question and run ID, then resume it to completion.
3. Have the child call `ask_user`; select an option and verify the child continues to completion in the same turn. Repeat with a custom reply, Escape cancellation, and parent abort while the dialog is open.
4. Exercise two consecutive `ask_parent` cycles and verify prior usage is not counted again in each resume result.
5. Spawn two independent scouts in one parent tool batch; verify both calls return immediately, both run concurrently, and the activity widget changes from `●` to `✓` without interrupting the parent turn.
6. After a background run settles, verify its hidden mailbox marker automatically starts a parent turn: immediately if idle, or only after existing parent work settles. Verify it never steers or stops the active turn, and collecting/canceling before pending delivery suppresses stale markers.
7. Have a background child call `ask_parent`; verify it waits without opening a direct-user dialog, its question arrives through the automatic follow-up mailbox, then it resumes in the background and can be collected.
8. Cancel a waiting foreground run and a running background run, then verify both run IDs are stale. Start another run and verify IDs are not reused.
9. Reload while a child is waiting and while one is running. Verify the waiting child restores with the same ID/question, the running child restores as `interrupted`, no tool replays or resumes automatically, `r` continues an interrupted run from `/agent-sessions`, and `c` cancels it with a user-canceled parent message. Restart pi and switch away/back to repeat the restoration check.
10. Fill all four active run slots and verify a fifth start/spawn is rejected; verify uncollected terminal background results do not consume active capacity.
11. Verify a user agent loads, a trusted-project agent overrides it, and an untrusted project definition does not load.
12. Ask the scout to access an absolute outside path, `..` escape, sensitive file, and in-cwd symlink to an outside target; all must be blocked without prompting.
13. Start a background worker and request one edit, one write, and one bash call. Verify every prompt names the worker run, queued mutations do not overlap, the widget shows permission waiting, denial is recoverable, and cancel closes an active gate.
14. Try a second worker while the first is active; verify it is rejected while a scout can still start. Confirm outside/sensitive file paths and configured-deny bash commands block without an approval bypass.
15. Complete a worker after edit/write and approved bash calls. Verify its mutation report lists tracked paths, includes the bash attribution caveat, and the actual checkout diff matches expectations.
16. Produce long findings and expand/collapse the result; verify the compact preview stays useful and expanded activity/usage remain readable.

Provider calls stay manual so automated tests do not require credentials or incur usage.

For a focused manual workspace lifecycle pass, use [`WORKSPACE-MANUAL-VALIDATION.md`](./WORKSPACE-MANUAL-VALIDATION.md). It covers no-change reuse, saved diffs, apply/retain/reset/discard, preflight failures, and reload recovery.

## Diagnostic traces

The intended release behavior is to enable delegated-agent tracing with `PI_CODER_AGENT_TRACE=1`. During current agent development, `isAgentTraceEnabled()` is temporarily hardcoded on, so `/agent-trace` is registered without the flag.

Tracing registers `/agent-trace` and keeps bounded, sanitized in-memory timelines for the latest 20 runs, with at most 400 events per run. It records lifecycle transitions, assistant message boundaries and short previews, tool names and sanitized arguments, result lengths/status, interaction outcomes, settlement, errors, and usage. It does not record file/tool result contents or credentials.

```text
/agent-trace                    # list recent traces
/agent-trace scout-1            # inspect one timeline
/agent-trace scout-1 save       # save sanitized JSON explicitly
/agent-trace clear              # discard retained traces
```

Saved traces use mode `0600` under `~/.pi/agent/traces/`. Trace IDs are parent-runtime-local. Reloading or restarting loses in-memory traces, so inspect or save a problematic run before reload. Short task/question/assistant previews can still contain project context; review saved JSON before sharing it.
