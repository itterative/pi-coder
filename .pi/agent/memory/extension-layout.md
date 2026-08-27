---
name: extension-layout
description: pi-coder is the consolidated extension; memory, agent, and sandbox modules are registered from src/index.ts.
category: architecture
---

The consolidated extension entrypoint is `src/index.ts`. It registers the memory module, config command (`src/commands/config.ts`), in-process agent tool, ask-user tool, bash hook, and read/write file-tool hooks; the audit command is intentionally not migrated. Agent implementation lives under `src/tools/agent` with tests under `test/tools/agent*.test.ts`; its `index.ts` registration function composes top-level `lifecycle.ts`, `browser.ts`, and `action-dispatch.ts` modules. Agent TUI is packaged under `src/tui/agents`, where agent-specific components compose the generic list/pager/select primitives. Agent lifecycle events use pi's namespaced `pi-coder:agent-event` event bus channel, with event contracts in `src/tools/agent/contracts/events.ts` and the event-bus adapter in `src/tools/agent/observability/events.ts`. Sandbox implementation lives under `src/modules/sandbox`, shared file-tool guarding under `src/tools/file-permissions.ts`, and memory under `src/modules/memory`, with tests under `test/modules` and config tests under `test/common`.
