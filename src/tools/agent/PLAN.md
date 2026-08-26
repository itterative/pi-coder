# Delegated-agent plan

## Status

The in-process delegated-agent feature is implemented. This document is a compact guide to its contracts and the remaining follow-up work, not a chronological implementation log.

## Purpose

Let the parent Pi session delegate focused exploration or implementation while preserving pi-coder's permission model, useful progress reporting, and recoverable child sessions.

## Architecture

- `src/index.ts` registers the feature.
- `src/tools/agent/` is organized into:
  - `definitions/` — built-in, user, and trusted-project definitions;
  - `child/` — SDK session construction, child tools, confinement, and worker permissions;
  - `runs/` — parent-local run state, lifecycle, persistence, and usage;
  - `storage/` — catalogs and durable metadata;
  - `workspaces/` — isolated Git worktrees and result disposition;
  - `presentation/` and `observability/` — TUI projections, mailbox, traces, and events.
- Top-level `lifecycle.ts`, `browser.ts`, and `action-dispatch.ts` connect extension events, `/agents`, and tool actions.

Child sessions use `noExtensions: true` and one explicit child extension. They inherit the normal Pi prompt, with the selected role and child protocol rendered inside `<delegated_agent_instructions>` XML blocks, and receive a deliberately limited tool set.

## User-facing contract

### Definitions

Custom agents are Markdown files with YAML frontmatter and an instruction body:

```markdown
---
name: analyst
description: Inspect architecture and identify risks
capabilities: [safe-bash] # optional; currently the only extra capability
model: provider/model-id # optional; defaults to the parent model
---

Agent-specific instructions go here.
```

`name` must match the lowercase agent-name format and `description` must be non-empty. Omit `capabilities` for read-only codebase access. The old `tools` field is unsupported; use `capabilities` instead.

Built-ins:

- `scout` — read-only exploration with restricted safe-bash;
- `reviewer` — read-only exploration including safe Git history inspection;
- `advisor` — opt-in read-only senior advice on implementation decisions and tradeoffs, using a configured model;
- `worker` — same-checkout or isolated implementation with permission-gated mutations.

Custom definitions are read-only by default, may opt into `safe-bash`, and may select a model; otherwise they use the parent model.

Custom Markdown definitions are loaded from `~/.pi/agent/agents` and the nearest trusted `.pi/agents`. Every custom agent gets `read`, `grep`, `find`, and `ls`; `capabilities: [safe-bash]` is the only additional capability. Built-in names `scout`, `reviewer`, `advisor`, and `worker` are reserved, paths are sorted, same-scope duplicates are first-wins, and trusted-project definitions override user definitions.

Runtime context is passed as bounded `context.sections` on `start` and `spawn`. Built-in definitions select allowed sections through a context policy; the renderer places selected context in the initial task message rather than the system prompt so persisted child transcripts retain the exact context. Automatic parent-summary and recent-context collection remains future work.

### Actions and lifecycle

The `agent` tool exposes:

```text
start   — run in the foreground
spawn   — start in the background
list    — recover tracked runs
status  — inspect a deliberate snapshot
collect — consume a terminal background result
resume  — provide guidance to a waiting/interrupted run
cancel  — stop a waiting or active run
inspect/apply/discard/revise — manage an isolated result
```

Runs are bounded to four active or interrupted records. At most one may be a worker, and its mutation calls are serialized. Terminal background results are retained separately until collected or evicted.

`ask_parent` pauses a child and requires explicit guidance. Foreground children may use restricted `ask_user`, except the advisor, which always uses `ask_parent`; background children never open parent dialogs. Cancellation and shutdown abort children and clean up handles. A waiting run is paused, not completed; an interrupted run is never restarted or replayed automatically and requires explicit user action with a safety check.

Background runs report progress in the above-editor widget. Parent-guidance waits and retained terminal outcomes send coalesced, non-interrupting mailbox notifications after parent work settles. The parent should not poll or sleep; it can use `list`, `status`, or `collect` when deliberate recovery is needed.

### Browser and workspaces

`/agents` shows a unified Agents list containing active and historical sessions across the current cwd, plus Workspaces. Session details are read-only and display bounded conversation/tool summaries. Active interrupted runs can be resumed or canceled explicitly; historical and stale checkpoints remain read-only.

Isolated workers use a persistent pool of up to three Git worktrees. Setup runs internally with the same permission gate. A completed isolated run is finalized as a workspace result: no-change results release the workspace, while changed results remain leased and outside the parent checkout. Results can be inspected, applied, discarded, retained/reset, or revised explicitly. Workspaces are never merged, reset, or deleted implicitly.

## Safety contract

- Delegated-agent controls reduce model-initiated accidents; they are not a hostile-environment security boundary.
- Child paths are confined to the working directory and checked for sensitive paths and symlink escapes.
- `safe-bash` runs only commands classified `SAFE_READONLY` by the shared cwd heuristic. Unknown, mutating, network, interpreter, and unsafe Git commands are rejected without an approval bypass.
- User-selectable worker `edit`, `write`, and `bash` calls use a parent-visible one-shot approval, honor configured denial and sandbox/direct mode, and report attribution caveats for approved bash or concurrent parent activity. Isolated workspaces also use an internal, permission-gated setup worker.
- Persisted metadata cannot grant mutation authority to user-selectable agents; only the current reserved built-in `worker` may be restored as a mutating task worker.

## Persistence and diagnostics

Persisted parent sessions store child transcripts under the extension's private `.state/agent-sessions` area and full run metadata in the extension's SQLite metadata database. State snapshots are associated with parent-session branch entries, so restore is limited to the exact parent session and active tree branch; new, forked, cloned, or ephemeral sessions do not inherit runs. Waiting and interrupted runs require user action; retained uncollected background terminal outcomes can also be restored. Stale tool calls are marked uncertain before continuation.

The event bus publishes bounded invalidation events; consumers reload authoritative state. `/agent-trace` retains sanitized, bounded timelines for recent runs. Tracing is temporarily enabled during development and should return to the intended `PI_CODER_AGENT_TRACE=1` opt-in before release.

## Deferred work

- Restore arbitrary continuation of completed child conversations.
- Add explicit chain and batch workflows.
- Add transcript/orphan pruning and browser run renaming.
- Revisit subprocess isolation only if the trusted-local-process model is insufficient.

## Validation

Run automated checks with:

```bash
npm run test:run
npx tsc --noEmit
```

Provider, lifecycle, permission, rendering, persistence, and workspace checks require real-provider/manual validation. Keep the checklist in `src/tools/agent/README.md` aligned with behavior changes.
