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

In TUI mode, a foreground child may instead call its restricted `ask_user` tool when a preference, clarification, or decision genuinely requires direct end-user input. The advisor intentionally does not receive this tool and uses `ask_parent` for all guidance. The existing pi-coder question component opens under a title such as `scout asks: ...`; the selected or custom answer returns to the same child turn, which then continues normally. Canceling the dialog gives the child a recoverable cancellation result. Aborting the parent operation or shutting down closes an active child dialog. Outside TUI mode, direct interaction returns an explicit unavailable result and tells the child to use `ask_parent` instead.

`spawn` returns immediately and lets up to four children execute concurrently. A bounded above-editor activity widget shows running (`⠋`), waiting (`?`), ready (`✓`), and failed (`!`) runs. Running rows include elapsed time, a short first-line preview of the latest assistant message, grouped tool-call counts, and the current sanitized tool action; the spinner animates without displaying model reasoning. The widget also retains up to three recent ready/failed rows. It updates asynchronously as child progress arrives. Waiting and terminal background changes are also coalesced in a bounded parent mailbox. After active parent work settles—or immediately when the parent is already idle—the mailbox sends one hidden custom message with `deliverAs: "followUp"` and `triggerTurn: true`. It automatically starts a parent mailbox turn without interrupting active work or injecting full child output. The marker contains only run IDs, statuses, and short question/result previews. Do not routinely poll with `status` or wait by sleeping: if no other parent work remains, report progress to the user and end the turn; the automatic notification will arrive when the child finishes or needs guidance. `status` remains available for deliberate inspection or recovery; after a terminal notification, `collect` returns and consumes the retained result. For an isolated worker, collection first finalizes the worktree into a workspace result and returns its workspace/result IDs and revisions; if the worker produced no changes, no durable ref is created and the lease is released for reuse. Changed results receive a durable ref, remain leased, and do not modify the parent checkout. The parent can inspect, apply, discard, or revise them through agent actions; retain/reset and the diff viewer remain available in the TUI. A background child cannot open `ask_user`, because an unsolicited dialog could race the parent TUI; it pauses through `ask_parent` instead and can be resumed without becoming foreground. `status`, `resume`, `cancel`, and `collect` report only usage accrued since the previous parent tool result for that run.

The extension publishes typed lifecycle events on pi's shared `pi-coder:agent-event` channel. Run events cover creation, restoration, progress, status transitions, and removal; workspace events cover setup, leases, results, and removal; runtime events cover restoration, reconciliation, reset, and shutdown. Events contain cwd, timestamp, IDs, and bounded state metadata only—not transcripts or full output. They are invalidation/observation signals; consumers should reload authoritative state from the manager or workspace registry.

Up to four starting, running, waiting, or interrupted runs consume active capacity. The latest 20 uncollected background terminal results are retained separately; older IDs become stale. Runs have no TTL. Ephemeral parent sessions retain runtime-local behavior, but persisted parent sessions durably restore paused/interrupted runs and uncollected terminal results.

## Browse delegated sessions

Use `/agents` to open the unified delegated-agent and workspace browser. The **Agents** view defaults to runs tracked by the active parent session, including its durable child sessions; press `h` to toggle the cwd-wide historical view. Active and historical rows are labeled separately. Full run state and the shared agent catalog are persisted in the extension's SQLite metadata database; child transcripts remain in private JSONL files. Restoration uses immutable V2 snapshots referenced by small parent-tree markers, with an exact child transcript leaf for each checkpoint. Older branch checkpoints remain inspectable but cannot resume after the physical run continued elsewhere. For isolated results, the parent can use `agent` actions `inspect`, `apply`, `discard`, and `revise` with the run ID to review or disposition a result without opening the TUI; `revise` starts another worker in the same workspace with parent guidance. Use Tab or Left/Right to switch tabs, Enter to open a read-only session detail view, `r` to resume an interrupted current run from its persisted transcript, and `c` to cancel a waiting or interrupted current run. Escape goes back or closes. Resuming from the browser uses a built-in safety instruction to inspect the current state first; waiting-for-parent runs still require guidance through `agent resume`. Canceling from the browser sends the parent an explicit user-canceled message telling it not to respawn or resume the run unless the user asks. The detail view shows session metadata, read/accessed paths, changed files, and the complete active transcript: user/custom/assistant messages plus compact tool calls. Failed calls use `×`; edit calls show removed (`-`) and added (`+`) lines, while bash calls show their command. Consecutive tool-only responses stay together without blank rows. For a current starting/running/permission-waiting delegate, the open detail view reloads on agent events and follows new content until you scroll up; press `End` to resume following. Model thinking and potentially large tool-result output are currently omitted. It does not switch to or replay a child session.

