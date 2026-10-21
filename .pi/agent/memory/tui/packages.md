---
name: packages
description: "Boundaries of the agents/ and decision/ TUI packages, the Spinner, and where transcript projections belong. Load when extending either package."
category: architecture
keep_updated: true
---

# TUI packages: `agents/`, `decision/`, `spinner.ts`

## `agents/` — agent-specific browser TUI

- Agent-specific browser TUI package. Its browser, session/workspace details, and workspace browser implement `Component` and compose the generic list/pager/select components.
- Agent browser imports should use `src/tui/agents` directly.
- Session-transcript projections, including TODO transcript formatting, belong under `src/tools/agent/presentation/` rather than the status package.
- Add focused package tests when extending its controller/lifecycle behavior.

The companion boundary rule — shared agent diagnostic formatting belongs in `src/tools/agent/presentation/text.ts`, not the TUI barrel — is recorded in [`../agents.md`](../agents.md), and the browser host itself is described in [`list-view.md`](list-view.md).

## `decision/` — decision-model settings TUI

- Decision-model settings package (`settings.ts` + index): a `ListViewComponent` subclass with toggle/field rows, opening a searchable classifier `SelectComponent` and `textInput`s as nested overlays.
- The agent browser Settings tab opens it through `onDecisionModelOpen`.
- The folder mirrors `agents/` as the place for decision-specific TUI, not the status package.

Classifier behavior behind those rows is [`../decision-model.md`](../decision-model.md).

## `spinner.ts`

- `Spinner`: small reusable animated frame component with configurable frames/interval, `setActive()`, and `dispose()`.
- It requests TUI renders while active, pauses on the shared `pi-coder:tui-dialog` EventBus event, and is used by the delegated-agent status footer.

## Transcript projection

- Agent transcript formatting collects ordered conversation entries separately from one optional TODO entry.
- The renderer inserts that TODO immediately after the initial user context (or at the start when no user entry exists), then applies detailed or collapsed tool-call rendering.
- The session detail overlay receives structured transcript parts, renders prose through Markdown, and emits tool-call parts as plain lines.
- Detailed edit/write calls default to concise changed-line counts; the formatter retains an opt-in constant for full diff lines if that presentation is desired later.

Presentation tests cover ordering and browser snapshots cover the resulting TUI.
