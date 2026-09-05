---
name: compaction
description: pi-coder's two-stage compaction in src/modules/compaction — native span read then serialized reduce, the in-memory span transcript, cache/prefix measurements, details.route schema, trace stages, config, and the failure-handling inventory with its known gaps.
category: architecture
priority: 4
keep_updated: true
---

# Compaction

pi owns compaction; pi-coder replaces it with one `session_before_compact` handler in
`src/modules/compaction/index.ts` (`registerCompactionExtension`), installed for the parent from
`src/index.ts` and for every child as the `pi-coder-compaction` entry in
`src/tools/agent/child/index.ts:childExtensionEntries`. Read pi's `docs/compaction.md` and
`dist/core/compaction/compaction.js` before changing this; every invariant below came from reading core, not
from guessing. Returning `undefined` hands the compaction back to core.

## Why

Core serializes the summarized span (`serializeConversation`): `[Assistant thinking]:` **untruncated**, tool
results at a non-exported fixed 2000 chars, no overall budget — then sends it with `cacheRetention: "none"`
and a fresh `sessionId`, so all of that bulk is billed as fresh input. Thinking is normally the largest block
in a session, and pi keeps thinking in the live context anyway (`hideThinkingBlock` is display-only).

## Pipeline

1. **segment (stage 1, native)** — `span-session.ts` copies pi's resolved context entries
   (`ctx.sessionManager.buildContextEntries()`) truncated at `preparation.firstKeptEntryId` into
   `SessionManager.inMemory(cwd)`, and `convertToLlm(spanManager.buildSessionContext().messages)` yields the
   discarded span as **real message objects** — previous checkpoint included, retained tail excluded. Built
   with the parent's `ctx.getSystemPrompt()` and its active tools in `agent.state.tools` order, so the request
   is a strict shorter prefix of what the provider already cached. Tools stay in the request and are forbidden
   by `toolChoice: "none"`: removing them would move the prefix. A `toolCall` block in the response rejects
   the stage. Stage 1 gets **a third** of the output budget (`segmentBudget`) and is told it is an
   intermediate, because a generous intermediate becomes a rival draft: measured before that, stage 1 wrote
   3,207 tokens and the reduce then produced something *longer* than the material it was handed.
2. **reduce (stage 2, serialized)** — one bounded text-only call over `serializeConversationMinimal(span)` +
   stage 1's `<segment-checkpoint>`, plus `<previous-summary>` **only when stage 1 did not run** (stage 1's
   instruction already carries it forward, so feeding both invites a union of duplicates). Transcript-first on
   disagreement, checkpoint fills what compression removed, and the output must be no longer than the
   checkpoint it was given — merge and drop, never concatenate.
3. **core default** — `undefined`.

The fit gate is `nativeRequestFits`, which prefers **`ctx.getContextUsage().tokens`** (the provider's own
count) and only falls back to the chars/4 body estimate; the heuristic measured 1.35x hot on a JSON-heavy
session and 1.12x on a text one, and a hot estimate silently skips stage 1 on ~200k windows — exactly when
compaction matters. The live count includes the retained tail, so it is conservative in the right direction.

`overflow` skips stage 1 (the span provably does not fit). Stage 1 failing alone → stage 2 with no segment.
Stage 2 failing after stage 1 succeeded → **stage 1's text is persisted** (`route: "native"`). Nothing may
throw: the handler catches everything and warns, because a defect here should cost summary quality, never a
session that can no longer be compacted. `event.signal.aborted` returns `{ cancel: true }`.

## Measured

- **llama.cpp local (`qwen3.8-27b`), two-stage confirmed**: stage 1 truncated to the span accepted with
  `usage: { input: 766, cacheRead: 31885 }`, and the `prefix` record showed why: identical `systemChars`
  (24,619), identical `toolsHash`, 42 leading messages byte-identical, parent body 64 messages vs our 43 —
  i.e. a real shorter prefix, served from cache, for ~2% of the tokens fresh. Stage 2 cost 6,497 fresh with
  no cache, which is correct for a one-off. Whole compaction: ~7.3k fresh tokens.
- Same provider, earlier un-truncated design: `input: 376, cacheRead: 34339` — the first evidence the cache was
  reachable at all, and that `+tool_choice` does not disturb it.
- **Hosted `qwen-token-plan/qwen3.8-flash`**, 572-message session, 1M window: an earlier full-live-context
  design recorded `input: 330054, cacheRead: 0` while ordinary turns in that session report `input ≈ 1k,
  cacheRead ≈ 330k`. So that endpoint either will not serve a cache entry to an extended/rewound request or
  does not report it. Sending the whole live context (retained tail included) was the wrong call; truncating
  at the cut point is the fix, and cost is now bounded by stage 2's `serializedMaxTokens` (12k default).
- Post-compaction the next turn is cold regardless: core renders the summary as a leading user message
  (`COMPACTION_SUMMARY_PREFIX`).

## pi gaps found

- `@earendil-works/pi-agent-core` is nested under `pi-coding-agent/node_modules`, so `src/` must not name it:
  `AgentMessage`/`CompactionPreparation` types are derived in `types.ts` from `SessionBeforeCompactEvent`.
