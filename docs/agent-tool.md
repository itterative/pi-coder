# Agent tool reference

This document contains the detailed reference for pi-coder's delegated-agent tool. For the short overview, see [`src/tools/agent/README.md`](src/tools/agent/README.md).

## Actions and lifecycle

| Action     | Behavior                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `start`    | Run an agent in the foreground by default; set `background=true` to start it in the background and return immediately. |
| `list`     | List tracked runs and available workspaces.                                                                            |
| `status`   | Inspect a deliberate snapshot of a run.                                                                                |
| `collect`  | Consume a terminal background result.                                                                                  |
| `continue` | Resume a waiting/interrupted run or continue a collected terminal run.                                                 |
| `cancel`   | Stop a waiting or active run.                                                                                          |
| `inspect`  | Read an isolated result without changing it.                                                                           |
| `apply`    | Apply an isolated result to the parent checkout.                                                                       |
| `retain`   | Keep a result for review while releasing its task lease.                                                               |
| `reset`    | Explicitly reset a workspace for reuse.                                                                                |
| `discard`  | Discard an isolated result or workspace.                                                                               |

There can be up to four active or interrupted runs, and up to three persistent isolated workspaces per repository by default (the limit is configurable in `/agents` Settings). Terminal background results are retained separately until collected or evicted. Continuation lookup is bound to the exact parent session and active parent-tree branch. Continuations retain the same public run ID and physical child identity, so repeated continuations continue the latest checkpoint; isolated workspace results receive new result records while using that same run ID.

### Background behavior

A background `start` returns immediately. Progress appears in the above-editor activity widget and terminal changes are delivered through a coalesced parent mailbox after parent work settles. The mailbox contains only run IDs, statuses, and short previews; use `collect` for the full result. Do not routinely poll with `status` or wait by sleeping.

A running foreground `start` or `continue` can be moved to the background with **Ctrl+Alt+B**. The foreground call returns a short control message immediately; progress and the terminal result are then delivered asynchronously. Retrieve the retained result with `collect` after the terminal notification. This shortcut applies when exactly one detachable foreground operation is active; parallel foreground-call selection is not supported yet.

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

Custom definitions live in `~/.pi/agent/agents/*.md` or trusted project `.pi/agents/*.md` files. They always receive baseline read/search access. Optional capabilities are `memories`, `scratchpad`, `todolist`, `safe-bash`, and `command-runner`; `edit` is reserved for the built-in worker. Trusted project definitions override user definitions. Built-in names are reserved.

Two capabilities imply others, because they are strengths of one axis rather than independent grants: `command-runner` implies `safe-bash`, and `todolist` implies `scratchpad`. Implications are applied where a definition is read, so the parent-facing catalog and the persisted definition fingerprint both describe the same effective grant.

A definition may select a model and a bounded context policy. Dynamic parent/repository/workspace context belongs in the initial task message, not the system prompt, so the child transcript retains it exactly.

## Capabilities, grants, and gates

What a definition declares and what a child can actually do are separated into five layers, each with one job. Keeping them apart is what lets a capability be read in one file instead of inferred from six scattered conditions.

| Layer       | Location               | Owns                                                                                                               |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Declaration | `definitions/types.ts` | capability names, baseline grants, implications, the authority ladder, and the fingerprint over the _declared_ set |
| Grant       | `child/grant.ts`       | the single resolution from a definition plus run mode plus parent UI to one `ChildGrant`                           |
| Units       | `child/capabilities/`  | per capability: the session tools it adds, the read roots it publishes, and the extension it registers             |
| Gates       | `child/gates/`         | per authorization surface: whether it applies to this child, and the hooks, tools, and prompts it installs         |
| Profiles    | `child/prompt/`        | how the run describes itself to the child: the four run-mode profiles and their paragraph order                    |

The authority ladder is `read < inspect < command < mutate`, from `safe-bash`, `command-runner`, and `edit`. It orders **gate strength**, so every "may this child be gated, run serially, or carry the worker label?" question is a rung comparison rather than a boolean combination. It does not decide tool presence: `edit` does not imply shell access, so the `bash` tool follows `safe-bash` (which `command-runner` implies) rather than a rung test. Adding a fifth rung, or reading the ladder as a presence test, is the mistake this split exists to prevent.

To add a capability, add a unit file plus its name in `AGENT_CAPABILITIES`, and let the grant/gates/profile read the resulting facts. Do not add a new boolean to the grant, and do not combine two existing ones into a third name at a call site: if two conditions always move together, one of them is describing the wrong thing.

