---
name: compaction
description: pi-coder's replacement compaction path in src/modules/compaction — the native-continuation/serialized cascade, its cache and tool_choice invariants, the details schema, and the config file.
category: architecture
priority: 4
keep_updated: true
---

# Compaction

pi owns compaction; pi-coder overrides it by registering one `session_before_compact` handler in
`src/modules/compaction/index.ts` (`registerCompactionExtension`), installed for the parent from
`src/index.ts` and for every child as the `pi-coder-compaction` entry in
`src/tools/agent/child/index.ts:childExtensionEntries`. Reading `pi`'s
`docs/compaction.md` and `dist/core/compaction/compaction.js` before changing this is worth it: the
invariants below were found by reading core, not by trial.

## Why it exists

Core serializes the summarized span to text (`serializeConversation`) and sends it as a one-off request with
`cacheRetention: "none"` and a fresh `sessionId`. That serialization is heavy in exactly the places that do
not help a summarizer — `[Assistant thinking]:` arrives **untruncated** (thinking is normally the largest
block in a session, and pi keeps it in the live context; `hideThinkingBlock` is display-only), tool results
get a fixed non-exported 2000-character cap per tool regardless of what the tool returns, and no overall
budget exists — and because the request opts out of caching, all of that bulk is billed as fresh input. The
replacement reads the real conversation instead of a retyped copy of it.

## The cascade

`native` → `serialized` → **core default** (return `undefined`). `overflow` skips straight to `serialized`,
because by definition the live context no longer fits. Every failure is a returned value, never an
exception: the outer `try` in `registerCompactionExtension` catches anything that escapes, warns, and returns
`undefined` so core's default path runs — a bug here costs summary quality and never leaves a session
uncompactable. A response that
contains a `toolCall` block is treated as a strategy failure (we sit outside the agent loop, so those calls
would never execute, and a model that ignored `tool_choice` will ignore the rest of the directive).
`event.signal.aborted` returns `{ cancel: true }` rather than issuing a doomed request.

## Native strategy invariants

The payoff depends on the request being **prefix-identical** to what pi last sent, so:

- system prompt comes from `ctx.getSystemPrompt()` (it reflects the `_systemPromptOverride` that
  `before_agent_start` installed, pi-coder's own `<memory_system>`/`<scratchpad_system>` blocks included);
- tools are `pi.getActiveTools()` names mapped back onto `pi.getAllTools()` entries, which preserves
  `agent.state.tools` order — not configured order, and not every configured tool;
- messages are `convertToLlm(buildSessionContext(ctx.sessionManager.getBranch()).messages)`, i.e. pi's real
  active context including previous compaction summaries;
- options set `toolChoice: "none"` (declared on every pi-ai API option type) and **keep** default
  `cacheRetention` plus the session's own `sessionId`;
- output budget mirrors core: `min(0.8 × reserveTokens, model.maxTokens)`.

`nativeRequestFits` gates on `contextWindow - outputBudget`, **not** on `reserveTokens`. A threshold-triggered
compaction runs at exactly `contextWindow - reserveTokens`, so re-reserving that window rejects every request
this strategy exists for; `test/modules/compaction/handler.test.ts` has a ~750k-character fixture that lands
between the two thresholds specifically to catch that mistake (verified: reverting the formula to
`reserveTokens` fails only that test).

Cache-hit caveat, unmeasured: Anthropic-style caching matches prefixes at written breakpoints, so the benefit
comes from re-sending the whole live context. Post-compaction the next turn is cold either way, because core
renders the summary as a leading user message. The `attempt` trace record reports `cacheRead` for every
accepted attempt, which is what turns that caveat into a measurement (see **Trace** below).

## Serialized strategy

`src/modules/compaction/serialize.ts` keeps pi's line labels (`[User]:`, `[Assistant thinking]:`,
`[Assistant]:`, `[Assistant tool calls]:`, `[Tool result]:`, plus `[Bash]`, `[Bash result]`, `[System note]`,
`[Compaction summary]`) and changes the policy: thinking dropped by default, per-tool result caps that know
an `agent` report is worth more than `read` output, argument renderings that understand pi-coder's own tools
(`agent` keeps action/agent/runId/title and reports `taskChars`; unknown tools degrade to sorted **key names
only**, never values), and newest-first packing under an explicit token ceiling so an overflow request is
guaranteed to fit. Look up transcript-derived keys through `configured()` (`Object.hasOwn`), not bare
indexing: a tool or argument named `constructor` otherwise yields a function where a budget belongs.

## Summary and details contract

`summary` = model text + `buildSupplementarySections()` (`## Verbatim Recent Requests`, `## Tool Ledger`,
`## Delegated Runs`, `## Dropped Context`) + pi's `<read-files>`/`<modified-files>` tail. Those sections are
computed from the span rather than recalled by the model, which is the point: a wrong count reads as
authority. The model is told to write pi's skeleton **only** and to skip the harness-owned sections.

`firstKeptEntryId` and `tokensBefore` pass through from `event.preparation`, so core's default ~20k-token
native tail is unchanged. `details` keeps `readFiles`/`modifiedFiles` under those exact names: core extracts
them from the previous compaction entry to build the cumulative file ledger, so renaming them breaks tracking
silently rather than loudly. `version: 1` and `strategy` sit alongside them.

## Trace

`src/modules/compaction/trace.ts` appends one JSONL record per stage to
`<pi-coder-install>/.state/compaction-trace.jsonl` (mode `0600`, directory `0700`, rotated into a single
`.1` generation once it passes `traceMaxBytes`). Every record of one compaction shares an `id`:

- `attempt` — one per strategy, written once that attempt is over: `accepted` / `rejected` / `skipped`, the
  detail, and `usage` including `cacheRead`, which is the only way to tell whether re-sending the live
  context actually reused the provider's cached prefix. Also carries the estimated request size and tool /
  message counts, plus the serialized route's transcript and dropped-block counts.
- `model_response` — what the model said, before the harness appended anything.
- `final_summary` — the exact text written into the `CompactionEntry`, with the counts it came from.
- `outcome` — how the whole compaction ended: `native`, `serialized`, `core-default`, `cancelled`, `disabled`.

It follows `isAgentTraceEnabled()`, the same development switch the delegated-agent timelines use, and is
separately disableable with `COMPACTION_TRACE=0` or relocatable with `COMPACTION_TRACE_PATH`; `traceEnabled`,
`tracePath`, and `traceMaxBytes` live in the config file. That switch moved to `src/common/trace.ts` (re-
exported unchanged from `tools/agent/observability/trace.ts`, so agent-side imports did not move) because a
session module must not reach into the agent tool to ask whether it may write a file. Writing never throws,
and with tracing off the recorder is a no-op behind the same API, so the cascade reads identically either way.
The records hold raw summary text, so treat the file like a transcript.

## Configuration

`compaction-config.json`, project (`.pi/`, nearest ancestor) over global (`~/.pi/`), env-overridable with
`COMPACTION_CONFIG_PATH` / `COMPACTION_CONFIG_PATH_GLOBAL`, mirroring `src/tools/agent/config.ts`. Unknown or
malformed fields fall back to defaults, because a child runs this unattended. `enabled: false` returns
`undefined` and restores core's behavior for A/B. `model` is accepted but unused: it is the seam for the
planned dedicated-compaction-model strategy, which would forfeit the cache prefix and therefore wants the
serialized path, not the native one. Core's own `compaction.enabled: false` still wins — the event never
fires. Tests pin both config locations to nonexistent temp paths via `vi.stubEnv` so they can never read the
developer's own file.