## Browse isolated workspaces

Use `/agents` to open the unified agent browser. Its Agents view shows delegated sessions (including internal workspace-setup agents), while Workspaces lists isolated workspaces for the current cwd, including setup state, lease state, Git clean/dirty state, changed-file counts, worktree path, and whether the workspace is available, leased, or requires review. Each project is limited to three persistent workspaces; reaching capacity reports the existing workspace leases instead of silently creating another worktree. Enter opens read-only session or workspace metadata. The workspace details view directly exposes `i` inspect changes, `a` apply, `t` retain, `r` reset for reuse, `d` discard, and `l` release a stale clean task lease; the result inspection stays in that same overlay and destructive or recovery actions require confirmation. While `/agents` is open, its visible overlay retains keyboard focus over nested non-overlay components. Workspaces marked `review_required` or holding a task lease are deliberately excluded from automatic reuse until explicitly dispositioned.

## Durable child sessions

When the parent has a persisted pi session, child transcripts are stored relative to this installed extension at `<pi-coder-install>/.state/agent-sessions/--<encoded-cwd>--/<parent-session-id>/`; the parent-session directory uses mode `0700`. The cwd layer mirrors pi's `--<encoded-cwd>--` session-directory format, while the extension-local root isolates multiple installed copies and avoids collisions with pi or other extensions. The install and storage locations are exported from `src/common/constants.ts`, cwd encoding is centralized in `normalizeCwdForSessionDirectory()`, and `.state/` is gitignored. The extension directory must be writable, and uninstalling or replacing that directory may remove its durable child transcripts. Full run-state snapshots are stored in the extension's SQLite metadata database and scoped to parent-session branch entries without entering LLM context. Reload, restart/continue, and switching away from and back to the exact parent session restore its active runs. New, forked, and cloned parent sessions have different IDs and do not inherit those children. In-place `/tree` navigation rebuilds runs from the newly selected branch; navigation is blocked while a child is actively streaming or waiting for mutation permission, so first let it pause/finish or cancel it.

A child paused at `ask_parent` restores as `waiting_for_parent`. A child that was starting or running when shutdown/crash occurred restores as `interrupted`; it never restarts, replays a tool, or resumes automatically. The user can press `r` in `/agents` to continue the persisted transcript, or explicitly direct the parent to use `agent resume`; either path uses a safety instruction to inspect uncertain tool outcomes first. Any unmatched crash-time tool calls receive synthetic error results saying their outcome is uncertain, so a worker must inspect checkout state before retrying. Current agent definitions are fingerprinted and revalidated, and persisted metadata cannot grant or remove the built-in worker's `edit` capability.

Uncollected background terminal outcomes restore from bounded parent metadata without reopening their child transcript. Collection, cancellation, and terminal-result eviction append a removal tombstone but retain the child transcript so `/agents` can browse past work. Child transcripts contain raw conversation and tool-result content rather than sanitized trace previews; keep the private storage directory confidential. A later explicit prune policy can remove old transcripts, and parent sessions deleted outside pi may leave orphan directories until that policy is added.

## Garbage-collection reporting

A parked dry-run report script, `tools/report-agent-gc.mjs`, is available in git stash `0ccdbf040be633195333a0fb6c7c07dcb9190c0f` (restore with `git stash apply 0ccdbf040be633195333a0fb6c7c07dcb9190c0f`). When restored, run `node tools/report-agent-gc.mjs` to produce a read-only report for the current cwd. It scans parent-session markers and the extension metadata database, then reports marker-reachable/protected/unreachable snapshots, orphan child transcripts, total and potentially reclaimable transcript bytes, and database/catalog references to missing child JSONL files. It accepts `--cwd`, `--state-dir`, `--parent-session-dir`, and `--json`. The report does not delete files or database rows. Actual garbage collection remains intentionally unimplemented until a retention policy is established; the safest initial candidate is orphan JSONL files, while snapshots and referenced transcripts should remain retained.

