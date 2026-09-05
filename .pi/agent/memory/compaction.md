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

**Read it with `npm run compaction-report`** (`scripts/compaction-report.mjs`), never by hand-rolling jq joins
again: it groups records by run id and prints the prefix verdict, one line per stage attempt with its request
numbers and `in/cached/out`, the persisted summary's size and cut point, then ROUTES / ATTEMPT FAILURES /
SUSPECTS / PREFIX DIVERGENCES / COST AND CACHE / COMPRESSION aggregates. `--dump[=native|serialized|final|all]`
prints stage text **verbatim** (the report body only previews it, because a checkpoint is markdown);
`--suspect`, `--grep <text>`, `--session <prefix>`, `--route`, `--reason`, `--since`, `--runs 0` (all) and
`--json` cover the rest. Its SUSPECTS flags encode the failure modes below as thresholds —
`prefix-unusable`, `span-not-truncated`, `degenerate-native-output`, `degenerate-final-summary`,
`reduce-inflated`, `cache-read-zero`, `blocks-dropped`, `fell-back`, `estimate-skew` — with prose in
[docs/compaction-trace-report.md](../../../docs/compaction-trace-report.md). It reads rotated `.1` siblings and
tolerates fields absent in records from older builds, because the file accumulates across checkout.

- `attempt` — per stage: `accepted`/`rejected`/`skipped`, detail, `usage` incl. **`cacheRead`** (the only way
  to tell whether the rebuilt prefix was served from cache), estimated tokens, tool/message counts, stage 1's
  `copiedEntries`/`skippedEntries`, stage 2's `serializedChars`/`segmentSummaryChars`.
- `prefix` — the verdict from `chain.ts` against our `onPayload` body: which reference answered, how deep the
  agreement went, and the parameters only one side sent. Two rules survive from the body-to-body era:
  `tool_choice` is a **parameter**, never a prefix verdict, and an absent reference is **unknown**, never
  `false`.
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

## The request chain: hashes retained, bodies dropped

`chain.ts` replaced the parent-body capture. `index.ts` keeps `WeakMap<sessionManager, RequestChain>`, and
`before_provider_request` calls `observeParentRequest()`, which folds a cumulative head over
`body.messages` and then **drops the body**:

```
head(0) = sha256("pi-coder/compaction-chain/v1")
head(k) = sha256(head(k-1) + 0x1f + JSON.stringify(messages[k-1]))   truncated to 16 hex
```

One observation per provider request: `{leafId, depth, head, systemHash, toolsHash, systemChars, keys,
model, toolNames?}` — `toolNames` only when the shape changed. About seventy bytes where a body was one to two
megabytes, so the cap is a memory bound rather than a correctness one (`MAX_OBSERVATIONS = 2000`, ~140 KB),
and dropping the oldest only costs resolution on depths compaction passed long ago.

Four consequences, each learned from a real trace:

- **Branch-correct by construction.** `match()` filters observations to leaf ids on `getBranch()`, so a
  request captured on a branch that was navigated away from cannot be chosen as a reference. This replaces the
  old bug where navigating back produced a confident `prefixUsable: false` plus `div=messages[42], rewind` —
  the number was right, the verdict was wrong, because the reference came from a dead branch.
- **`prefixUsable` is omitted, never `false`, when no reference exists.** "Could not tell" and "misaligned"
  were one value, and a cold process after a restart read as a broken rebuild. The record now carries
  `reference: "none"` and `firstDivergence: "no-reference"`.
- **Comparing at the *reference's* depths makes tail-awareness unnecessary.** Our body is the span plus one
  appended instruction, and every reference depth is at or below the span, so the instruction is never inside
  the window being checked. The `truncated && divergence-at-our-last-message` special case that the
  body-to-body diff needed is gone from `src`; `diffRequestPrefixes` no longer exists.
- **The system prompt must be hashed whole.** `requestShape()` hashes raw text while the human-facing
  `fingerprintPayload()` keeps a 320-char excerpt, because a 24 KB prompt differing only at character 9000 is
  exactly the drift an excerpt would hide.

Cost is a full re-hash per request (single-digit milliseconds on an 880-message body) and is gated by tracing
being on. Nothing here gates compaction: stage 1 is built and sent identically whether or not any observation
exists. `parameters[]` survives as a set difference over body keys, which keeps the "`tool_choice` is a
parameter, not a verdict" lesson expressible without retaining a body.

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
2. **`stopReason: "length"` on a summarization response is accepted.** Partly mitigated: a length-truncated
   reply usually loses a section and is now rejected by the shape guard, but a truncation that keeps two
   headings still passes.
2b. **`ToolInfo` hides a field that reaches the wire.** `pi.getAllTools()` returns
   `Pick<ToolDefinition, "name"|"description"|"parameters"|"promptGuidelines"> & {sourceInfo}` and pi keeps the
   full `ToolDefinition` privately (`getToolDefinition` exists on the runner, not on the extension API).
   pi-ai's OpenAI serializer reads `tool.constrainedSampling` to decide `function.strict`
   (`constrained-sampling.js:50`), so a tool declaring it would make pi's `tools` array differ in bytes from
   ours while the extension API cannot see the field at all — the one place our rebuilt prefix is *not*
   guaranteed by construction. Latent today: no pi built-in and no pi-coder tool declares it. Upstream ask:
   add the field to the projection, or expose `getToolDefinition`. A `getAllTools()`-based shape hash catches
   it if it ever fires, which is the main reason the chain records tool names on every shape change., so a checkpoint truncated mid-section
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
6. **A degenerate stage-1 answer is accepted. CLOSED 2026-09-05.** On a live run stage 1 answered 509k tokens
   of context with 35 tokens of *"I don't have any prior thinking to reproduce — this is the first turn of our
   conversation, so there is no previous internal reasoning that exists to be audited verbatim."* Non-empty,
   fluent, useless, and accepted, so the run persisted as `route: "two-stage"` over a 169-char checkpoint. Now:
   `prompt.ts` owns `CHECKPOINT_SECTIONS` (lowercase **words**, beside the format they come from, so the
   instruction and the guard cannot drift), `MIN_CHECKPOINT_SECTIONS = 2`, and
   `checkpointSectionCount(text)`; `summarize.ts` rejects below that with a `detail` quoting the reply head,
   which cascades to the serialized rung. Both regexes are module constants, and a heading resolves to one
   section by its first recognized word — so `## Constraints & Preferences` counts once and a single heading
   can never satisfy the guard twice. Deliberately **not** in `src`: any character or token floor, because
   length is provider- and language-dependent; it stays a report flag (`degenerate-native-output`) where the
   threshold is a free knob. The baiting clause is also gone — `splitTurn` now says the remainder is "kept
   as-is below", and the instruction adds "It is your only input: do not describe, reproduce, or audit any
   reasoning, thinking, or internal process" (core leaves reasoning enabled for these calls,
   `compaction.js:426`).

7. **Stage 2's transcript cap silently shrinks the input.** `config.ts:36` `maxChars: 48_000` made
   `serializeConversationMinimal` drop **702 message blocks** on that same run, so the persisted summary covered
   a truncated view — and because stage 1 failed, the capped reduce was the *only* real input. These are
   independent knobs: fixing stage 1 does not raise the cap, and raising the cap does not fix stage 1. Watch
   `blocks-dropped` and `degenerate-native-output` separately in `npm run compaction-report -- --suspect`.

8. **A missing cut point is invisible.** If `preparation.firstKeptEntryId` is not on the path,
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