- pi's `appendMessage` doc comment references an `appendBranchSummary()` that **does not exist**, so
  `branch_summary` (and `label`/`session_info`) entries cannot be copied into the span transcript.
  `buildSpanSession` reports them in `skippedEntries` rather than faking them; stage 2's transcript still
  contains branch summaries because it is built from `preparation.messagesToSummarize`.
- `modelRegistry.complete()` does **not** traverse the agent's `onPayload` path, so
  `before_provider_request` never sees requests we send — that is why the diff needs both hooks.
- `ctx.getSystemPrompt()` does reflect the `before_agent_start` override (`_systemPromptOverride ??
  _baseSystemPrompt`), so pi-coder's injected `<memory_system>`/`<scratchpad_system>` blocks are included.

## Summary and details contract

`summary` = model text + `buildSupplementarySections()` (`## Verbatim Recent Requests`, `## Tool Ledger`,
`## Delegated Runs`, `## Dropped Context`, all computed by `analyzeSpan` rather than recalled) + pi's
`<read-files>`/`<modified-files>` tail. The model is told to write pi's section skeleton **only** and to skip
the harness-owned ones, so `CompactionSummaryMessageComponent` and the `/agents` transcript keep rendering.

`details` = `{ version: 1, route, provider, model, readFiles, modifiedFiles, summarizedMessages,
droppedBlocks }`. `route` is `"two-stage" | "native" | "serialized"` (renamed from `strategy` when stages
arrived; core reads only the two file-list keys, which **must keep pi's names** or cumulative file tracking
breaks silently). `firstKeptEntryId`/`tokensBefore` pass through from `preparation`, so core's default
~20k-token native tail is unchanged.

## Serializer

`serialize.ts` keeps pi's labels (`[User]:`, `[Assistant thinking]:`, `[Assistant]:`,
`[Assistant tool calls]:`, `[Tool result]:`, plus `[Bash]`, `[Bash result]`, `[System note]`,
`[Compaction summary]`) and changes the policy: thinking off by default, per-tool result caps that know an
`agent` report is worth more than `read` output, argument renderings that understand pi-coder's tools
(`agent` keeps action/agent/runId/title and reports `taskChars`; unknown tools degrade to sorted argument
**key names** only), and newest-first packing under `serializedMaxTokens` so an overflow request cannot fail
to fit. Look up transcript-derived keys through `configured()` (`Object.hasOwn`), never bare indexing: a tool
or argument named `constructor` otherwise yields a function where a character budget belongs.

## Trace

`trace.ts` appends one JSONL record per stage to `<pi-coder-install>/.state/compaction-trace.jsonl`
(`0600`, dir `0700`, rotated to a single `.1` at `traceMaxBytes`), all records of one compaction sharing an
`id`. Order for a successful two-stage run: `prefix`, `attempt(native)`, `model_response(native)`,
`attempt(serialized)`, `model_response(serialized)`, `final_summary`, `outcome`.

- `attempt` — per stage: `accepted`/`rejected`/`skipped`, detail, `usage` incl. **`cacheRead`** (the only way
  to tell whether the rebuilt prefix was served from cache), estimated tokens, tool/message counts, stage 1's
  `copiedEntries`/`skippedEntries`, stage 2's `serializedChars`/`segmentSummaryChars`.
- `prefix` — from `prefix-diff.ts`: our stage-1 body (captured via `onPayload`) diffed against the parent's
  last real body. Reports **every** content `divergences[]` (`system`, `tools(body)`, `tools(names)`,
  `messages[i]`), `prefixUsable`, `truncated`, and `parameters[]` for body keys only one side sent. Two rules
  learned the hard way: `tool_choice` is a **parameter**, never a prefix verdict; and a difference that starts
  exactly at our appended instruction on a `truncated` request is the designed shape, so it must report
  `usable: true` / `firstDivergence: "tail"` rather than look broken. Without those, every healthy run reads as
  a failure. `firstDivergence: "no-parent-payload-in-this-runtime"` is not a broken hook: the capture is a
  per-process map, so a compaction that runs after a restart or `/reload` — before any real parent turn in that
  runtime — legitimately has nothing to compare against.
- `model_response` — what the model said before the harness appended anything.
- `final_summary` — the exact persisted text plus its counts.
- `outcome` — `two-stage`/`native`/`serialized`/`core-default`/`cancelled`/`disabled`.

Follows `isAgentTraceEnabled()`, which moved to `src/common/trace.ts` (a session module must not reach into
the agent tool to ask whether it may write a file) and is still re-exported from
`tools/agent/observability/trace.ts` so agent-side imports did not move. Separately disable with
`COMPACTION_TRACE=0`, relocate with `COMPACTION_TRACE_PATH`. Writing never throws; with tracing off the
recorder is a no-op behind the same API. Records hold raw summary text, so **`test/setup.ts` disables the
trace repo-wide** the way it disables the bash decision log.

## Configuration

