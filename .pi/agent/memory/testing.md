---
name: testing
description: Local validation commands and manual checks for the consolidated pi-coder extension.
category: workflow
---

# Testing pi-coder

Run the full suite with `npm run test:run` and check types with `npx tsc --noEmit`. The tests cover the consolidated TUI, memory, config, and sandbox modules.

For a manual permission-prompt check, run `cat /etc/hostname`; without a matching rule it should prompt with `ask`. Verify the `selectWithMessage` UI, long-command wrapping and scrolling, Tab edit mode, bracketed clipboard paste, wrapped feedback, and Enter/Escape behavior.

Database-backed agent tests must use an explicit temporary state/workspaces directory; integration tests that only exercise agent action presentation should mock catalog access rather than allowing the default `.state/meta.sqlite` path. The project-local `.state/` directory is runtime state and must not be mutated by the test suite.

Relevant test locations:

- `test/ask-user.test.ts`, `test/select-with-message.test.ts`, and `test/inline-editor.test.ts` for TUI editing.
- `test/modules/memory/` for frontmatter parsing, memory scanning, and list formatting.
- `test/common/config.test.ts` and `test/modules/sandbox/` for sandbox behavior, heuristics, permissions, resolution, suggestions, bubblewrap, fuzzing, and bash parsing.
