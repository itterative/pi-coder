---
name: extension-layout
description: pi-coder is the consolidated extension; memory and sandbox modules are registered from src/index.ts with tests under test/modules.
category: architecture
---

The consolidated extension entrypoint is `src/index.ts`. It registers the memory module, config command (`src/commands/config.ts`), ask-user tool, bash hook, and read/write file-tool hooks; the audit command is intentionally not migrated. Sandbox implementation lives under `src/modules/sandbox`, shared file-tool guarding under `src/tools/file-permissions.ts`, and the memory implementation under `src/modules/memory`, with tests under `test/modules` and config tests under `test/common`.
