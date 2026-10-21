---
name: decision-and-trace-doubles
description: Classifier and decision-context fixtures, compaction message and entry doubles, the trace reader, and the entry-vs-message distinction.
category: workflow
keep_updated: true
---

# Decision, compaction, and trace doubles

## Decision classifier fixtures — `test/modules/decision/classifier.ts`

A decision classifier registry, model, criterion answer, or **log record**:

- `classifier(provider, id)` and `criterionResult(model, reason, confidence)`.
- `selectionRegistry(models)` — resolves models, throws on `classify`.
- `answeringRegistry(models, behavior)`.
- `classifierModelRegistry(registry)` — the single cast to pi's `ModelRegistry`.
- `classifierRecord(overrides)` — a `BashClassifierRecord` as a gate wrote it. **What the block-reason sentences
  render is the record, so a wording test needs a record, not a verdict.**

Not: a local `ClassifierModel` literal, a hand-built `getModelOfType`/`classify` object, or a hand-written record
fixture per suite.

## Decision request contexts — `test/modules/decision/fixtures.ts`

The request contexts the decision snapshots pin: `FIXTURES`, `packageDeploy`, `parentRewrite`, `indentedJson` —
not a local `DecisionContext` literal duplicated across snapshot suites.

## Compaction events, messages, and summaries — `test/helpers/compaction-doubles.ts`

A compaction event, summarized span, or provider summary response: `compactEvent`, `compactionPreparation`,
`userMessage`/`assistantMessage`/`toolResultMessage`/`bashExecutionMessage`/`customMessage`/
`compactionSummaryMessage`, `messageChain`, `fileOperations`, `summaryResponse`, `toolCallResponse`.

Not: hand-built `AgentMessage` literals, or a `SessionManager` transcript you then have to parse.

## Session entries of a type that is not a message

`messageEntry`, `compactionMarker`, `modelChangeMarker`, `customMessageEntry`, `customEntry` — not a
`{ type: "custom_message", ... } as SessionEntry` literal.

**Entry types are not message types.** `customMessage(customType, text, display)` builds a *message* with
`role: "custom"`; `customMessageEntry(id, customType, content)` builds the *session entry* pi stores for
`appendCustomMessageEntry`, which `buildContextEntries` turns into that message. Sizing and span code reads
entries, so a suite that needs a marker row wants the entry double — and the assertion that makes the pair mean
something is that a `custom_message` entry costs tokens while the `customEntry` beside it costs nothing.

## Recorded compaction trace — `test/helpers/compaction-trace.ts`

`loadCapture`, `openTraceLog`, `sessionIdOf`, `fixturePath`, `nativeAttempts`, `chainRequests`, `prefixRecords`,
`providerPromptTokens`, `requireAttemptForFold`.

Not: `readFileSync(trace).split("\n").map(JSON.parse)`, or a local `interface TraceAttempt`. The rotation,
torn-line, and session-filtering hazards behind that rule are `../testing/trace-fixtures.md`.

Related: reaching a gate with these doubles is `../testing/decision-gates.md`; the decision model's own behavior
is the `decision-model` memory (`../decision-model.md`).
