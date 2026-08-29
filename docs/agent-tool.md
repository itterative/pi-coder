# Agent tool reference

This document contains the detailed reference for pi-coder's delegated-agent tool. For the short overview, see [`src/tools/agent/README.md`](src/tools/agent/README.md).

## Actions and lifecycle

| Action | Behavior |
| --- | --- |
| `start` | Run an agent in the foreground by default; set `background=true` to start it in the background and return immediately. |
| `list` | List tracked runs and available workspaces. |
| `status` | Inspect a deliberate snapshot of a run. |
| `collect` | Consume a terminal background result. |
| `continue` | Resume a waiting/interrupted run or continue a collected terminal run. |
| `cancel` | Stop a waiting or active run. |
| `inspect` | Read an isolated result without changing it. |
| `apply` | Apply an isolated result to the parent checkout. |
| `retain` | Keep a result for review while releasing its task lease. |
| `reset` | Explicitly reset a workspace for reuse. |
| `discard` | Discard an isolated result or workspace. |


There can be up to four active or interrupted runs, and up to three persistent isolated workspaces per project. Terminal background results are retained separately until collected or evicted. Continuation lookup is bound to the exact parent session and active parent-tree branch. Continuations retain the same public run ID and physical child identity, so repeated continuations continue the latest checkpoint; isolated workspace results receive new result records while using that same run ID.

### Background behavior

A background `start` returns immediately. Progress appears in the above-editor activity widget and terminal changes are delivered through a coalesced parent mailbox after parent work settles. The mailbox contains only run IDs, statuses, and short previews; use `collect` for the full result. Do not routinely poll with `status` or wait by sleeping.

A running foreground `start` can be moved to the background with **Ctrl+B**. The foreground call returns a short control message immediately; progress and the terminal result are then delivered asynchronously. Retrieve the retained result with `collect` after the terminal notification. This shortcut applies when exactly one detachable foreground start is active; parallel foreground-call selection is not supported yet.

Foreground and background children may use `ask_user` when direct user interaction is allowed and the parent is running in an interactive TUI. They may use `ask_parent` for parent guidance in any mode. The advisor always uses `ask_parent` because its definition disables direct user interaction. If supplied context sections are not accepted by the selected agent, the tool emits a non-blocking warning inside its metadata and continues without that context. Cancellation and shutdown abort active children and close dialogs.

### Interaction and recovery

A waiting child is paused, not completed. An interrupted child was starting or running when shutdown/crash occurred; it is never restarted or replayed automatically. Continuing is an explicit user action and adds an instruction to inspect uncertain state first. Unmatched crash-time tool calls receive synthetic uncertain-outcome errors.

Persisted parent sessions restore waiting/interrupted runs and uncollected terminal outcomes. New, forked, cloned, or ephemeral parent sessions do not inherit them. See [Persistence and recovery](docs/agent-persistence.md).

## Agent roles and definitions

The built-in roles are:

- **`scout`** — read-only reconnaissance.
- **`reviewer`** — read/search plus permission-gated command execution.
- **`worker`** — implementation work with edit/write access; the only edit-capable built-in.
- **`advisor`** — read-only senior advice, disabled until assigned a model in `/agents`.

Custom definitions live in `~/.pi/agent/agents/*.md` or trusted project `.pi/agents/*.md` files. They always receive baseline read/search access. Optional capabilities are `memories`, `scratchpad`, `safe-bash`, and `command-runner`; `edit` is reserved for the built-in worker. Trusted project definitions override user definitions. Built-in names are reserved.

A definition may select a model and a bounded context policy. Dynamic parent/repository/workspace context belongs in the initial task message, not the system prompt, so the child transcript retains it exactly.

## Prompt design

A delegation task is the child's complete assignment. It must be self-contained: include the objective, relevant files/symbols, current state, scope and non-goals, constraints, expected report or changes, and validation steps. Do not assume the child can see the parent's conversation or infer unstated context.

The system prompt has two layers:

1. The role definition states purpose and work standards.
2. The child operating protocol states available tools, permissions, interaction behavior, and same-checkout versus isolated behavior.

Keep capability mechanics out of role text. Test complete rendered prompts with the file snapshots in `test/tools/agent-prompt.test.ts`.

## Safety boundary

Delegated-agent restrictions are local accident-prevention controls, not a hostile-environment security sandbox. pi-coder trusts the Pi process, installed executables, Git configuration, and selected checkout. Use an OS sandbox for a hostile-environment threat model.

Within that trusted environment:

- Read/search paths stay within the working directory and permitted private scratchpad.
- `safe-bash` allows only commands classified as cwd-confined and heuristically read-only.
- `command-runner` uses the normal permission gate for commands outside that heuristic.
- Same-checkout mutation calls share the parent's access; isolated workers use their own worktree access.
- Isolated workers and setup workers do not inherit parent Bash rules. Explicit remembered rules may be propagated to the parent session.
- Permission-gated child calls are serialized; concurrent isolated workers may use distinct worktrees.
- SAFE_EDIT and Bash attribution are advisory; inspect the final diff before committing.

Tool results are passed to the configured model provider like ordinary context. Choose the project, agent, and provider accordingly.

## Browser and events

`/agents` combines current and historical delegated runs with isolated workspaces. The Agents view is scoped to the active parent session by default; `h` toggles cwd-wide history. Session details are read-only. Workspaces expose Git state, lease state, result metadata, and explicit inspect/apply/retain/reset/discard controls.

The extension publishes bounded lifecycle events on `pi-coder:agent-event`. Events identify cwd, timestamp, IDs, and state changes; they do not contain transcripts or full output. Consumers should reload authoritative state after an event.

## Manual validation

For provider, interaction, permission, persistence, rendering, and workspace behavior, use:

- [Workspace lifecycle checklist](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md).
- [Prompt snapshots](test/tools/agent-prompt.test.ts).
- [Transcript and browser tests](test/tools/agent-transcript.test.ts) and `test/tui/`.

Automated checks are:

```bash
npm run test:run
npx tsc --noEmit
```

## Diagnostic traces

During development, `/agent-trace` keeps bounded sanitized timelines for recent runs. It records lifecycle transitions, short previews, tool names, result lengths/status, errors, and usage—not tool-result contents or credentials.

```text
/agent-trace                    # list recent traces
/agent-trace scout-1            # inspect one timeline
/agent-trace scout-1 save       # explicitly save sanitized JSON
/agent-trace clear              # discard retained traces
```

Saved traces are mode `0600` under `~/.pi/agent/traces/`. Traces are parent-runtime-local and in-memory unless explicitly saved.
