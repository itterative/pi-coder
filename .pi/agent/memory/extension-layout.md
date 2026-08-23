---
name: extension-layout
description: pi-coder is the consolidated extension; sandbox tests are ported under test/modules/sandbox and config is registered from src/index.ts.
category: architecture
---

The consolidated extension entrypoint is `src/index.ts`. It registers the config command (`src/commands/config.ts`), ask-user tool, and bash hook; the audit command is intentionally not migrated. Sandbox implementation lives under `src/modules/sandbox`, with ported upstream tests under `test/modules/sandbox` and config tests under `test/common`.
