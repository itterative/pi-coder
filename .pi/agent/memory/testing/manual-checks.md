---
name: manual-checks
description: Manual permission-prompt and selectWithMessage UI checks to run by hand, and where the delegated-agent manual checklist lives.
category: workflow
---

# Manual checks

For a manual permission-prompt check, run `cat /etc/hostname`; without a matching rule it should prompt with
`ask`.

Verify the `selectWithMessage` UI: long-command wrapping and scrolling, Tab edit mode, bracketed clipboard paste,
wrapped feedback, and Enter/Escape behavior.

**Agent lifecycle, provider, and rendering changes are not covered by the suite** — tests make no provider calls.
Follow the manual checklist in `src/tools/agent/README.md` for those.

Related: the shared TUI driving helpers these checks correspond to are in `../test-doubles/tui-e2e.md`, and the
session-rule/permission behavior around the prompt is the sandbox cluster (`../sandbox.md`).
