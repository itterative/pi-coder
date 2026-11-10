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

Two lifecycle facts bite extension state: `session_shutdown` fires on a session *switch*, fork, and reload as
well as on quit (`AgentSessionRuntime.teardownCurrent`), so it means "this session ended", not "this process
ended"; and extension *factories* run once per process — `pi.registerTool` from a session hook adds a tool for
the life of the process, and there is no unregister. A module that installs tools per session must therefore
either gate them on a runtime flag or accept that its choice is sticky (see `sandbox/session-sandbox.md`).

Prompt text has a structured path and a blunt one. Tool text reaches the model through three fields with
distinct jobs — `description` in the declaration, `promptSnippet` in the `<tools>` list (a tool without one is
not listed there at all), `promptGuidelines` in `<rules>` while the tool is active — and `before_agent_start`
changes the prompt by mutating `event.systemPromptOptions` (`sections`, `toolSnippets`, `toolGuidelines`), which
pi records as a transcript delta. Pi-coder contributes every block through
`src/common/prompt-section.ts` for that reason: tool guidance goes to `<tool>_guide` via
`contributeToolGuide` (so a hidden or deselected tool leaves no guide behind), and module context blocks
(`memory_system`, `scratchpad_system`, `todolist_system`, `bash_sandbox`) go through `setPromptSection`.
Each body lives in a `prompt.ts` beside what it describes, and pi-coder's tools declare no
`promptGuidelines` at all. Returning `systemPrompt` instead replaces the prompt for that run while the
transcript keeps only the structured sections, so a block added that way never appears when a session is
exported. The field rubric and the convention are in `docs/agent-tool.md` under **Tool prompt
contributions**.

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory
index.

- `concepts/turns.md` — the run/turn/message table, the full event map with what each hook can inject, the delivery mechanisms, and the traps (queued messages skipping `before_agent_start`, awaited handlers, append order, `agent_start` not being a prompt boundary).