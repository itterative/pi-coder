---
name: turns
description: "pi's runtime vocabulary: run vs turn vs message, the event map, which hook can inject context, and the traps that cost pi-coder debugging time."
---

# Runs, turns, and messages

pi reuses the word "turn" for something narrower than a user turn, which is the single most expensive
ambiguity in this repo's extension work. The canonical sentence is in the pi docs
(`node_modules/@earendil-works/pi-coding-agent/docs/how-pi-works.md`):

> The provider streams an assistant response, which can contain text and tool calls. Pi records the response,
> executes each tool call, and records the results. That completes one turn. If tool results or queued messages
> require another model request, Pi starts another turn. Otherwise, the run ends.

So, three nested scopes:

| Scope | Meaning | Boundary events |
|---|---|---|
| **run** | one prompt submitted through `session.prompt()` and all the work it triggers, including continuations | `agent_start` … `agent_end`, then `agent_before_settle` / `agent_settled` |
| **turn** | one assistant response plus the tool calls it made and their results | `turn_start` … `turn_end` |
| **message** | one message of any role: user, assistant, tool result, custom | `message_start` … `message_end` |

A user turn (what a person would call "my turn") is a **run**, not a turn. pi's `TurnEndEvent.turnIndex` counts
responses, not prompts.

## The event map

Verified against `dist/core/extensions/types.d.ts` (the `on(event:)` overloads) and
`dist/core/extensions/runner.js`.

| Event | Fires | Can inject context? |
|---|---|---|
| `before_agent_start` | once per prompt submitted through `session.prompt()` — i.e. a message typed into the composer | yes: returns `{ message }` (and `{ systemPrompt }`) |
| `message_start` / `message_end` | per message, any role — the user's own message, each assistant response, **each tool result**, custom messages | `message_end` can replace the finalized message; it cannot add one. It is also where pi persists the entry |
| `turn_end` | once per turn (response + its tool results, both already appended) | yes: it is a boundary — `entries` drafts (`custom`, `custom_message`, `context_edit`, `compaction`) plus `continue: true` for one more provider request |
| `agent_before_settle` / `agent_settled` | the run has finished all automatic work (retries, compaction, queued continuations) | before-settle may append entries and request one continuation; settled is notification-only |
| `turn_start`, `tool_call`, `tool_result`, `tool_execution_*` | within a turn | `tool_call` can mutate input or block; `tool_result` handlers compose |
| `session_start`, `session_tree`, `session_compact`, `session_before_*`, `session_shutdown` | session lifecycle: `session_start` carries `reason` (`startup`/`reload`/`resume`), a compaction folds, a tree move switches branches | `session_before_compact` can veto/supply a summary |
| `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event` | per provider call | request/header edits |

The full set, for reference: `agent_before_settle`, `agent_end`, `agent_settled`, `agent_start`,
`after_provider_response`, `before_agent_start`, `before_provider_headers`, `before_provider_request`,
`cache_warming_decision`, `input`, `mcp_servers_change`, `message_end`, `message_start`, `message_update`,
`model_select`, `project_trust`, `provider_stream_event`, `resources_discover`, `session_before_compact`,
`session_before_fork`, `session_before_switch`, `session_before_tree`, `session_compact`,
`session_compact_failed`, `session_info_changed`, `session_shutdown`, `session_start`, `session_tree`,
`thinking_level_select`, `tool_call`, `tool_execution_end`, `tool_execution_start`, `tool_execution_update`,
`tool_result`, `turn_end`, `turn_start`, `ui_prompt_end`, `ui_prompt_start`, `user_bash`.

## Delivery mechanisms

- **Returned from `before_agent_start`**: `{ message }` is injected as a `custom` message alongside the user
  message. This is the only hook that rides *with* the prompt — and it is why waiting in that hook withholds the
  user's own message, since pi builds that message only after the handler returns.
- **`pi.sendMessage(..., { deliverAs })`**: `"steer"` enters after the current assistant turn (the running
  loop), `"followUp"` after the run's pending work, `"nextTurn"` with the next prompt. This is how a mid-run
  nudge reaches a long autonomous stretch. Delivery is chosen by `isStreaming`, not by the flag alone: a
  `"steer"` sent while nothing streams is appended to the transcript without ever reaching the model —
  `sendCustomMessage` only calls `agent.steer()` when streaming — so a late reminder must switch to `"nextTurn"`
  if it means to be read.
- **A steer buys a step.** The loop polls `getSteeringMessages()` after `turn_end` and keeps running on
  `hasMoreToolCalls || pendingMessages.length > 0`, so a reminder steered into a tool-using turn rides a step
  that was already coming, while one steered into a *text-only* turn adds a fresh provider request.
- **Boundary drafts** at `turn_end` / `agent_before_settle`: `entries` with a `custom_message` draft do the same
  job from a boundary hook.
- **`pi.appendEntry(type, data)`**: an entry on the session branch that is *not* context — the reminder,
  todo-snapshot, and state entries use this.

## Traps

- **A queued message never fires `before_agent_start`.** A prompt typed while a run is streaming is queued
  (`steer`/`followUp`) and drained *inside* pi's agent loop
  (`pi-agent-core/dist/agent-loop.js`, the outer `while (true)` calling `getFollowUpMessages()`); the loop emits
  only `message_start`/`message_end` for it. `emitBeforeAgentStart` is called from the session prompt path alone
  (`agent-session.js`), so anything hanging off `before_agent_start` silently skips that turn. A module that
  needs "every response" must use `turn_end`; a module that needs "every prompt" must also watch a user
  `message_start`, and cannot inject there.
- **Handlers are awaited.** `await this._emitExtensionEvent(event)` in `agent-session.js` and `await emit(...)`
  in the loop mean a handler's latency lands between requests: a consult in `turn_end` delays the next provider
  request by its whole round trip. Cheap hooks matter.
- **Order of appends versus the user message.** pi builds and persists the user message *after*
  `before_agent_start` returns (`_runAgentPromptContext`), so an entry a module appends in that hook lands
  *before* the user message it decided. `scripts/reminder-report.mts` relies on exactly that when it walks the
  branch to attribute decisions to turns; an entry appended during the run instead belongs to the turn already
  in hand (which is why `trigger: "checkpoint"` is bucketed like `"mid-run"` there, and why a *deferred* turn
  decision carries `deferred: true` and is read from its own `scheduler.userTurns` instead of that turn's +1).
  The same ordering is why a reminder loop that wants to keep the user's message responsive has to decide off
  the boundary: the `before_agent_start` handler is awaited, and the message does not exist until it returns.
- **`agent_start` is not a prompt boundary.** It also fires for continuations and drained queue work, so it
  cannot stand in for `before_agent_start` as "the user sent something".
- **The assistant's `message_end` precedes its tools.** Reading a conversation window there gives the calls but
  not their results; `turn_end` is the first point where both are in the branch.
- **Custom messages are persisted at `message_end`** (always hidden context: `customType`, `display: false`,
  and a `details` payload), which is what makes a delivered reminder recoverable on a restart.