## Child prompt design

Delegated child instructions are written for the child model, not as a description of extension internals. Describe behavior the child can observe and act on: a tool call runs immediately, may pause while the end user approves or denies it, or is blocked. Avoid UI-oriented phrases such as “opens another prompt” or “parent-visible prompt,” internal heuristic names, and lifecycle facts that do not change what the child should do.

Use terminology consistently:

- **parent** means the coding agent that delegated the task and receives the final report;
- **end user** means the person who answers questions and approves eligible tool calls;
- **current working directory** means the checkout or isolated worktree available to the child;
- **temporary scratchpad** means the private `/tmp` directory supplied to a runtime with the `scratchpad` capability.

The system prompt has two layers. The role in `definitions/discovery.ts` states the agent's purpose, investigation or implementation standards, and expected report. The operating protocol in `child/extension.ts` states the tools and restrictions of the particular run, including read/search, command-runner, and edit access, same-checkout versus isolated behavior, interaction availability, and approval outcomes. Keep capability mechanics out of role text so the two layers do not duplicate or contradict each other. Dynamic repository or parent context belongs in the initial task message rather than either system-prompt layer.

Treat complete rendered prompts as the test contract. `test/tools/agent-prompt.test.ts` uses file snapshots for every built-in role and each distinct worker run mode, including same-checkout and isolated worktree. Prefer reviewing those snapshots over fragment assertions; when wording or a run mode changes, update and inspect the complete affected snapshots.

## Safety scope and trust boundary

Delegated-agent restrictions are local permission and accident-prevention controls, **not a security sandbox**. Pi-coder trusts the machine and local development environment that started Pi: the Pi process environment (including `PATH` and `GIT_*`), installed executables, Git configuration, and the selected checkout. It does not attempt to defend against a user who has made those inputs hostile, nor verify that an allowlisted command cannot be replaced by that environment. A dedicated OS sandbox is the appropriate boundary when that threat model is required.

Within that trusted environment, child capabilities prevent model-initiated actions outside their stated authority: read-only children cannot deliberately write the project through normal tools, direct read/search paths stay within cwd or the private temporary scratchpad, `command-runner` commands use the permission flow, and `edit` calls use the appropriate same-checkout or scratchpad access behavior. Scratchpad paths are prompt-free, including sensitive-looking filenames, but symlink targets must remain confined. The cwd-confinement heuristic reduces prompts for a curated set of ordinary commands; `SAFE_READONLY` means *heuristically non-project-mutating*, not that no invoked program or configured helper can ever have a side effect.

Commands such as `npm install` are intentionally outside this heuristic because they can mutate files and execute package lifecycle scripts. Pi-coder does not attempt to inspect or certify those scripts; command-capable agents use the normal approval flow instead.

Tool results are passed to the configured model provider just as ordinary read/search results are. Users should therefore select the project, agent, and provider with the same care as for a normal Pi session.

## Built-in scout

The built-in `scout` has `read`, `grep`, `find`, `ls`, and a restricted `bash` tool. A scout bash call runs directly only when the cwd-confinement heuristic classifies the complete command as `SAFE_READONLY`. This permits the curated non-project-mutating command set within the working directory, including Git status and diff inspection, full patch output, and historical `show`/`log` content, while rejecting unknown commands, project working-tree writes, outside paths, sensitive project paths, symlink escapes, unsafe flags, external-program and output-file options, and every `SAFE_EDIT` command. Normal Git metadata refreshes such as an index stat-cache update are allowed. The current implementation additionally rejects `git status` when `core.fsmonitor` names an external helper; this is a narrow defense-in-depth rule, not a complete guarantee about the trusted Git environment. Rejections include a short explanation plus the heuristic's stable structured reason code; no prompt or approval bypass is available. Custom agents receive codebase-read tools by default and may explicitly opt into this behavior with the `safe-bash` capability.

