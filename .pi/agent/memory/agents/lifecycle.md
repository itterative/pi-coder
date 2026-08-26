---
name: lifecycle
description: Detailed delegated-agent actions, state transitions, mailbox, UI, and diagnostics.
category: architecture
keep_updated: true
---

# Agent lifecycle

## Runs

- The sequential parent `agent` tool supports foreground `start`, asynchronous `spawn`, `list`, `status`, one-shot `collect`, `resume`, `cancel`, and isolated-result actions.
- Run states are `starting`, `running`, `waiting_for_parent`, `completed`, `failed`, `aborted`, and `interrupted`. Waiting is paused, not completed; interrupted runs never restart or replay automatically.
- Up to four starting/running/waiting/interrupted runs consume capacity, with no TTL. Same-checkout mutation-capable workers are single-flight; mutation-capable workers in distinct isolated worktrees may run concurrently, while read-only runs can continue alongside them. Terminal background results are retained separately (latest 20) and do not consume active capacity.
- IDs become stale after collection, cancellation, or result eviction. Ephemeral parent runs also become stale after reload/replacement/restart; persisted runs restore only for the exact parent session and active tree branch.

## Interaction and presentation

- `ask_parent` records a question and pauses the child for cooperative guidance. Foreground children may use restricted `ask_user` through pi-coder's existing question component; background children omit it to avoid unsolicited dialogs.
- Parent abort/shutdown closes foreground dialogs, aborts child sessions, waits for settlement, and disposes resources. Non-TUI children are told to use `ask_parent`.
- Session-tree navigation is blocked while either manager-backed runs or isolated workspace setup summaries are `starting`, `running`, or `waiting_for_permission`; setup permission dialogs therefore cannot be orphaned by a branch switch.
- The above-editor widget is the sole persistent agent UI: do not add a footer `setStatus` entry. It shows running (`●`), waiting (`?`), ready (`✓`), failed (`!`), and permission-waiting states, sanitized current activity, a short assistant preview, and up to three recent terminal rows.
- Terminal child sessions are disposed promptly while bounded results remain collectable. Full child output remains behind explicit `collect`; compact results show the question/run ID or a short final-result preview.
- The `/agents` session detail view defaults to a collapsed transcript: consecutive tool calls between user/assistant messages become one human-readable summary. `c` selects collapsed and `d` selects detailed tool-call output; live detail refresh preserves the selected view.

## Mailbox and recovery

- Background waiting and retained terminal transitions coalesce by run ID. While the parent is active, delivery waits for `agent_settled`; an idle parent gets an immediate microtask flush.
- One bounded hidden `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` starts a mailbox turn after settlement without steering or stopping active work. Non-isolated background worker edits are additionally reported immediately through a hidden `deliverAs: "steer"` message only while the parent is busy when the persisted `notifyBusyWorkerChanges` setting is enabled; when disabled or when the parent is idle, changed paths are coalesced into the worker's terminal notification instead. Change paths are deduplicated per run and only same-checkout workers use the immediate path; isolated workers remain behind workspace-result handling. Markers are ephemeral and are not replayed after restart; reconciliation drops markers made stale by resume, collect, cancel, or eviction.
- Spawn/background-resume results and incremental mutation messages tell the parent not to poll or sleep. Automatic notifications indicate when to resume or collect; `status` remains an explicit recovery snapshot.

## Diagnostics

- Sanitized traces retain at most 20 runs and 400 events per run, with `/agent-trace` list/inspect/save/clear operations. Saved JSON is mode `0600` under `~/.pi/agent/traces/`.
- Tracing is currently forced on during development; restore the intended `PI_CODER_AGENT_TRACE=1` opt-in before release.
