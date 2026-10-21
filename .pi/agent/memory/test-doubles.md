---
name: test-doubles
description: Catalog of shared test doubles and helpers, plus which helper to reuse instead of hand-building a literal.
category: workflow
priority: 2
keep_updated: true
---

# Test doubles and shared helpers

**Which double do I need?** Need → helper file → symbols. The reuse rule's history:
`testing/doubles-and-any.md`.

- `pi` surface to register into → `test/helpers/pi-stub.ts` → `createPiStub()`
- context a handler is invoked with → `pi-stub.ts` → `stubContext()`, `stubUi()`, `stubSessionManager()`
- invoking a registered slash command → `pi-stub.ts` → `stubCommandContext()`, `stub.requireCommand(name)`
- domain object, most fields irrelevant → `test/helpers/agent-doubles.ts` → `partialRun`, `partialDetails`,
  `partialWorkspace`, `partialWorkspaceResult`, `partialTracker`, `zeroUsage`
- event for `updateTracker` → `test/helpers/session-events.ts` → `messageStartEvent`,
  `textDeltaEvent`, `thinkingDeltaEvent`, `toolExecutionStartEvent`, `toolExecutionEndEvent`
- durable-persistence / state-writer double → `agent-doubles.ts` → `partialPersistence`, `partialStateWriter`
- driving a real dialog → `pi-stub.ts` → `stubUiWithDialogs(theme)`
- context whose session manager writes entries → `pi-stub.ts` → `stubSessionContext(parent)`
- widget/dialog terminal environment → `test/helpers.ts` → `stubTui(overrides)`, `FocusAwareTui`
- typed dialog factory + options → `pi-stub.ts` → `StubComponentFactory`, `StubDialogOptions`
- pi's tool-render context → `pi-stub.ts` → `noRenderContext`
- recording two-member event bus → annotate `const events: EventBus = { emit, on }`
- decision classifier registry, model, criterion answer, or **log record** → `test/modules/decision/classifier.ts`
  → `classifier`, `criterionResult`, `selectionRegistry`, `answeringRegistry`, `classifierModelRegistry`,
  `classifierRecord`
- decision request contexts the snapshots pin → `test/modules/decision/fixtures.ts` → `FIXTURES`, `packageDeploy`,
  `parentRewrite`, `indentedJson`
- child extension wired as production wires it → `test/tools/child-run-fixture.ts` → `buildChildRun`,
  `probeDefinition`, `mode.decision`
- compaction event, summarized span, or provider summary → `test/helpers/compaction-doubles.ts` → `compactEvent`,
  `compactionPreparation`, the six message builders, `messageChain`, `fileOperations`, `summaryResponse`,
  `toolCallResponse`
- **session entry** that is not a message → `compaction-doubles.ts` → `messageEntry`, `compactionMarker`,
  `modelChangeMarker`, `customMessageEntry`, `customEntry`
- recorded compaction trace → `test/helpers/compaction-trace.ts` → `loadCapture`, `openTraceLog`, `sessionIdOf`
- driving a TUI component → `test/helpers.ts` → `KEY`, `mockTheme`, `press`, `type`, `paste`, `interact`,
  `renderText`, `snapshotText`
- temp dirs, SQLite, git for agent lifecycle → `test/tools/e2e/helpers.ts` → `createE2EPaths`, `createE2EContext`,
  `withE2EMetadataDatabase`, `createScriptedChild`, `insertE2EAgentRun`, `initializeRepository`
- TypeScript script driven as a real CLI (argv, exit codes, stdout) → `test/helpers/script-bundle.ts` →
  `bundleScript(entry)`
- template-string fixtures without indentation → `test/modules/memory/utils.ts` → `dedent`

## Targeted references

- `test-doubles/pi-stub.md` — `createPiStub` surface, context doubles defined there.
- `test-doubles/domain-partials.md` — `partial*` catalog, session events, `dedent`, context by parameter type.
- `test-doubles/tui-e2e.md` — TUI driving, `stubTui`, e2e scaffolding, `child-run-fixture`, `bundleScript`.
- `test-doubles/decision-and-trace-doubles.md` — classifier/decision fixtures, entries vs messages, trace reader.
- `test-doubles/rules.md` — seven rules, narrowing policy.
- `test-doubles/known-drift.md` — live drift worklist.

Related: `testing.md` (validation commands and the writing-tests checklist), `agents/architecture.md` +
`agents/safety.md` (child gates and registered handlers), `complexity-hotspots.md`.