Gates install in a fixed order — bash-output, file-access, interaction, commands, confinement — and pi runs `tool_call` handlers in registration order, so the sequence is behavior rather than style: the file-access gate records approvals that the command and confinement gates then honour, and the confinement handler runs last so a Bash call reaching it means no command gate claimed it. `test/tools/agent-child-gates.test.ts` pins the ordered registration record per profile, and `test/tools/agent-child-decisions.test.ts` pins the resulting block/allow truth table with its reasons.

Two things a child may read are runtime state rather than capabilities and must not be merged into the ladder: the private scratchpad, and the exact full-output files this child's own truncated Bash results reported. The latter is validated on every use (real path under the temp directory, same device and inode as recorded) and pruned when it no longer matches, so a replaced or deleted output file never stays readable.

## Prompt design

A delegation task is the child's complete assignment. It must be self-contained: include the objective, relevant files/symbols, current state, scope and non-goals, constraints, expected report or changes, and validation steps. Do not assume the child can see the parent's conversation or infer unstated context.

The system prompt has two layers:

1. The role definition states purpose and work standards.
2. The child operating protocol states available tools, permissions, interaction behavior, and same-checkout versus isolated behavior.

The protocol comes from one of four profiles — isolated worker, same-checkout worker, command-capable, read-only — selected by the child's rung plus whether it owns a workspace, followed by the interaction paragraph and the profile's report expectation. Sentences that more than one profile needs live with the capability that warrants them (`prompt/bash.ts`, `prompt/paths.ts`), while each profile keeps its own paragraph order so the child reads one coherent mode description rather than a list of capability notes.

Keep capability mechanics out of role text. Test complete rendered prompts with the file snapshots in `test/tools/agent-prompt.test.ts`, which resolve through `resolveChildGrant` exactly as a real child does; the older style of passing a hand-written prompt option bag let a fixture omit grants the child actually holds. Behavior that follows from the same grant is pinned in `test/tools/agent-child-decisions.test.ts`.

## Safety boundary

Delegated-agent restrictions are local accident-prevention controls, not a hostile-environment security sandbox. pi-coder trusts the Pi process, installed executables, Git configuration, and selected checkout. Use an OS sandbox for a hostile-environment threat model.

Within that trusted environment:

- Read/search paths stay within the working directory and permitted private scratchpad.
- `safe-bash` allows only commands classified as cwd-confined and heuristically read-only.
- `command-runner` uses the normal permission gate for commands outside that heuristic.
- Same-checkout mutation calls share the parent's access; isolated workers use their own worktree access.
- Isolated workers and setup workers do not inherit parent Bash rules. Explicit remembered rules may be propagated to the parent session: the parent's own approval state is therefore resolved _without_ regard to isolation, while the state a child may read back is not. Do not fold the two together.
- A child that shares the checkout but has no parent session to borrow approvals from gets no file-access gate at all, which makes it behave like an isolated child for path prompts.
- Outside-cwd writes fail closed by redundancy: both the shared file hook and the command gate must allow the call, so one handler's approval cannot smuggle a path past the other.
- Permission-gated child calls are serialized; concurrent isolated workers may use distinct worktrees.
- SAFE_EDIT and Bash attribution are advisory; inspect the final diff before committing.

Tool results are passed to the configured model provider like ordinary context. Choose the project, agent, and provider accordingly.

## Browser and events

`/agents` combines current and historical delegated runs with isolated workspaces. The Agents view is scoped to the active parent session by default; `h` toggles cwd-wide history. Session details are read-only. Workspaces expose Git state, lease state, result metadata, and explicit inspect/apply/retain/reset/discard controls.

The extension publishes bounded lifecycle events on `pi-coder:agent-event`. Events identify cwd, timestamp, IDs, and state changes; they do not contain transcripts or full output. Consumers should reload authoritative state after an event.

## Manual validation

For provider, interaction, permission, persistence, rendering, and workspace behavior, use:

- [Workspace lifecycle checklist](src/tools/agent/WORKSPACE-MANUAL-VALIDATION.md).
- [Prompt snapshots](test/tools/agent-prompt.test.ts), resolved through the real grant.
- [Child gate composition](test/tools/agent-child-gates.test.ts) and the [decision truth table](test/tools/agent-child-decisions.test.ts) — automated, but read the snapshot after any gate change, since the block reasons are what a child sees.
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
