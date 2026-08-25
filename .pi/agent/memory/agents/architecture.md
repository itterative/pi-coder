---
name: architecture
description: Detailed delegated-agent package boundaries, discovery, prompts, and child runtime.
category: architecture
keep_updated: true
---

# Agent architecture

## Ownership

- `src/index.ts` registers the feature. The package is organized into `contracts/`, `definitions/`, `runs/`, `child/`, `storage/`, `workspaces/`, `presentation/`, and `observability/`.
- Top-level `lifecycle.ts`, `browser.ts`, and `action-dispatch.ts` own extension hooks/state, `/agents` orchestration, and parent action routing. `presentation/browser-models.ts` projects authoritative session/workspace/Git state for the TUI.
- Source and tests should import canonical modules directly; compatibility facades are intentionally removed.

## Definitions

- Built-ins: read-only `scout` and `reviewer`, plus permission-gated `worker`.
- Custom Markdown definitions are loaded from `~/.pi/agent/agents` and the nearest trusted `.pi/agents`. Built-in names are reserved; files sort by path; same-scope duplicates are first-wins with warnings; trusted-project definitions override user definitions with an informational diagnostic.
- Every custom agent receives baseline `read`, `grep`, `find`, and `ls`. `capabilities: [safe-bash]` is the only custom privilege. Legacy `tools` is ignored with a warning. A definition may specify `model`; otherwise it uses the parent model.
- The parent prompt receives an idempotent, session-cached `<delegated_agents>` catalog with names, sources, capabilities, and descriptions. Live run state is recovered with `agent(action="list")`, not injected into the system prompt.

## Child runtime

- Child sessions use `noExtensions: true` plus one explicit child extension, avoiding recursive pi-coder loading while retaining child-specific hooks such as confinement and `ask_parent`.
- Agent instructions append to Pi's base prompt. Runtime factories keep provider/model setup isolated per run and bridge parent aborts to `childSession.abort()`.
- Child model setup preserves child-resolved OAuth, mirrors registered provider/native-provider configuration and resolved base URL/headers, and copies runtime API keys only for non-OAuth providers lacking child auth. Runtime-only OAuth cannot be transferred through the public extension API and must fail explicitly.
- Exact nested usage is accumulated from child messages and returned as a delta on each parent-visible start/resume/status result; cumulative usage remains for display.

Tests include no-provider-call child SDK construction and orchestration coverage under `test/tools/agent*.test.ts`. Real provider, lifecycle, and rendering checks remain in `src/tools/agent/README.md`.