## Built-in reviewer

The built-in `reviewer` has the scout's read/search tools and permission-gated `bash`. It uses ordinary safe-bash Git history commands such as `git log` and `git show`, including historical patch content, to inspect relevant commits. Other commands, including project-specific test commands, use the normal parent permission prompt. Approved commands may have project side effects; there is no separate history capability, output filter, or secret scanner.

## Built-in worker

The built-in `worker` operates in the existing checkout with `read`, `grep`, `find`, `ls`, `edit`, `write`, and permission-gated `bash`. Only one edit-capable worker may be starting, running, or waiting at a time, while read-only and command-capable agents can continue concurrently. Foreground and background workers are supported.

Same-checkout `edit` capability calls inside the working directory use the parent's existing access and do not open a second mutation prompt. Temporary scratchpad reads and edits are also prompt-free. Outside-cwd reads and edits use the existing pi file-access prompt, including its session-scoped folder approval; sensitive project paths and symlink escapes remain blocked. `command-runner` Bash honors configured and inherited session rules without prompting when already allowed. Unresolved commands use the parent-visible sandbox/direct prompt and can be remembered for the session. Isolated workers retain their independent permission state and do not inherit parent session rules. Permission-gated calls are serialized through completion, so concurrent child calls cannot overlap.

The activity widget shows `waiting_for_permission` while a gate is queued or open. Canceling the run closes or removes its prompt. Successful `edit`/`write` paths are tracked in a terminal mutation report and drive immediate busy-parent change notifications. SAFE_EDIT heuristics and approved bash authorize commands but do not provide reliable path attribution for arbitrary command effects; such changes may be missing from immediate notifications and individual path lists. The report explicitly warns when attribution may be incomplete; inspect the final diff before committing.

## Agent definitions

The built-in `reviewer` and `worker` require no definition files and include the `memories` and `scratchpad` capabilities. The read-only `scout` and `advisor` include `memories` but do not need scratchpads. The advisor is disabled by default and must be enabled and assigned a model in `/agents` before use. Custom definitions use Markdown with YAML frontmatter:

```markdown
---
name: analyst
description: Inspect architecture and identify risks
capabilities: [safe-bash, memories, scratchpad]
model: provider/model-id
---

Agent-specific instructions go here.
```

Locations:

- user: `~/.pi/agent/agents/*.md`
- project: nearest `.pi/agents/*.md`, only when pi trusts the project

Definitions are sorted by path. Within one scope, the first valid duplicate wins and later files warn. Trusted-project definitions override user definitions with an informational diagnostic. Built-in names `scout`, `reviewer`, `advisor`, and `worker` are reserved.

The `/agents` browser also has a Settings tab. It stores optional built-in model overrides and the busy-worker change-notification preference in `~/.pi/agent-config.json` (or the nearest trusted project `.pi/agent-config.json` when that file already exists). Omitting a model override makes ordinary built-ins use the parent session's model; the advisor must have an explicit model override before it can run. Busy-worker notifications are enabled by default. The model picker lists the currently available provider/model pairs.

Every custom definition receives baseline `read` and `search` access (`read`, `grep`, `find`, and `ls`). Its optional `capabilities` may contain `memories`, `scratchpad`, `safe-bash`, or `command-runner`; `memories` loads pi-coder's memory extension in the child session, `scratchpad` creates a private temporary `/tmp` workspace in the child session, `edit` is reserved for the built-in worker, and unknown or malformed capability lists invalidate the definition. `safe-bash` grants only cwd-confined, heuristically `SAFE_READONLY` Bash, while `command-runner` implies `safe-bash` and routes other commands through the normal permission gate. Every baseline read/search path is confined to the working directory and sensitive paths remain blocked.

`agent` `start` and `spawn` actions may include bounded `context.sections` with `id`, `title`, `content`, and a source of `parent`, `repository`, or `workspace`. Built-in definitions can declare a context policy that selects sections and applies a character budget. The selected context is rendered into the initial task message, not the system prompt, and is retained by the child transcript for resumed runs. The built-in advisor currently accepts `parent_summary`, `recent_context`, and `implementation_state`; automatic collection of those sections is deferred.