`compaction-config.json`, project (`.pi/`, nearest ancestor) over global (`~/.pi/`), env-overridable with
`COMPACTION_CONFIG_PATH` / `COMPACTION_CONFIG_PATH_GLOBAL`, mirroring `src/tools/agent/config.ts`. Malformed
or unknown fields fall back to defaults, because children run this unattended. `enabled: false` returns
`undefined`; core's own `compaction.enabled: false` still wins (the event never fires).
`serializedMaxTokens`, `keepThinking`, and the per-block char caps govern stage 2; `traceEnabled`/`tracePath`/
`traceMaxBytes` govern the trace; `model` is accepted but unused — the seam for the planned dedicated
compaction model, which wants the serialized route since it has no cache prefix to protect.

## The parent-body capture is memory-only

`lastParentPayload` is a module-level `WeakMap` in `index.ts` keyed by the `ctx.sessionManager` instance, set
by the `before_provider_request` handler and read (never cleared) when stage 1 diffs its own body.

- **Process-local.** A restart or `/reload` starts it empty, so the first compaction in a fresh runtime has
  nothing to compare against and reports `no-parent-payload-in-this-runtime`. That is not a broken hook.
- **Per session by identity.** A child's stage 1 compares against that child's own last body.
- **A reference, not a copy**: pi's own body object (1-2 MB at 330k tokens), replaced each request, released
  with the manager. Bounded to one per live session; storing the fingerprint instead would trade re-diffing
  for that retention.
- **Never persisted, never in the transcript.** Only the derived hashes/counts/320-char excerpts reach the
  trace file. Deliberately not `pi.appendEntry`: megabytes per compaction in the session file, re-scanned by
  every `getBranch()` forever, and custom entries never reach the model anyway.

## Failure inventory

Degradation is always toward core, never toward a broken session. Handled today: config off → `undefined`;
signal already aborted → `{ cancel: true }`; no model; stage 1 **skipped** by the fit gate; provider call
**threw**; response `stopReason` `error`/`aborted`; response contained a **`toolCall`**; **blank** summary;
stage 2 failed after stage 1 succeeded → **stage 1's text is persisted** (`route: "native"`) plus a warning;
both failed → core default plus a warning; any unexpected throw (span copy, tree walk, config read) → outer
catch → core default.

**We retry nothing at our layer.** pi's `retryProviderRequest` defaults to `maxRetries ?? 0` and we pass no
`maxRetries`, while core's own compaction passes `getRetrySettings()` — so one 429 kills our attempt where core
would have waited. Deliberate for now, but it is an asymmetry, not a parity.

Open gaps, agreed 2026-09-05 and **not yet implemented**:

1. **No cause classification.** Context overflow and exhausted quota both land as `rejected` with a message
   string, yet the right response is opposite: overflow means stage 2 (bounded, no tools) is the fix, while
   quota/auth means stage 2 is a second doomed request and core's default a third. Reuse pi-ai's
   `isContextOverflow(message, contextWindow)` (root export; its docs enumerate llama.cpp
   "exceeds the available context size" and DashScope/Qwen "Range of input length should be [1, X]", and its
   `NON_OVERFLOW_PATTERNS` suppresses `/rate limit/i`) plus `status`/`headers` on provider errors for
   401/402/429. Verified statically (types and export surface) only — a `tsx` probe died on module resolution,
   not on pi.
2. **`stopReason: "length"` on a summarization response is accepted**, so a checkpoint truncated mid-section
   becomes the session's memory. Should reject and cascade; pi-ai's `isRecoverableLength` also treats a short
   `length` stop as context pressure, so this fix does double duty.
3. **Abort mid-flight returns `undefined`**, so core then issues its own doomed call on the dead controller;
   returning `{ cancel: true }` once a failure is known to follow an abort is cleaner.
4. **Children have no UI** (`print` mode), so every warning here reaches only the trace and the run
   diagnostics: a quota-starved child looks like a normal finish with a mediocre summary.
5. **Silent-overflow providers** (pi's own doc names z.ai, MiMo, Ollama truncation) could accept a clipped
   stage-1 input and produce a confident checkpoint of half a conversation. `estimatedTokens`,
   `reportedContextTokens`, and `usage.input` are all logged now, which is what makes a mismatch check
   possible later.
6. **A missing cut point is invisible.** If `preparation.firstKeptEntryId` is not on the path,
   `spanContextEntries` returns everything and stage 1 silently stops truncating — i.e. it goes back to full
   price. A `cutFound` field on the stage-1 `attempt` record closes it.

## Validation

`test/modules/compaction/{serialize,sections,handler,trace,prefix-diff,span-session}.test.ts` — 62 cases, two
reviewed file snapshots, no provider calls (`createCompactionHarness()` in `test/helpers/compaction-doubles.ts`
records the contexts and options a `stubModelRegistry` receives). Stage-1 truncation is pinned by a 1.2M-char
*retained-tail* fixture: if someone re-sends the live context, the fit gate skips stage 1 and that test fails.
Mutation-verified: reverting the fit formula to `reserveTokens` fails the sizing test; deleting
`trace.modelResponse(...)` fails two trace tests. Real provider behavior (`tool_choice`, cache serving,
`toolCall` refusals) and child execution stay manual — see `src/tools/agent/README.md` § "Changing child
compaction".
