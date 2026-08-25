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

- Built-ins: read-only `scout`, `reviewer`, and opt-in `advisor`, plus permission-gated `worker`. Foreground direct-user interaction is policy-controlled; the advisor is explicitly parent-guidance-only.
- Custom Markdown definitions are loaded from `~/.pi/agent/agents` and the nearest trusted `.pi/agents`. Built-in names are reserved; `advisor` is disabled by default and is only exposed when enabled in agent configuration; files sort by path; same-scope duplicates are first-wins with warnings; trusted-project definitions override user definitions with an informational diagnostic.
- Every custom agent receives baseline `read`, `grep`, `find`, and `ls`. `capabilities: [safe-bash]` is the only custom privilege. Legacy `tools` is ignored with a warning. A definition may specify `model`; otherwise it uses the parent model.
- The parent prompt receives an idempotent, session-cached `<delegated_agents>` catalog with names, sources, capabilities, and descriptions; changing advisor availability refreshes the catalog. Live run state is recovered with `agent(action="list")`, not injected into the system prompt.
- Runtime context is typed as bounded `context.sections`, filtered by each definition's context policy, deduplicated, and rendered into the initial task message rather than the system prompt. The renderer bounds the complete context block, including headings and safety preamble. Automatic parent-summary and recent-context collection is not implemented yet.

## Child runtime

- Child sessions use `noExtensions: true` plus one explicit child extension, avoiding recursive pi-coder loading while retaining child-specific hooks such as confinement and `ask_parent`.
- Agent instructions are rendered as stable role plus protocol layers inside `<delegated_agent_instructions>` XML blocks appended to Pi's base prompt. The wrapper explains that the blocks define the child role and operating protocol. Runtime context is rendered separately into the initial task message. Runtime factories keep provider/model setup isolated per run and bridge parent aborts to `childSession.abort()`.
- Child model setup preserves child-resolved OAuth, mirrors registered provider/native-provider configuration and resolved base URL/headers, and copies runtime API keys only for non-OAuth providers lacking child auth. Runtime-only OAuth cannot be transferred through the public extension API and must fail explicitly.
- Exact nested usage is accumulated from child messages and returned as a delta on each parent-visible start/resume/status result; cumulative usage remains for display.

Tests include no-provider-call child SDK construction and orchestration coverage under `test/tools/agent*.test.ts`. Real provider, lifecycle, and rendering checks remain in `src/tools/agent/README.md`.