## Manual stabilization checklist

Run these checks after changing child sessions, providers, lifecycle handling, or rendering:

1. Start `scout` with OpenAI Codex OAuth and, separately, one API-key provider.
2. Have the child call `ask_parent`; verify the compact result shows its question and run ID, then resume it to completion.
3. Have the child call `ask_user`; select an option and verify the child continues to completion in the same turn. Repeat with a custom reply, Escape cancellation, and parent abort while the dialog is open.
4. Exercise two consecutive `ask_parent` cycles and verify prior usage is not counted again in each resume result.
5. Spawn two independent scouts in one parent tool batch; verify both calls return immediately, both run concurrently, the activity widget animates while they reason and changes to `✓` when ready, without interrupting the parent turn.
6. After a background run settles, verify its hidden mailbox marker automatically starts a parent turn: immediately if idle, or only after existing parent work settles. Verify it never steers or stops the active turn, and collecting/canceling before pending delivery suppresses stale markers.
7. Have a background child call `ask_parent`; verify it waits without opening a direct-user dialog, its question arrives through the automatic follow-up mailbox, then it resumes in the background and can be collected.
8. Cancel a waiting foreground run and a running background run, then verify both run IDs are stale. Start another run and verify IDs are not reused.
9. Reload while a child is waiting and while one is running. Verify the waiting child restores with the same ID/question, the running child restores as `interrupted`, no tool replays or resumes automatically, `r` continues an interrupted run from `/agents`, and `c` cancels it with a user-canceled parent message. Restart pi and switch away/back to repeat the restoration check.
10. Fill all four active run slots and verify a fifth start/spawn is rejected; verify uncollected terminal background results do not consume active capacity.
11. Verify a user agent loads, a trusted-project agent overrides it, and an untrusted project definition does not load.
12. Start `reviewer` on a known two-commit range. Verify it can inspect the commits with ordinary `git log` and `git show` safe-bash commands, including historical patch content, and that project-specific test commands use the parent permission prompt while write-capable or otherwise unapproved Git commands remain blocked.
13. Ask the scout to access an absolute outside path, `..` escape, sensitive project file, and in-cwd symlink to an outside target; all must be blocked without prompting. Run one known safe, in-cwd read-only bash command and verify it completes without a prompt; then try a write, unknown command, and outside-path command and verify each is blocked with a heuristic reason. Verify a scratchpad-capable reviewer or worker can use its temporary scratchpad, including a dotfile-like name, without prompting.
14. Start a background same-checkout worker and request edits, an outside-cwd file access, and a bash call. Verify in-cwd edits use existing access, outside paths use the shared file prompt, inherited/session-allowed bash runs without another prompt, unresolved bash names the worker, queued permission-gated calls do not overlap, denial is recoverable, and cancel closes an active gate.
15. Try a second worker while the first is active; verify it is rejected while a scout can still start. Confirm sensitive/symlink paths and configured-deny bash commands block without an approval bypass, while isolated workers retain independent prompts and do not inherit parent session rules.
16. Complete a worker after edit/write and approved bash calls. Verify its mutation report lists tracked paths, includes the bash attribution caveat, and the actual checkout diff matches expectations.
17. Produce long findings and expand/collapse the result; verify the compact preview stays useful and expanded activity/usage remain readable.
18. Open `/agents`, select a delegated run, and verify the details pager shows user/assistant messages and compact tool calls in order; failed calls use `×`, edit calls show `-`/`+` diff lines, bash calls show commands, consecutive tool-only responses have no blank rows, and neither model thinking nor tool-result output is shown. For a live run, verify the detail reloads and follows new content, scrolling up pauses following, and `End` resumes it.

Provider calls stay manual so automated tests do not require credentials or incur usage.

For a focused manual workspace lifecycle pass, use [`WORKSPACE-MANUAL-VALIDATION.md`](./WORKSPACE-MANUAL-VALIDATION.md). It covers no-change reuse, saved diffs, apply with unrelated parent descendants, conflict/dirty preflight failures, retain/reset/discard, and reload recovery.

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
