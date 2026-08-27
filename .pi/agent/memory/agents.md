---
name: agents
description: Index of targeted reference memories for the delegated-agent feature.
category: architecture
priority: 4
keep_updated: true
status: Implemented; reference docs are maintenance-oriented
---

# Delegated agents

The feature is an in-process SDK implementation under `src/tools/agent/`, registered by `src/index.ts`. It lets the parent delegate focused exploration or implementation while preserving pi-coder's permission model, progress UI, and recoverable child sessions. The concise feature contract is in `src/tools/agent/PLAN.md`.

## High-value overview

- Built-ins include read-only `scout` and opt-in `advisor`, command-capable `reviewer`, and the edit-capable permission-gated `worker`. Custom Markdown agents are loaded from `~/.pi/agent/agents` and trusted-project `.pi/agents`; they receive baseline read/search tools and may opt into `safe-bash` or permission-gated `command-runner`.
- The `agent` tool supports foreground `start`, background `spawn`, `list`, `status`, `collect`, `resume`, `cancel`, and isolated-result actions. Up to four runs may be active or interrupted; only one mutating worker may run at a time.
- `ask_parent` pauses a child for guidance. Foreground children may use restricted `ask_user`; background children use mailbox notifications and never open unsolicited dialogs. Full background results remain explicit through `collect`.
- `/agents` browses current/past child sessions, isolated workspaces, and built-in agent model settings. Durable restoration is limited to the exact parent session and active tree branch; interrupted runs never restart or replay automatically.
- Read-only children are cwd-confined and `safe-bash` is heuristic `SAFE_READONLY`, not a security sandbox. Non-isolated command-capable children inherit the parent's Bash permission state; edit-capable workers additionally share same-checkout/outside-cwd file permission behavior. Isolated workspaces keep independent permission state and changed results outside the parent checkout until explicit disposition.
- Agent UI lives in the compositional `src/tui/agents` package. The browser host, session/workspace detail views, workspace browser, and activity widget own generic TUI children rather than extending agent-specific base classes. Shared agent diagnostic formatting belongs in `src/tools/agent/presentation/text.ts`, not the TUI barrel.
- Built-in model overrides are defined in `src/tools/agent/config.ts`, persisted in `~/.pi/agent-config.json` or an existing nearest project `.pi/agent-config.json`, and applied during `AgentLifecycle.discover()` without mutating the shared built-in definitions. Advisor availability is opt-in, persisted alongside those settings, and its runs require an explicit model override.
- Delegated runtime context uses bounded `context.sections` filtered and deduplicated by definition policies, with the complete rendered context block character-bounded and placed in the initial task message; automatic parent-summary/recent-context collection remains future work.
- Before release, restore the intended `PI_CODER_AGENT_TRACE=1` opt-in; tracing is currently forced on during development.

## Targeted references

Load only the detail needed for the task:

- `agents/architecture.md` — package boundaries, definitions, prompts, and child runtime.
- `agents/lifecycle.md` — actions, states, interaction, mailbox, UI, and traces.
- `agents/safety.md` — capabilities, confinement, approvals, and trust boundary.
- `agents/persistence.md` — durable sessions, restoration, and `/agents` browsing.
- `agents/workspaces.md` — isolated worktrees, leases, setup, and result disposition.

These nested documents are on-demand references and are intentionally not included in the memory list automatically. Keep this overview and the detailed files concise; update them when behavior or ownership changes.
