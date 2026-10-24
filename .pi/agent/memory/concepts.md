---
name: concepts
description: "pi runtime concepts that pi-coder's modules build on - load before reasoning about hooks, turns, runs, or message delivery."
category: architecture
priority: 40
---

# pi runtime concepts

pi-coder is an extension, so most of its behavior is decided by pi's runtime vocabulary: what a *turn* is, which
event means "the user spoke", which hook can put text in front of the model, and what pi awaits. Getting one of
those wrong is invisible in tests and obvious only in a live session - the 2026-10-24 state-checkpoint work lost
an entire turn's judgements to `before_agent_start` not firing for a queued message.

In short: a **run** is one prompt plus all its work (`agent_start` … `agent_settled`), a **turn** is one
assistant response plus its tool calls (`turn_end`), a **message** is one message of any role
(`message_end`). Only `before_agent_start` can ride with the prompt; `turn_end` and `agent_before_settle` inject
by appending entries; `pi.sendMessage(..., { deliverAs: "steer" })` reaches a running loop.

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory
index.

- `concepts/turns.md` — the run/turn/message table, the full event map with what each hook can inject, the delivery mechanisms, and the traps (queued messages skipping `before_agent_start`, awaited handlers, append order, `agent_start` not being a prompt boundary).