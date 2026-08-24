---
name: extension-layout
description: pi-coder is the consolidated extension; memory, agent, and sandbox modules are registered from src/index.ts.
category: architecture
---

The consolidated extension entrypoint is `src/index.ts`. It registers the memory module, config command (`src/commands/config.ts`), in-process agent tool, ask-user tool, bash hook, and read/write file-tool hooks; the audit command is intentionally not migrated. Agent implementation lives under `src/tools/agent` with tests under `test/tools/agent*.test.ts`. Agent lifecycle invalidation events use pi's namespaced `pi-coder:agent-state-changed` event bus channel, defined in `src/tools/agent/events.ts`. Sandbox implementation lives under `src/modules/sandbox`, shared file-tool guarding under `src/tools/file-permissions.ts`, and memory under `src/modules/memory`, with tests under `test/modules` and config tests under `test/common`.
