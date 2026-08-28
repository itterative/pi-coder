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
capabilities: [safe-bash, memories, scratchpad] # optional; read/search are baseline capabilities
model: provider/model-id # optional; defaults to the parent model
---

Agent-specific instructions go here.
```

`name` must match the lowercase agent-name format and `description` must be non-empty. Omit `capabilities` for read-only codebase access. The old `tools` field is unsupported; use `capabilities` instead.

Built-ins:

- `scout` — read-only exploration with restricted safe-bash and memory access;
- `reviewer` — code and history review with permission-gated command validation and memory access;
- `advisor` — opt-in read-only senior advice on implementation decisions and tradeoffs, using a configured model, with memory access;
- `worker` — same-checkout or isolated implementation with permission-gated edits, commands, and memory access.

Custom definitions are read-only by default, may opt into `memories`, `scratchpad`, `safe-bash`, or `command-runner`, and may select a model; otherwise they use the parent model. Built-in reviewer and worker definitions include `memories` and `scratchpad`; read-only scout and advisor definitions include `memories` but do not need scratchpads. `read` and `search` are baseline capabilities, `memories` loads pi-coder's memory extension in the child session, `scratchpad` creates a private temporary `/tmp` workspace in the child session, `command-runner` implies `safe-bash`, and `edit` is reserved for the built-in worker.

Custom Markdown definitions are loaded from `~/.pi/agent/agents` and the nearest trusted `.pi/agents`. Every custom agent gets `read`, `grep`, `find`, and `ls`; optional capabilities include `memories`, `scratchpad`, `safe-bash`, and `command-runner`, while `edit` is reserved for the built-in worker. Built-in names `scout`, `reviewer`, `advisor`, and `worker` are reserved, paths are sorted, same-scope duplicates are first-wins, and trusted-project definitions override user definitions.

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

Runs are bounded to four active or interrupted records. At most one may be an edit-capable worker, and its permission-gated calls are serialized. Terminal background results are retained separately until collected or evicted.

`ask_parent` pauses a child and requires explicit guidance. Foreground children may use restricted `ask_user`, except the advisor, which always uses `ask_parent`; background children never open parent dialogs. Cancellation and shutdown abort children and clean up handles. A waiting run is paused, not completed; an interrupted run is never restarted or replayed automatically and requires explicit user action with a safety check.

Background runs report progress in the above-editor widget. Parent-guidance waits and retained terminal outcomes send coalesced, non-interrupting mailbox notifications after parent work settles. The parent should not poll or sleep; it can use `list`, `status`, or `collect` when deliberate recovery is needed.

### Browser and workspaces

`/agents` shows an Agents list scoped to the active parent session by default; `h` toggles cwd-wide historical sessions. Workspaces are available in the same browser. Session details are read-only and display bounded conversation/tool summaries. Active interrupted runs can be resumed or canceled explicitly; historical and stale checkpoints remain read-only.

Isolated workers use a persistent pool of up to three Git worktrees. Setup runs internally with the same permission gate. A completed isolated run is finalized as a workspace result: no-change results release the workspace, while changed results remain leased and outside the parent checkout. Results can be inspected, applied, discarded, retained/reset, or revised explicitly. Revision reopens the original child session with its original model and sends only parent guidance as the next child message; before startup it verifies that the worktree HEAD descends from the recorded base and rejects divergence without changing state; it creates a new logical run identity for workspace-result ownership and rolls lease ownership back if transfer/finalization fails. Workspaces are never merged, reset, or deleted implicitly.

## Safety contract

- Delegated-agent controls reduce model-initiated accidents; they are not a hostile-environment security boundary.
- Child paths are confined to the working directory plus the agent's private temporary scratchpad when that capability is enabled. Agents with Bash access may additionally read only exact runtime-created full-output files reported in their own truncated Bash result details; unrelated temporary paths and symlink replacements remain blocked. Scratchpad paths may use any filename, while symlink escapes and sensitive targets outside the scratchpad remain blocked.
- `safe-bash` runs only commands classified `SAFE_READONLY` by the shared cwd heuristic. Unknown, mutating, network, interpreter, and unsafe Git commands are rejected without an approval bypass.
- `command-runner` runs safe commands directly and routes other commands through the normal parent permission prompt. It may have project side effects; explicit approval, not command naming, is authoritative.
- Non-isolated command-capable agents share the parent's session Bash rules; unresolved commands use the shared sandbox/direct prompt. Agents with `edit` also receive direct edit/write tools, with ordinary project paths using same-checkout access, isolated worker paths using their dedicated worktree access, and scratchpad paths using prompt-free temporary access. Sensitive project paths and symlink escapes remain blocked before prompting. Isolated workspaces and setup workers use independent permission state without inheriting parent-session rules; an explicit end-user choice to remember a Bash rule is propagated to the parent session state for later parent or non-isolated child calls.
- The `edit` capability is reserved for the built-in `worker`; persisted metadata cannot grant edit authority to user-selectable agents. The `command-runner` capability does not grant direct edit/write tools.

## Persistence and diagnostics

Persisted parent sessions store child transcripts under the extension's private `.state/agent-sessions` area and full run metadata—including the immutable agent definition snapshot required for resume/revise—in the extension's SQLite metadata database. After an abrupt process stop, restoration uses the recorded Pi-process PID to reclaim a conclusively dead continuation lease immediately, falling back to lease expiry when PID liveness is uncertain, while retaining protection against a live competing process. State snapshots are associated with parent-session branch entries, so restore is limited to the exact parent session and active tree branch; new, forked, cloned, or ephemeral sessions do not inherit runs. Waiting and interrupted runs require user action; retained uncollected background terminal outcomes can also be restored. Stale tool calls are marked uncertain before continuation.

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
