---
name: test-map
description: Where the suites live for TUI editing, memory frontmatter and scanning, sandbox behavior and bash parsing, and the bash decision log.
category: workflow
---

# Where the suites live

Relevant test locations:

- `test/ask-user.test.ts`, `test/select-with-message.test.ts`, and `test/inline-editor.test.ts` for TUI editing.
- `test/modules/memory/` for frontmatter parsing, memory scanning, and list formatting.
- `test/common/config.test.ts` and `test/modules/sandbox/` for sandbox behavior, heuristics, permissions,
  resolution, suggestions, bubblewrap, fuzzing, and bash parsing.
- `test/tools/bash-decision-log.test.ts`, `test/modules/sandbox/decision-log.test.ts`, and
  `test/scripts/permission-report.test.ts` for the bash decision log and its mining script (see
  `../sandbox/decision-log.md`).
- `test/tools/e2e/` for the shared workspace lifecycle E2E tests.

Related: the helpers these suites import are catalogued in `../test-doubles.md`.
