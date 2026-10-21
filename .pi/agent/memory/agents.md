---
name: agents
description: Cluster index for delegated agents: what the feature is, the capability split, the agent tool action list, and the detail docs under agents/.
category: architecture
priority: 2
keep_updated: true
status: Implemented; reference docs are maintenance-oriented
---

# Delegated agents

The feature is an in-process SDK implementation under `src/tools/agent/`, registered by `src/index.ts`. It lets the parent delegate focused exploration or implementation while preserving pi-coder's permission model, progress UI, and recoverable child sessions. The concise feature contract is in `src/tools/agent/PLAN.md`.

## High-value overview

- Capability split: `scout` is read-only, `advisor` is read-only and opt-in, `reviewer` is command-capable, and `worker` is the only edit-capable built-in (permission-gated). Same-checkout mutation-capable workers are single-flight; `worker` runs in distinct isolated worktrees may mutate concurrently.
- The `agent` tool actions: `start` (foreground by default, background with `background=true`), `list`, `status`, `collect`, `continue`, `cancel`, and the isolated-result actions.
- The agent UI is a compositional package: `src/tui/agents`.

## Targeted references

Load only the detail needed for the task:

- `agents/architecture.md` — package boundaries (including `src/tui/agents`), definitions, prompts, child runtime, and the built-in model-override config.
- `agents/lifecycle.md` — actions, states, interaction, mailbox, UI, traces, and the forced-on tracing release blocker.
- `agents/safety.md` — capabilities, confinement, approvals, and trust boundary.
- `agents/persistence.md` — durable sessions, restoration, and `/agents` browsing.
- `agents/workspaces.md` — isolated worktrees, leases, setup, and result disposition.
- `agents/workspace-invariants.md` — the lease, reservation, collection, reset, capacity, and browser invariants found during manual validation.

These nested documents are on-demand references and are intentionally not included in the memory list automatically. Keep this overview and the detailed files concise; update them when behavior or ownership changes.
