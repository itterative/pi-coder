---
name: compaction
description: "pi-coder's two-stage compaction in src/modules/compaction — native span read then serialized reduce, the in-memory span transcript, cache/prefix measurements, details.route schema, trace stages, config, and the failure-handling inventory with its known gaps. Read first for a short system prompt (12,817c), an unexpected `obs=0`, or any prefix-cache divergence: those are settled facts here, not new findings."
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
   is a strict shorter prefix of what the provider already cached. Tools stay in the request - removing them
   would move the prefix - and the prohibition is the instruction text, because `tool_choice` is not sent (see
   **`tool_choice` is not sent** below). Stage 1 also forwards the session's thinking level as `reasoningEffort`
   so the thinking parameters match pi's turn requests (**stage 1 forwards the thinking level** below); stage 2
   deliberately does not. A `toolCall` block in the response rejects the stage; a call the server
   leaves unparsed arrives as text and is **not** detected. Stage 1 and stage 2 get the **same** output cap (see
   "The budgets behind the fit test" - a cap that binds discards a checkpoint whole) and stage 1 is told it is an
   intermediate, because a generous intermediate becomes a rival draft: measured before any cap existed, stage 1
   wrote 3,207 tokens and the reduce then produced something *longer* than the material it was handed. That risk is
   carried by the instruction and the report's ratio, not by a smaller cap.
2. **reduce (stage 2, serialized)** — one bounded text-only call over `serializeConversationMinimal(span)` +
   stage 1's `<segment-checkpoint>`, plus `<previous-summary>` **only when stage 1 did not run** (stage 1's
   instruction already carries it forward, so feeding both invites a union of duplicates). Transcript-first on
   disagreement, checkpoint fills what compression removed, and the output must be no longer than the
   checkpoint it was given — merge and drop, never concatenate.
3. **core default** — `undefined`.

The fit gate is `nativeRequestFits`, and `fitRequirementTokens` decides what it measures against the window, best
evidence first: the **exact-cut** count (the provider's own `input + cacheRead + cacheWrite` for the reply sitting
*at* the cut point, whose request body was exactly this span — see **Requests are sized from the session's own
counts**), then the **span-anchored** count (a provider's `usage.totalTokens` for a reply inside the span, plus
chars/4 only for what followed it and for the appended instruction), then **`ctx.getContextUsage().tokens`**, then
the whole-body chars/4 guess. Every count tier is filtered by `countBoundary`: a number that predates the newest
`compaction`, `model_change`, or `thinking_level_change` row describes a body that no longer exists and is
rejected, counted in `staleAnchors`. The last tier is *not* the provider's count of the request — it counts the
retained tail stage 1 drops, and it is `null` right after a compaction, which is when compaction usually runs. A
hot estimate alone used to skip stage 1 on ~200k windows; the counts are what removed that and the tail's
inflation.

`overflow` **attempts** stage 1: it used to be skipped outright, on the reasoning that the live context provably
does not fit — true of the live context, false of a shorter prefix of it, which is what the cut walk looks for.
Stage 1 failing alone → stage 2 with no segment.
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
  reachable at all, and that the `tool_choice` we sent then did not disturb it (we no longer send it).
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
- **A provider failure never throws at a `complete()` caller.** pi-ai normalizes it into an `AssistantMessage`
  with `stopReason: "error"` and `errorMessage`; our `catch` only catches programming errors, so classifying the
  exception arm as anything but `unknown` would be theatre. There is no typed provider error either: the HTTP
  status survives only as a string prefix (`"429 ..."`) because both vendored SDKs format `${status} ${msg}`,
  which pi-ai's own patterns (`/429/`, `/502/`) rely on. Not a contract.
- **`Retry-After` is unreachable from an extension.** The error object that carries `headers` is discarded in
  the adapter's catch, and `onResponse` is invoked on the line *after* `retryProviderRequest`, so it never sees a
  non-2xx for `openai-completions` (our llama.cpp route) or `anthropic-messages`. The only way to honour a
  server-directed delay is to pass `maxRetries` and let the transport retry do it blindly — blind in both
  directions: it resends quota-shaped 429s, and its retries never appear in our trace. Upstream ask: surface
  `status` (or a parsed `retryAfterMs`) on the normalized error.
- pi-ai's transport retry (`retryProviderRequest`), its status list, and its quota block-list are all
  module-local, and the package `exports` map has no `./utils/*` subpath. Root-exported and usable:
  `isContextOverflow(message, contextWindow)`, `isRecoverableLength(message, desiredMaxOutput)`,
  `isRetryableAssistantError(message)`, `retryAssistantCall(produce, policy, signal, callbacks)`. Naming the
  *cause* beyond those three is ours, which is why `failure.ts` restates the quota and auth wording and pins it
  in tests.
- `ModelRegistry.complete()` does not traverse `sdk.js`'s stream wrapper, so it inherits none of that layer's
  `timeoutMs`, `maxRetries`, or attribution headers. Consequence worth acting on: **our summarization requests
  have no client-side deadline at all**, so a stalled endpoint can hold a compaction open indefinitely.

## Summary and details contract

`summary` = model text + `buildSupplementarySections()` (`## Verbatim Recent Requests`, `## Tool Ledger`,
`## Delegated Runs`, `## Dropped Context`, all computed by `analyzeSpan` rather than recalled) + pi's
`<read-files>`/`<modified-files>` tail. The model is told to write pi's section skeleton **only** and to skip
the harness-owned ones, so `CompactionSummaryMessageComponent` and the `/agents` transcript keep rendering.

`details` = `{ version: 1, route, provider, model, readFiles, modifiedFiles, summarizedMessages,
droppedBlocks }`. `route` is `"two-stage" | "native" | "serialized"` (renamed from `strategy` when stages
arrived; core reads only the two file-list keys, which **must keep pi's names** or cumulative file tracking
breaks silently). `tokensBefore` passes through from `preparation` (it sizes the whole live context, so a moved
cut does not invalidate it), while `firstKeptEntryId` is **ours to move** — core honors whatever the result
returns (`agent-session.js:1412-1418`), and `cut.ts` only ever moves it earlier, which keeps that tail at least as
long as core intended. So core's default ~20k-token native tail is a floor here, not a fixed choice.

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

**Read it with `npm run compaction-report`** (`scripts/compaction-report.ts`, run under `node --import tsx` so it can share the record log), never by hand-rolling jq joins
again: it groups records by run id and prints the prefix verdict, one line per stage attempt with its request
numbers and `in/cached/out`, the persisted summary's size and cut point, then ROUTES / ATTEMPT FAILURES /
SUSPECTS / PREFIX DIVERGENCES / COST AND CACHE / COMPRESSION aggregates. `--dump[=native|serialized|final|all]`
prints stage text **verbatim** (the report body only previews it, because a checkpoint is markdown);
`--suspect`, `--grep <text>`, `--session <prefix>`, `--route`, `--reason`, `--since`, `--runs 0` (all) and
`--json` cover the rest. Its SUSPECTS flags encode the failure modes below as thresholds —
`prefix-unusable`, `span-not-truncated`, `cut-not-found`, `degenerate-native-output`, `degenerate-final-summary`,
`reduce-inflated`, `cache-read-zero`, `blocks-dropped`, `summary-truncated`, `fell-back`, `estimate-skew` — with prose in
[docs/compaction-trace-report.md](../../../docs/compaction-trace-report.md). It reads rotated `.1` siblings and
tolerates fields absent in records from older builds, because the file accumulates across checkout.

- `attempt` — per stage: `accepted`/`rejected`/`skipped`, detail, `usage` incl. **`cacheRead`** (the only way
  to tell whether the rebuilt prefix was served from cache), **`stopReason`** whenever a reply arrived (the only
  way to tell a truncated summary from a brief one), estimated tokens **with the method that produced them**
  (`estimateSource`), tool/message counts, stage 1's `copiedEntries`/`skippedEntries`/`cutFound`, stage 2's
  `serializedChars`/`segmentSummaryChars`. A `skipped` attempt has no `stopReason` or `usage`: the request never
  went out.
- `prefix` — the verdict from `chain.ts` against our `onPayload` body: which reference answered, how deep the
  agreement went, and the parameters only one side sent. Two rules survive from the body-to-body era: an extra
  body key is a **parameter**, never a prefix verdict, and an absent reference is **unknown**, never `false`.
  `referenceLeafId`, `referenceSource`, `otherDisagreements` and `firstMismatchDepth` all belong to **one**
  credited reference; `parentRequest` mirrors that same row, and the decode scalars on both sides are compared by
  value into `divergences` (**a verdict names one reference** below).
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
`traceMaxBytes`/`traceGenerations` govern the trace; `chainTraceEnabled` gates the persisted chain rows that share
the same file, separately because they carry no conversation content - so history keeps accumulating while bodies
are off. The verdict itself is still only recorded while `traceEnabled` is on (`COMPACTION_CHAIN_TRACE=0`); `model` is accepted but unused — the seam for the
planned dedicated compaction model, which wants the serialized route since it has no cache prefix to protect.
`retryMaxRetries` (default 2, extra attempts after the first) and `retryBaseDelayMs` (default 1000, doubling)
bound the transient backoff; `0` retries turns resends off entirely. Deliberately below core's agent-retry
settings (3 from 2000ms, so 2s/4s/8s): this stall happens inside a turn the user is waiting on.

**A field is only configurable once `readConfigFile()` reads it.** That function maps keys through validators
into an explicit return object, so a field added to `CompactionConfig`, the interface docs, and the loader still
does nothing unless it is also added there — "unknown fields fall back to defaults" makes the omission silent,
not an error. `retryMaxRetries` was dead for exactly one test run before `test-defaults.json` proved it: the
suite slept a real second on a backoff that was supposed to be off. Add the field to `readConfigFile` in the same
edit, and let a test observe it: `nonNegativeNumberField` keeps a `0`, `positiveNumberField` drops one.

## The request chain: hashes retained, bodies dropped

**`observations: 0` used to mean "this process is young" (reload, `/resume`, restart). Persistence narrowed what
the number can claim: `chainObservations: 0` now means **no readable row for this session survived in the retained
trace file** - which is not the same as "never recorded", because persistence may have been off, the rows may have
rotated out of the window, or the session predates this build. See the `compaction-chain-blindness` memory for the experiment behind it, and the funnel section below
for the three counts that replaced the single one.**

## `cached=0` and a short system prompt: what is explained and what is not

**Read this before theorizing about a system-prompt divergence or an unexpected `obs=0`.** A prompt of
**12,817 chars** is pi's base prompt, and it means the compaction ran **outside an active agent run**; the live
turns of these sessions carry ~24.8k. It costs the cache nothing and it is not a bug in the rebuild. The mechanism,
now that it is settled: pi holds **two** prompt fields — `ctx.getSystemPrompt()` reads `agent.state.systemPrompt`
(`core/agent-session.js:596-598` via `:1923`), while the request path uses `_systemPromptOverride ??
_baseSystemPrompt` (`:286`). The override is set at `:902` and cleared in the `_runAgentPrompt` finally at `:753`,
but `state.systemPrompt` is only written back to base at `:908` (a turn whose handlers returned no override) and
`:1779`, so the accessor and the request path can disagree, and a compaction not inside a run sees base.

Two corollaries, both read off the code rather than inferred from a trace:

- **The base prompt is not a prefix of the override.** All five pi-coder `before_agent_start` handlers insert at the
  same interior anchor `</project_context>`, so the later handler lands *earlier*: base head, `<bash_sandbox>`,
  `<delegated_agents>`, `<todolist_system>`, `<scratchpad_system>`, `<memory_system>`, then pi's base tail
  (`<available_skills>` + the cwd line). Only the head up to the anchor and the tail survive, so "re-send base plus
  our blocks" cannot reproduce a live turn's bytes — and `buildSystemPrompt` is not exported, so base is not
  re-derivable from what we hold. Do not propose reconstructing the prompt on the strength of a size delta.
- The scratchpad path inside `<scratchpad_system>`/`<todolist_system>` is **session**-stable, not per-load
  (`restoreOrCreateScratchpad` replays the `pi-coder:scratchpad` entry), so it is not a cross-restart cache problem
  either.

**Do not claim memory edits break the cache mid-session. That was measured false on 2026-09-05.** The memory
index is deliberately frozen: `session_start` restores it from the `pi-memory:memory-index` custom entry in the
session file instead of rescanning the directory (`src/modules/memory/index.ts:150-177`), and this session's file
holds exactly **one** such entry, written at 09:22:40 with 14 project + 6 user memories - which is why the index
in the live system prompt does not list `compaction.md` even though the file exists. Adding, editing, or
deleting a memory therefore changes the prompt for the *next new session*, not for this one, and not on
`/reload` or `/resume`.

What is still unexplained is a genuine prompt jump seen in the same trace. `prefix.ourRequest.systemChars` for
our own stage-1 rebuilds:

| session | time | systemChars | messages |
| ------- | ---- | ----------- | -------- |
| 01a0714f | 14:06 | 12817 | 65 |
| 01a0714f | 14:32 | 24619 | 65 |
| 01a070e0 | 15:27 | 12817 | 559 |
| 01a070e0 | 19:42 | 24813 | 363 |

Two unrelated sessions each grew by a near-identical block (+11,802 and +11,996), while `toolsHash` and the
frozen memory index stayed put. **Resolved: nothing was duplicated.** 12,817 is the base prompt - pi's own
instructions plus project context plus the frozen memory appendix, which is why it was byte-identical across two
different sessions - and the ~24.7k values are that plus the blocks `before_agent_start` installs, which vary by
session (`<delegated_agents>`, `<todolist_system>`, `<scratchpad_system>`, `<bash_sandbox>` and the per-session
scratchpad path), which is why they differ from each other by a few hundred chars. So the short prompt is what
`ctx.getSystemPrompt()` returns **before the first turn of a process**, and the pairing is exact: `obs=0` and a
short prompt occurred together in all five records because both are the first-request state, not because one
caused the other.

What makes that a certainty rather than a guess: `reference: "none"` is only reachable when the chain holds
nothing on the current branch, so the alternative reading - a full chain whose entries were all filtered out by a
system-prompt shape mismatch - was excluded from the stored fields. The report now prints and checks that
distinction (`chain=held/branch/comparable`, and an `INVARIANTS` section) instead of leaving it to be derived from
`chain.ts`.

Why the trace could not see it: `ourRequest.systemHash` **used to** hash a 320-char excerpt (`EXCERPT_CHARS`) with
FNV-1a-32, so `6e84662c` was reported unchanged across 12817, 24619, 24813 and 25294 chars. It now hashes the
whole system text, the same quantity `requestShape()` hashes, so a recorded hash can be joined to a retained
shape without translation. `hashes the whole system prompt, not the printed window` in
`test/modules/compaction/prefix-diff.test.ts` pins both halves, including that the summary and the shape agree.
Records written before that change cannot support any conclusion of the form "the system prompt did not change".

**The short prompt does not break the cache, and this was worth being wrong about.** The reasoning that said
otherwise - "the system prompt is the front of the cache key, so a 12 KB difference at byte zero costs the reuse"
- forgot that the same state that produces the short prompt is a process that has sent **no request yet**. There
is no cached prefix to invalidate. So `cached=0` on the 15:27 run is the expected reading of a cold process, not
evidence about the endpoint, and the only cost of the short prompt is that the summarizer is missing extension
blocks it would normally see - 12 KB cheaper, and no reason to reconstruct anything.

That leaves **19:42 as the one clean hosted data point**, and it is the answer to the question that started this
work: 97 parent requests observed in that process, our rebuilt stage-1 prefix verified identical to the provider's
own for all 362 comparable messages, `prompt_cache_key` and `prompt_cache_retention` on the wire - and
`cached=0` across 222,167 fresh tokens. Either that endpoint does not reuse prompt cache or it does not report
the reuse; both are outside our control, and only a provider that reports differently can tell them apart. The
local llama.cpp endpoint does report reuse, which is what makes the silence look like a reporting gap rather than
a caching one.

**Updated 2026-09-06: that endpoint does report reuse, so "does not report" is off the table.** A later hosted run
(10:23, same session) returned `cached=4096` on 26.6k fresh tokens. The question narrowed from "does it cache or
does it report" to "it reports a hit at 30 KB and nothing at 330 KB" - a size or window threshold, not a silent
endpoint. Read a hosted `cache-read-zero` as that question, never as proof about our own prefix.

### A verified long prefix with `cached=0`: reuse is not ours to give (2026-09-06)

The 10:16:21 run on session `01a070e0` printed `usable=true verified=649/649 obs=300 first=verified truncated`,
and the run reported `cached=0` against 347k fresh tokens. That combination settles a question the earlier notes kept reopening: our body was
a byte-identical prefix of **300** requests this route had already served, with no divergence anywhere in the
overlap, and the server still read it cold. Nothing about the rebuild - not its length, not its shape, not which
parts we drop - can account for that, so stop looking for a body-shape cause of low reuse on a local llama.cpp
route. The two candidates left are both server-side: per-slot prefix-cache eviction between turns (a 200k+ context
is easy to preempt, and the turns here are minutes apart), and the 4096-token quantization that makes "almost
nothing reused" print as exactly `4096`/`7168`. Same build, same day, a 52k session got `reuse=82-89%`, which is
consistent with size-driven eviction rather than anything in our request.

There is **no tool-call pruning in `native-request.ts`** - it never looks at `toolCall` parts. A claim that
pruning was shortening the reusable prefix circulated in conversation on 2026-09-06 and is false; if some future
version does prune calls, the above is the measurement that will say whether it costs anything.

One datum that the pairing rule above does not yet cover: the 14:20:29 run on this same session reported
`sys=12817c` with `parent-sys=12817c` and a chain holding 374 rows, minutes after the 11:31 run reported 24813.
"Short prompt means a process that has sent no request yet" fits a cold process, not a live 236k session whose
recent requests also carry the short prompt. Check whether a manual `/compact` resolves the prompt outside an
active agent run before treating either reading as settled.

### The instrument names the gate now, not the conjunction

`obs=0` was ambiguous between "nothing on the branch" and "the shape filter rejected everything on it", and the
suspect asserted *both* halves - on the 10:23 run, where `toolsHash` was identical across three processes and only
the prompt moved, that pointed at a tool-set change that never happened. `compareObservation` knows which predicate
fired and reports only a comparison, so `prefixVerdict` now counts rejections per gate (`rejectSystemHash` /
`rejectToolsHash`, non-exclusive, printed beside the funnel) and every sentence that used to presume derives from
those counts: the run line shows `rej=4sys/0tools`, `chain-incomparable` prints the counts, and
`prefix-uncomparable` stays silent when the shape gate emptied the funnel because that cause is already named - two
flags for one fact is how a reader debugs the wrong one. `incomparable-without-rejection` is the invariant for the
state `compareObservation` cannot produce: an emptied funnel neither counter accounts for. Records predating the
counters print "(record predates the rejection counters)" rather than having a cause inferred for them, which is
what the live 10:23 record still prints.

## The prefix funnel, and unknowns the record states itself

One quantity, three names, because each zero has a different cause and the old single `observations: 0` could not
tell them apart:

- `chainObservations` - entries held, unfiltered, including rows restored from disk (a floor: the scan stops once it holds a ladder and enough requests, and `unknowns[]` says when it did).
- `branchObservations` - entries whose recorded leaf sits on the current branch.
- `observations` - entries that additionally share our system prompt and tool set (`ChainMatch.compared`).

`parentRequest` mirrors `ourRequest` with the newest on-branch entry's shape (model, `systemChars`, `systemHash`,
`toolsHash`, depth, leaf id) whether or not it was comparable, so a prompt or tool-set difference between our
rebuild and pi's live requests is a field comparison instead of an argument. `unknowns[]` states what the record
cannot answer, and the report prints those as `~ cannot tell:` lines apart from flags: a flag describes the run, an
unknown describes the instrument. `scripts/compaction-report.ts` adds four suspects from the funnel
(`chain-empty`, `chain-off-branch`, `chain-incomparable`, `system-prompt-drift`) and an `INVARIANTS` section of
cross-field checks - `reference=none` with entries on the branch, an empty chain reporting branch entries, a
usable verdict with no comparable depth, matching hashes over differently sized prompts, comparable observations
with none on the branch. A violation there means the trace is lying, and it must be believed before any cache
conclusion is.

Naming rule for future fields: the trace record and `pi_coder_debug` must use the **same key** for the same
quantity, or the ambiguity this pass removed comes back through a second surface. See
`docs/pi-coder-debug-tool.md`.

Every trace record and every persisted chain row carries `instance` - a random id for one extension load, from
`PROCESS_INSTANCE` in `src/common/trace.ts`. Sessions outlive reloads, and two loads can leave rows in one file
whose chains, config, and handlers were never the same; without the field, joining a live answer to a recorded one
is guesswork. The report names the newest load and how many older ones contributed.

## Trace field gotchas

- `ourRequest.systemHash` hashes the **whole** system text as of the funnel pass, matching `requestShape()`, so
  equal hashes do mean equal prompts. Records written before that change hashed only a 320-char excerpt
  (`EXCERPT_CHARS`) and cannot be re-read as evidence that a prompt was stable - `6e84662c` was reported
  unchanged across 12817, 24619, 24813 and 25294 chars. The ladder heads that `verified=N/M` rests on are
  sha256 over messages and never had this weakness.
- `prefix.parameters` should be **empty** on a healthy run: we no longer add a key pi's turn requests lack
  (`tool_choice`, dropped) and no longer omit one they carry (`reasoning_effort` and `enable_thinking`,
  forwarded). Anything left in it is a real difference to explain; a `-key` means the parent sent something our
  rebuild dropped. If `+tool_choice` reappears, someone re-added the option for portability - read the comment at
  its old call site first. A `-top_p`, `-min_p` or `-chat_template_kwargs` is a model with configured sampling
  parameters whose merge went missing again (see **the model's own sampling parameters are merged**).
- `prefixUsable` is `undefined` in older records rather than absent; read `reference` first - `none` means no
  ladder covered the branch and the numeric depths are `-1` placeholders, not measurements.

`chain.ts` replaced the parent-body capture. `index.ts` keeps `WeakMap<sessionManager, RequestChain>`, and
`before_provider_request` calls `observeParentRequest()`, which folds a cumulative head over
`body.messages` and then **drops the body**:

```
head(0) = sha256("pi-coder/compaction-chain/v1")
head(k) = sha256(head(k-1) + 0x1f + JSON.stringify(messages[k-1]))   truncated to 16 hex
```

One observation per provider request: `{leafId, depth, head, systemHash, toolsHash, systemChars, keys,
model, toolNames?}` — `toolNames` only when the shape changed — plus the **whole ladder** for the newest two
requests (`LADDER_RETENTION`). The retention is not an optimization: a truncated span is shallower than every
request pi made in a resumed process, and the first llama.cpp run after this shipped had ten observations at
depths 70-87 against a 64-message span, so nothing was comparable and the code called that `usable: false`.
Only per-request records can localize a mismatch; only a ladder can say anything at all about a short span. About seventy bytes where a body was one to two
megabytes, so the cap is a memory bound rather than a correctness one (`MAX_OBSERVATIONS = 2000`, ~140 KB),
and dropping the oldest only costs resolution on depths compaction passed long ago.

**Persisted, so those numbers describe the session rather than the process** (`src/modules/compaction/chain-store.ts`).
Every request appends a `chain_request` row to the trace file, and a `chain_ladder` row lands when depth has grown
by `LADDER_DEPTH_GROWTH` (32) or as soon as the shape changes. Hydration runs once per chain at creation,
reading segments newest-first and stopping at the first whose `mtime` predates the session's first entry; rows
already held are skipped, which is what keeps a second chain over the same session id from counting requests
twice. Two consequences: `MAX_OBSERVATIONS` is now also the *restore* window, and `LADDER_RETENTION = 2` does
**not** need raising for long sessions - ladders are cumulative and nested, so one retained ladder at depth N
already carries a head at every depth ≤ N, and the second slot exists for shape churn rather than length. A row
caps at `MAX_LADDER_HEADS = 4000` depths. Raise the retention only if a live trace shows `chain=N/N/0` (branch
entries, none comparable) with shapes alternating.

Four consequences, each learned from a real trace:

- **Branch-correct by construction.** `match()` filters observations to leaf ids on `getBranch()`, so a request
  captured on a branch that was navigated away from cannot be chosen as a reference.
- **The span ladder excludes our appended instruction.** `prefixVerdict` folds `messages.slice(0, -1)`, because
  `buildNativeContext` adds exactly one message no reference ever sent. Folding it would guarantee a mismatch at
  our own last depth. That is the same trap the body-to-body diff hit: its `div=messages[42] (assistant),
  rewind` record — which I first explained as a stale-branch artifact — was our instruction sitting where pi had
  a real assistant message, and the collapse rule that should have forgiven it required exactly one divergence
  while the non-content `rewind` label made it two. Corrected here so the wrong story does not outlive the code.
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
exists. `parameters[]` survives as a set difference over body keys, which keeps the "an extra body key is a
parameter, not a verdict" lesson expressible without retaining a body.

## A rebuilt Context is not byte-stable (pi stamps `Date.now()`)

`buildSpanSession()` re-appends each entry into an in-memory `SessionManager`, and pi gives a `custom_message`
entry a fresh timestamp as it goes. Replaying the same session file twice produced message `timestamp` values
1.5 seconds apart, which varied every downstream cumulative hash. Not a live cache bug, for two independent
reasons: provider adapters do not serialize `timestamp`, and `prefixVerdict()` folds `requestMessages(payload)`
— the **body** pi-ai built — rather than the `Context` objects, so the chain compares wire shapes on both
sides. That asymmetry is why `verified=19/19` was meaningful and is worth preserving if this is ever refactored.

It is still a latent hazard: any adapter that forwarded unknown fields would turn it into a real prefix break at
that message. So hash a `{ role, content }` projection when a golden value must be stable — see
`requestShaped()` in the session fixture test — and do not assume the system prompt is the time-varying part:
`core/system-prompt.js` contains no date.

## Live fixtures

`test/fixtures/session/hosted-three-folds.jsonl` + `test/fixtures/compaction-trace.hosted-three-folds.jsonl` are
the **first multi-fold pair**, recorded 2026-09-06 from one live hosted session (309 rows, 3 folds at rows 128/137/294)
whose runs the counting build itself produced (123 records: 4 runs, 102 chain rows). Provider and model strings stay
raw - the file is read, never replayed, so no test depends on a machine's provider config. `fold-chain.test.ts`
reproduces the recorded `estimateSource`, `staleAnchors`, and `cutMoved` fields **from the session file alone**, so
the two artifacts vouch for each other the way the llama.cpp pair does. What it uniquely proves:

- **The fold guard earned its keep on real data.** Fold 2 had three counted replies land after fold 1 - so "a live
  count exists" was true - but all three sat **below** the boundary in the retained tail, so the span above it held
  only pre-fold counts. Anchoring on the nearest one sizes a 14,830-token request as 55,874 (**+277%**), which is
  the direction that reads as a provider clip inside a 15% band and, on a small window, skips stage 1 outright.
  Scope lesson: the session is the wrong question, the span is the right one.
- **`exact-cut` on a second provider.** Two of the three folds sized the request within **0.08%** of what the
  hosted endpoint charged (`49,717` vs `49,679`; `54,798` vs `54,748`) - every prior number in this file came from
  llama.cpp. Run 1 also served 49.2k of 49.7k from cache on a hosted route (`reuse=87%`).
- **`stale=` coexists with success.** Fold 3 rejected 22 expired counts and still produced an exact number,
  because the boundary row was itself post-fold. The field counts rejections, never trouble.
- **No live `cutMoved` yet.** All three folds used core's boundary, so the repair path is unit- and mutation-tested
  but unexercised in the wild; forcing one needs a small-window route (the local 200k model), not the 1M hosted one.
- **`first=messages[2]` was a real defect, and I had written it off.** This file called it a standing false alarm
  on second-and-later folds; that reading was wrong. The body sample added to the chain named it in the first
  session that diverged (`at messages[2] ours=user/4902c/e8332c11 pi=user/13368c/f7830572`): same role, present on
  both sides, different index. A flag you cannot explain is not a false alarm - see **Stage 1's span window**.

## Stage 1's span window (2026-09-06, `stageOneSpanEntries`)

pi's resolved context (`buildContextEntries`, `session-manager.js:198`) hoists the **newest** `compaction` entry to
the front and lets any older summary inside the kept range ride along **at its file position**. That order is
neither file order nor newest-first, and the hoist is **not idempotent**: hand it back its own output and the
*last* compaction entry in the list - the older one - takes the front slot.

Stage 1 built its body through exactly that trap. `spanMessages` sliced pi's **resolved** list at the cut and
copied it into a fresh in-memory session, so the hoist ran a second time and the older summary jumped to index 0.
With one summary in range (fold 2) hoisting is a no-op, which is why folds 1 and 2 looked clean; with two (fold 3
onward) the request stops being a prefix of the cached prompt at precisely its second message. Measured cost on the
run that caught it: `in=41.8k cached=7168` - 83% of a 40k-token stage-1 prompt re-read fresh, every fold.

The fix is to stop feeding an already-hoisted list to a non-idempotent builder. `stageOneSpanEntries(branch,
firstKeptEntryId)` takes the **file-order window** core itself walks - `previousFoldWindowStart` is the newest
fold's `firstKeptEntryId`, mirroring `prepareCompaction`'s `boundaryStart` - up to the cut, so the hoist runs once
on chronological input and reproduces pi's order, and entries older than the last fold, which no provider ever
cached, leave the span. Two things that look like bugs and are not: the wire format drops `timestamp`, so the fresh
stamps `appendCompaction` mints are inert for cache alignment (`requestShaped` in the fixture test says so), and
`keptEntry` still comes from the resolved-or-branch list, because only that answers whether the boundary's count
survives into the cached prefix.

`test/modules/compaction/session-fixture.test.ts` pins this on `hosted-three-folds.jsonl`, whose fold-3 window
holds two summaries, and carries a counterfactual: the same entries taken from the resolved view must **not**
align. Order, not membership, is the invariant, so the assertions compare message identity at each position - the
front slot holds *a* summary either way, which is why index alone proves nothing.

`test/fixtures/session/llamacpp-post-compaction.jsonl` is pi's own output: a 51-entry branch carrying a
`compaction` at its tip (`firstKeptEntryId: 3162e48e`), with the `custom_message`, `model_change`, and
`thinking_level_change` entries no hand-built branch in this suite has.
`test/modules/compaction/session-fixture.test.ts` replays that tree through the span builder and pins what the
live run recorded in the trace beside it (28 entries copied, 17 messages, nothing skipped - and the replay's
`messageCount`/`copiedEntries` must equal the captured `attempt`'s), so the two fixtures vouch for each other and
a change to slicing, copying, or message conversion trips the golden head hash `2d54d1ca019d4841`. Slice the
branch with `getBranch()`, never `buildContextEntries()`: the latter answers with pi's post-compaction view,
which has already folded that history into a summary.

`test/fixtures/compaction-trace.healthy.jsonl` — one real llama.cpp run, **captured raw** (re-recorded
2026-09-06 from a fresh session on the credited-reference build): 20 records, one run's `prefix`/`attempt`×2/
`model_response`×2/`final_summary`/`outcome` plus 13 persisted chain rows, real `cwd`, real session id, real
provider name normalized to `llamacpp` (the alias one machine's provider config uses is not a fact about pi's
shape), and the two stage texts. The earlier fixture was a sanitized five-record extract with synthetic text; the raw capture replaced it
because the chain rows and decode scalars are now part of what a healthy run must show, and because rebuilding
stage text from records is behaviour worth pinning. Used by `test/scripts/compaction-report.test.ts` for "what
healthy looks like": `usable=true`, `verifiedTo=18` at `comparableDepth=18` against `referenceDepth=31`,
`parameters: []` — no key added, none dropped — **zero flags**, `referenceSource: observation`,
`otherDisagreements: 0`, and `chainRows` counted outside the run total.

Two lessons it still encodes: keep `--json` field names equal to the record's own names, and never let a flag fire
because a record was **absent** — that is what a rotated or trimmed log looks like, not an empty model answer. The
second no longer lives in this fixture (it now contains every record type); it is carried by the synthetic cases
at "separates an absent reference from an unusable one" and the old-build tolerance test.

## Requests are sized from the session's own counts (2026-09-06)

Every assistant entry carries the `usage` of the request that produced it — `input`, `output`, `cacheRead`,
`cacheWrite`, `totalTokens` — and that request covered the **system prompt, the tool definitions and every message
before it**. So the newest usable usage inside a span is an exact token count for a prefix of the body stage 1 is
about to rebuild, and the system prompt needs no separate term because it is already inside that number. Only two
things still require guessing: the entries after the anchor, and the instruction no reference ever sent. That is
`estimateAnchoredSpanTokens` in `native-request.ts`, recorded as `estimatedTokens` with
`estimateSource: "usage-anchor"` beside it.

Measured against a recorded child session's own provider counts (14 turns): whole-body chars/4 ran **+39.6% mean
error, +93% worst**; anchored ran **+2.0%**. That spread is why the report keeps two bands — 15% for an anchored
estimate, 50% for the heuristic — and prints `src=anchor` / `src=chars4` / `src=unrecorded`, so a number never
arrives without the accuracy it can support. One threshold for both would either bury the anchor or cry wolf on
the heuristic. **Read the correction below before quoting those four numbers again: most of the +39.6% was an
artifact of charging stored rows, and there is now a tier above this one.**

Three rules worth knowing before "fixing" this:

- **An `aborted` or `error` reply, or an all-zero `usage`, is not an anchor.** It is not a measurement of a
  context that still exists, so the walk keeps going backwards rather than believing the newest big number.
- **`ctx.getContextUsage().tokens` is a hybrid, not the provider's count.** It is
  `estimateContextTokens(messages)` — last assistant usage *plus* chars/4 for everything after it
  (`compaction.js:148-153`), with images counted at 4800 chars each — and it returns `tokens: null` when the
  newest compaction has no assistant reply after it (`agent-session.js:2556-2574`). Treat `rep=` as a ceiling for
  the whole live context, never as the size of a request.
- **Anchoring cannot help stage 2**, and this is not an oversight: stage 2 sends a text blob we serialize
  ourselves, so no historical usage describes it. `packWithinBudget` therefore still decides which transcript
  blocks survive on a chars/4 estimate — the reason gap 7's budget should come from the window rather than from a
  number this crude.
- **The anchor over-counts when it predates a fold — and that is now refused, not tolerated.** An assistant kept
  from an older round carries a count of the context *before* a later compaction folded material away, so its
  number exceeds what this span holds by the whole reclaim. The old text called that "rare" and "conservative";
  both words were doing work they could not pay for — rare is not never, and "conservative" here means the gate
  loses stage 1, which is the harm. `countBoundary` (branch timestamps, because `buildContextEntries` reorders
  and can drop rows) rejects such counts in both tiers and reports them as `staleAnchors`.

## The counts, measured against a real session (2026-09-06, later the same day)

`test/modules/compaction/real-session-sizing.test.ts` now checks sizing against provider numbers instead of
against our own arithmetic. `llamacpp-post-compaction.jsonl` carries 12 counted assistant turns, each an exact
measurement of a body this module can rebuild, so a sizing change can fail against a tokenizer.

- **The heuristic's documented error was mostly an artifact, and the +40%/+2% comparison must not be quoted
  again as it stood.** `estimateEntryTokens` and `estimateRequestTokens` charged
  `JSON.stringify(storedMessage)` — which for a `toolResult` includes **`details`**, and pi keeps a truncated
  `read`'s full output a *second* time under `details.truncation.content` (fixture entry `49f16eaf`: 51,134c of
  content plus 52,318c of details). No provider receives it: `openai-completions.js:998-1015` sends
  `{role:"tool", content, tool_call_id}`. Measured on one tail: provider 13,289t, stored 26,294t (**+98%**),
  `{role, content}` 13,237t (**-0.4%**). Over the live span the same heuristic went **+42.2% → -0.3%** by
  projection alone (and the live record it reproduces says `est=46987` vs `in+cached=32782`). So the counts
  still outrank chars/4 because they are measurements, not because the guess was 40% blind. pi's own
  `estimateTokens` (`compaction.js:188-227`) walks content **by role** and never charged `details`, so `rep=` was
  never inflated — which makes **`est > rep` on one run a free tripwire** that the stored-row bug is back.
- **Anchored sizing measured within ±1.1% on 11 real turns** (mean -0.2%) once the tail is charged as wire; the
  recorded span is 32.5k against the provider's 32,308.
- **The exact-cut tier is the common case, not the lucky one.** `firstKeptEntryId` names the *kept* entry, so when
  that entry is an assistant with usable usage, its prompt **is** the span: no estimation at all (fixture:
  32,308, asserted as equality). Measured 3 of 3 real compactions in `.state/agent-sessions/**` cut on an
  assistant with usable usage, for a structural reason: `findCutPoint` snaps forward to the first *valid* cut
  point at or after the entry that crossed the keep budget, and a `toolResult` is not valid
  (`compaction.js:227-240`) — so a mid-turn crossing lands on the assistant that consumed it. `skippedEntries > 0`
  disqualifies the tier, because a row stage 1 could not append makes our span smaller than the body counted.
- **Retracted the same day:** the claim that pi's `keepRecentTokens` is a floor that can only overshoot. The
  forward snap can leave the retained tail **under** budget when the crossing entry is itself a huge `toolResult`
  swept into the summary. (This fixture did not hit it: live 53,771 − span 32,308 = tail 21,463.)
- **Report bands are now three:** 5% `exact-cut` (a disagreement there means the request is *not* the body that
  count describes — check `skippedEnt` and for a fold or model change inside the span), 15% `usage-anchor`, 50%
  `chars4`. `src=` gained a fourth print state (`exact`) and `stale=` prints only when non-zero.

- **A cut's validity is about ids, not roles — found by fuzzing, not by reading pi.** Three shapes, and pi
  forbids only one: a tail starting with a `toolResult` orphans the call that went into the summary, a tail
  starting after a metadata row is fine (the *next* context row's call may sit before the cut, and a provider
  rejects the request outright rather than degrading), and pi's `findCutPoint` ends by walking the cut index
  **backwards** over "adjacent metadata entries that do not affect context" (`compaction.js:339-348`), so
  `firstKeptEntryId` can legitimately name a row that produces no message at all - while pi's
  `CompactionEntry`/`BranchSummaryEntry` carry an optional `usage` of their own. Any sizing tier that asked "is
  there a count here" instead of "is this an assistant reply" would report a branch summary's cost as the size of
  a body it never measured. `cut-invariants.test.ts` pins all three, including a `[call][user][result]` ordering
  (a tool finishing after the user spoke) where pi's own rule *accepts* the cut and the surviving result cites a
  call id no provider has ever seen. So an admissibility predicate has to resolve ids and entry types; "pi would
  never produce it" is not a proof.
- **(b) and (e) are indistinguishable to pi and must not be conflated by us.** `[assistant][result] | [assistant]`
  and `[user] | [assistant]` both land on an assistant row with `isSplitTurn` set (`compaction.js:345-350`), both
  resolve every id, both give an exact count - and the first swallows a tool cycle whose answer survives while the
  second swallows *the prompt whose answer survives*. Recorded because a future rule stated as "cut at an
  assistant row" admits both silently.

### Built: choosing our own cut point (`cut.ts`)

The repair path is implemented; what follows is what it is *not*, because that is what a later session will
otherwise re-derive.

`chooseSpanCut` runs before the transcript is built, with core's boundary as its **ceiling**: it uses core's
choice whenever that choice is admissible and fits, and only walks **earlier** when it does not. Six conditions,
each with its own rejection tally so a run that could not be repaired says why:
resolvable → countable → not-expired-by-boundary → no-orphaned-tool-call → `tail ≥ keepRecentTokens` →
`span + outputBudget < window`. It also refuses to move at all when `liveTokens` is null, which is the same
post-fold window where the counts are unavailable — moving a boundary while unable to evaluate the keep budget is
how a repair becomes a regression.

- **Measurement and admissibility are separate predicates.** `measureSpanAt` answers "what is this span's size, by
  a count" (an assistant at the cut reads its `prompt`; a user turn at the reads the reply above it via
  `totalTokens`; anything else is not countable), and `orphanedByPosition` answers "does the tail resolve" — one
  backward pass maintaining the earliest call index among results below each position, because both conditions are
  monotone in the earlier direction and that is the whole termination argument. Cutting *at* a tool result is
  countable and inadmissible; conflating the two is how a size check would be trusted to catch a malformed request.
- **Only earlier is what keeps the blast radius zero.** The tail grows, so `keepRecentTokens` holds by
  construction, and core's `messagesToSummarize` stays a **superset** of what is actually dropped — so the file
  ledger, `previousSummary`, and the split-turn wording remain sound without being recomputed. The cost of the
  superset is duplication (stage 2's transcript can include rows that survive verbatim in the tail), absorbed by
  the merge-don't-concatenate rule. A *later* cut inverts that and is the deferred case.
- **`tokensBefore` is deliberately left as core's.** It is `estimateContextTokens(buildSessionContext(...))` — the
  whole live context, not "tokens before the cut", despite the name — so a moved boundary does not invalidate it.
  Re-deriving it from the new span would understate the session.
- **Two source rows are consulted, in order.** `buildContextEntries()` is sliced for the cut point's *id*, but
  after a fold the old rows disappear from the resolved view; `getBranch()` is consulted for a boundary that only
  exists there. `spanMessages` prefers the resolved view and falls back to the branch when the chosen id is not
  context-visible.
- **Trace and report**: `chosenFirstKeptEntryId` + `proposedFirstKeptEntryId` on the stage-1 attempt, printed as
  `cutMoved=no` / `cutMoved=to:<id>` / `cutMoved=unrecorded` — three states, because "the walk abstained" and
  "this record predates the walk" must not read alike.

**Still not built.** The `exact-anchor` *label* exists; `src=exact` and `src=exact-anchor` both get the 5% band.
What remains deferred, on purpose: (a) a **later** cut, which would force owning the summarized set and
`computeFileLists(preparation.fileOps)`; (b) the stored-count **rescue** — `details` on the `compaction` entry
could carry `spanTokens`/`summaryTokens` so a stale count becomes correctable by
`prompt_X − Σ(spanTokens_F − summaryTokens_F)` (uniform, since any row still in the body survived every fold that
dropped rows before it), rather than merely rejected as it is today; forward-only, since old entries and
`core-default` folds lack the fields.

### The budgets behind the fit test, and one post-condition still missing

`keepRecentTokens` (default 20,000) drives the retained tail, and so drives the cut. `reserveTokens` (default
16,384) drives the trigger line **only**: it used to set the output budget as well
(`floor(0.8 x reserve) = 13,107` for stage 2, `/3 = 4,369` for stage 1, which did match the fixtures' live
`maxTokens`), and that anchoring was the defect - a number about the agent's turn headroom was silently capping
what a summarizer may answer with. The earlier idea of using `max(keepRecentTokens, reserveTokens)` for the cut
stays dropped: it would rewrite the user's tail intent whenever they set a high reserve.

What the budget is now (`summarizationBudgetTokens` in `index.ts`, exported, pinned by
`test/modules/compaction/budget.test.ts` plus handler cases):

- **One number, both stages:** `max(1024, min(model.maxTokens, window - requestTokens - 1024))`, where
  `requestTokens` is the **whole request as the fit gate charges it** - system prompt, tool schemas, span, appended
  instruction. Against `~/.pi/agent/models-store.json`, `qwen3.8-flash` reports `maxTokens: 65,536`, so the cap went
  from a constant 13,107 (4,369 for stage 1) to the model's own ceiling.
- **A cap must never bind**, because a truncated checkpoint is discarded whole: recorded replies were 2,821t for 9
  events and 2,313t for the reduce, and the cap was never the reason the model stopped. The rival-draft property the
  old `1/3` protected (stage 2 once wrote *longer* than the 3,207-token checkpoint handed to it) is carried by the
  instruction ("must be no longer than the checkpoint you were given") and the report's checkpoint/summary ratio.
  Rationing the fatal direction was the bug; verbosity is only a cost.
- **Why the subtracted term is the request and not the span:** the fixed prefix is large - the recorded system
  prompt alone is 25,694 characters, plus six tool schemas - so `window - span - instruction` overstates the room by
  thousands of tokens. A `* 0.9` multiplier briefly hid that; it was a haircut on the wrong quantity (2k on a tight
  window, 94k on a million-token one) and is gone.
- **`marginTokens` is an optional parameter** (default `SUMMARIZATION_MARGIN_TOKENS`) so a test can state the
  margin its case assumes instead of hardcoding the shipped number - `budget.test.ts` passes 0, 1,500 and 2,000 to
  pin the formula and the gate's falsifiability. Hardcoded margins in tests hid a real gap: with the parameter
  ignored, five tests fail now, but when the value was only ever compared against a copied literal the same mutant
  passed silently. Don't reintroduce the literals.
- **The margin is a constant, and the `max(0, ...)` is deliberately unfloored.** The gate is
  `needed < window - output`; at `budget == window - request` it reduces to `needed < needed` and refuses every run,
  so some margin must stay. 1,024 is sized to the error in the number subtracted (~1% on a provider count, worse on
  chars/4), which does not scale with the window. Floors belong on the *request* (`MIN_OUTPUT_TOKENS`, applied by the
  caller): a floored budget grants room the window lacks, and the gate charges it back.
- **Three limits were built, tested, and deleted here**, all caught by mutation testing rather than by reading: a
  `Math.min(need, budget)` clamp a preceding refusal made unreachable; a per-event `2,600 + 60 x messageCount` cap
  plus the `CHECKPOINT_MIN_USEFUL_TOKENS` floor that existed to repair it; and the `* 0.9`. Any future stage-1-
  specific number needs a test that fails when it is deleted *and* one that fails when it binds.
- `reserveTokens` is out of the budget path entirely, which **reverses this file's earlier ruling** that it "feeds
  the trigger line and the output budget". It drives the trigger line only. `keepRecentTokens` (20,000) still drives
  the retained tail and so the cut, and `window - span >= tail >= keep` is why the remainder has a practical floor
  (~20k) without needing a proportional haircut.

Still not implemented, from the same design discussion: the **sanity post-condition** -
`budget + keepRecentTokens + fixedPrefix < window - reserveTokens` (where `budget` is the
`summarizationBudgetTokens` number, no longer a reserve-derived constant), flagged when false. Without it, a
window too small to compact usefully produces a compaction that re-triggers immediately, and the trace shows a
healthy run rather than an impossible configuration. On a 200k window the terms are ~33k against a 184k line, so
this only bites on small windows - which is exactly when it is invisible until it hurts.

## `tool_choice` is not sent (2026-09-06)

Stage 1 used to send `toolChoice: "none"` while keeping the parent's tool definitions, on the theory that the
field is the portable way to forbid calls and the instruction text is the backstop. Dropped, for two reasons that
point the same direction:

- It was the **only** body key our rebuilt request carried that pi's own requests do not, so it was the one thing
  standing between this request and byte-equality with what the provider already cached.
- On a server that recognizes in-band calls by applying a grammar rather than by honoring a parameter, asking for
  no tool calls plausibly switches that parser off - and then the call comes back as **text**.

The second is inference from one run, not a proven mechanism: `01a07567` (2026-09-06 06:30, llama.cpp
`qwen3.8-27b`) accepted stage 1 at `stopReason: stop` with a summary whose last line was a bare </tool_call> - the model's own tool invocation, in the summary that got
accepted and handed to stage 2. Whatever switched the parser off, the shape of the evidence is that we ask
for no tool calls and get one as prose.

Verify on the next stage-1 run: `prefix.parameters` should be empty, and if the model still calls, the
rejection should come back as `attempt.outcome: rejected` with a `stopReason` of `toolUse` rather than a
`stop` carrying prose. If it still arrives as text, that is the residual gap this note describes - and the
one case worth adding a tail-shape detector for.


## Stage 1 forwards the thinking level (2026-09-06)

Omitting it was not neutral, and the reason is the same one that made `tool_choice` worth removing: the cache
entry stage 1 wants was created by pi's **turn** requests, and on the compatible branches pi-ai renders
`enable_thinking = !!options.reasoningEffort` before it maps the level through `model.thinkingLevelMap`. So a
request that never asks gets `enable_thinking: false` and no effort key, while pi's has `true` plus the user's
level - and a server that folds the thinking flag into the templated preamble puts that difference in prefix
territory, where it costs the whole cache read.

`turnThinkingEffort` in `summarize.ts` sends the level under the same two conditions under which pi's turn
request would carry it (the model supports reasoning, and the level is not off), and the caller reads the level
from `pi.getThinkingLevel()` inside a `try/catch`. That guard is for **the build**, not for children: every bound
session answers the getter from its own state, so a delegated child has its own level and stage 1 is matched
against that child's turns, which is what parity means there. The catch covers a method absent on an older
running pi and a handler surface that refuses the call; a presence check would cover only the first. Two details
that are easy to get wrong:

- We call `modelRegistry.complete()`, which takes **API-level** options, so the field is `reasoningEffort`
  holding a *level*. The `reasoning` -> `reasoningEffort` translation lives in `streamSimple`, which we do not
  use - the same reason `toolChoice` reached the wire as `tool_choice` for us.
- Passing `"off"` through is not the same as dropping it: `!!"off"` is truthy, so it would flip `enable_thinking`
  to `true`. Hence the collapse to `undefined`.

Stage 2 does not forward it, on purpose: it has no cached prefix (own system prompt, no tools, `cacheRetention:
"none"`, fresh session id), and thinking tokens come out of the same output budget as the summary - on the one
rung that *keeps* a `length`-truncated answer.

**Instrument lesson:** `prefix.parameters` is a set difference over body **keys**, so it cannot see a value
disagreement. `enable_thinking: true` versus `false` would have read as agreement while the request differed in
the parameter that decides whether the model thinks. Key sets caught this case only because the effort key was
absent; a fix that added `max_completion_tokens: 4369` vs `512` would be invisible. Recording a few scalars
(effort, thinking on/off, max tokens) on both the chain row and `ourRequest` would be content-free and is the
follow-up `cutFound` should be grouped with.

## The model's own sampling parameters are merged (2026-09-06)

pi's turn request goes through `streamSimple` -> `buildBaseOptions`, which sets
`samplingParams: {...model.samplingParams, ...options.samplingParams}`, and `buildParams` finishes with
`Object.assign(params, options.samplingParams)` - **last, so these keys override the named fields**. Our
`modelRegistry.complete()` path never runs `buildBaseOptions`, so anything a user configured on the model
(`top_p`, `top_k`, `min_p`, `repetition_penalty`, `chat_template_kwargs`) reached pi's body and not ours. On
llama.cpp, vLLM and SGLang that is prefix territory, because those land in the chat template; the type doc is
explicit that only the OpenAI-compatible adapters read it, so elsewhere the merge is inert rather than a second
behavior.

`callForSummary` now does the merge, which puts it on **both** rungs: stage 1 for parity, stage 2 because a
configured `repetition_penalty` exists to fix that model's output habits and the summarizer is the same model.
Two consequences worth knowing before someone calls them bugs:

- A configured `max_completion_tokens` overrides our stage budget here, exactly as it overrides pi's turn budget
  there. Parity, not a leak - but it means the cap is a default, not a guarantee.
- Detectable, not silent: the adapter assigns these as keys, so a missing merge shows up as `-top_p` in
  `prefix.parameters`. No live record has ever shown one, which is the evidence that neither local route
  configures sampling parameters today - the fix closes a latent break for other people's configs, not an active
  one for ours.

## A verdict names one reference (2026-09-06)

A live record read `verified=728/728, usable=true` and `firstDivergence: messages[59]` at once, and both were
"true" — because `match()` folded `max(verifiedTo)` and `min(firstMismatchDepth)` across every comparable
reference: every on-branch observation *and* every retained ladder. A stale ladder left from before an earlier
compaction is still on the branch and still the same shape, so it can disagree at 59 while the live prefix agrees
through 728. Two measurements, one label. It also meant the shallowest stale row could pin the printed divergence
for the rest of a session.

Now each reference is compared alone (`compareLadder`, `compareObservation`) and one is credited: deepest
agreement first, then widest coverage, then an observed request over a derived ladder, then newest. The credited
reference supplies `verifiedTo`, `comparableDepth`, `firstMismatchDepth`, `parameters`, `modelDivergence` and the
`parentRequest` mirror; the losers are counted in `disagreeingReferences` rather than dropped. Cumulative heads
give the invariant the report now checks: **inside one reference a mismatch is always deeper than its agreement**,
so `firstMismatchDepth <= verifiedTo` means the instrument merged references again.

An earlier draft of the tie-break preferred a reference with no mismatch, which quietly handed the verdict to the
shallowest row and hid the mismatch that was the point of the run. Coverage wins; clean-ness does not.

**Values, not just key names.** `keys` and `parameters` can only report a body key one side sent, so pi's
`enable_thinking: true` against our `false` printed as agreement. `ChainShape` now carries four content-free
scalars - `maxTokens`, `enableThinking`, `reasoningEffort` (top-level, chat-template kwarg, or Anthropic's
`effort`), and `imageBlocks` - mirrored onto the persisted row, restored as `null` when an older row never
recorded them, and compared by `decodeDivergences` in `index.ts` into `divergences[]`. They are deliberately
**not** part of `shapeKey()`: a thinking toggle or an image count has to stay comparable, because
"these differ in a parameter that moves the prefix" is a diagnosis and "we cannot compare them" is a shrug.
`max_completion_tokens` is recorded but never flagged - stage 1's cap is the design, not a defect. A reference
that recorded *no* cap at all came from a build that recorded no scalars, which is stated in `unknowns[]` as
`decode values unknown: ...` rather than left to read as agreement; that every real body carries an output cap is
what makes the absence diagnosable instead of merely suspicious.

An image-count difference is the only route to seeing pi's per-turn rewrites at all: `blockImages` replaces every
image block with a placeholder and the `context` event lets other extensions rewrite messages, neither of which
is readable from the extension API. Count plus `messages[k]` is the diagnosis; the count alone is nothing.

## First clean live verdict (2026-09-05, llama.cpp, fresh session)

Recorded while stage 1 still sent `tool_choice`, which is why `params=+tool_choice` appears below.

```
prefix      reference=chain  usable=true  verified=19/19  obs=13  first=verified  truncated  params=+tool_choice
native      accepted  in=3854  cached=23.9k   out=2513   msgs=18  copied=29  est=29.5k  rep=50.9k   70.8s
serialized  accepted  in=4036  cached=0       out=4674   ser=6816c  dropped=0  seg=5802c  prev=0     88.4s
final       5411c via=serialized  keptFrom=cb008170  before=50.9k  summarized=18
```

What each number licenses us to believe:

- **`verified=19/19` from a cold process** proves the retained-ladder design, not just the rebuild: no body was
  held, thirteen observations on the branch answered, and the span matched all of them. This is the first live
  confirmation of the claim the earlier warm-capture runs only suggested.
- **86% cache reuse on stage 1** (3,854 fresh of 27.7k) is the two-stage design paying for itself on local
  hardware: the fresh part is the instruction we append, which is the intended shape.
- **`cached=0` on the reduce is expected and cheap**, not a regression: stage 2 is a different system prompt, no
  tools, one message, so it shares no prefix with anything. 4k tokens.
- **`estimate-skew: -42%` meant nothing, and now cannot fire here.** That figure compared our estimate of the
  request (29.5k) with pi's count for the whole live context (50.9k) - two different bodies once the span
  truncates, which is why the same healthy pipeline printed -42% here and +21% on a hosted run. Against the
  provider's count for the request it sized (3,854 + 23.9k = 27.8k) the estimate was 6% high, inside the noise.

## Failure inventory

Degradation is always toward core, never toward a broken session. Handled today: config off → `undefined`;
signal already aborted → `{ cancel: true }`; no model; stage 1 **skipped** by the fit gate; provider call
**threw**; response `stopReason` `error`/`aborted`; a **`length`** stop on stage 1; response contained a
**`toolCall`**; **blank** summary;
stage 2 failed after stage 1 succeeded → **stage 1's text is persisted** (`route: "native"`) plus a warning;
both failed → core default plus a warning; any unexpected throw (span copy, tree walk, config read) → outer
catch → core default.

**We retry nothing at our layer.** pi's `retryProviderRequest` defaults to `maxRetries ?? 0` and we pass no
`maxRetries`, while core's own compaction passes `getRetrySettings()` — so one 429 kills our attempt where core
would have waited. Deliberate for now, but it is an asymmetry, not a parity.

Gap ledger, agreed 2026-09-05; each row says for itself whether it is still open:

1. **Context overflow and exhausted quota were indistinguishable. CLOSED 2026-09-05.** Both landed as
   `rejected` with a free-text message, though the right response to each is the opposite: overflow means the
   next rung (bounded, no tools) is the fix, while quota means that rung is a second doomed request and core's
   default a third. `failure.ts` now names the cause — `overflow | truncated | content | rate-limit | quota |
   auth | transient | aborted | unknown` — and holds the policy that follows, one row per cause with a rationale
   string that travels into the trace. `transient` is the only cause that resends; `overflow`, `truncated`,
   `content`, and `unknown` cascade; `rate-limit`, `quota`, and `auth` end the compaction. Abandoning returns
   `{ cancel: true }`, the only return value that means stop — `undefined` would let core spend a third request
   on the same account — writes outcome `abandoned`, and warns with the cause, while an `aborted` cause takes the
   silent `cancelled` path because the user pressed the key.

   The predicates are pi's (`isContextOverflow`, `isRecoverableLength`, `isRetryableAssistantError`) so provider
   wording is not ours to invent; the *policy* is ours because pi retries throttle-shaped 429s
   (`retry.js:20-76`) and we never resend a 429, per the rule that 429/401/403 are non-recoverable for that
   instance of compaction. Ordering matters twice over: overflow is tested first because it is the one failure
   compaction exists to resolve (same order as core's `_isRetryableError`, `agent-session.js:2083-2088`), and
   quota is tested before rate-limiting because providers deliver quota with a 429 status — the block-list wording
   that `retry.js:4-19` keeps module-local is restated and pinned by test. A `length` stop that produced far less
   than the budget it asked for classifies as `overflow`, which is where gap 2 and gap 1 meet.

   Retries live in `callForSummary`: exponential from `retryBaseDelayMs`, `retryMaxRetries` extra attempts,
   abort-aware (an abort arriving during the backoff becomes `aborted`, not a provider failure), with the sleep
   injectable so the schedule is tested without waiting on it. `retries` is traced on every arm, so an answer that
   arrived after two backoffs is not reported as a clean one. A rung the policy stopped is still recorded —
   `skipped` with `not attempted: <cause>` — because "chose not to ask" must not read as "never had the
   transcript". The report keys `ATTEMPT FAILURES` by cause and adds `CAUSES`, `compaction-abandoned`, and
   `retry-exhausted`; `abandoned` is deliberately outside `fell-back`, since nothing was handed over.
2. **A `stopReason: "length"` reply was accepted as a complete summary. CLOSED 2026-09-05.** Length can never be
   the detector — a cut-off reply and a brief complete one hold the same bytes up to the cut — so the provider's
   own word now travels out of the response (`SummarizationAttemptResult.stopReason`) into the trace
   (`CompactionAttemptResult.stopReason`, on every arm that got a reply at all). The two rungs answer differently
   deliberately: **stage 1 refuses** a `length` stop, because its checkpoint is stage 2's input and a section lost
   to the cut is gone from the session's memory for good, the section guard cannot see the loss (the surviving
   headings still satisfy it), and refusing costs almost nothing since stage 1's context is cached; **stage 2 keeps**
   the truncated text, because rejecting it would hand the session to pi's default compaction, which re-summarizes
   from scratch under no section contract at all. `summary-truncated` is the report's flag for that survivor.
   `isRecoverableLength` decides which kind of `length` stop it was: producing the budget asked for is
   `truncated`, stopping far short of it is `overflow` — the same split item 1 now names, so the label and the
   cascade agree.
2b. **`ToolInfo` hides a field that reaches the wire.** `pi.getAllTools()` returns
   `Pick<ToolDefinition, "name"|"description"|"parameters"|"promptGuidelines"> & {sourceInfo}` and pi keeps the
   full `ToolDefinition` privately (`getToolDefinition` exists on the runner, not on the extension API).
   pi-ai's OpenAI serializer reads `tool.constrainedSampling` to decide `function.strict`
   (`constrained-sampling.js:50`), so a tool declaring it would make pi's `tools` array differ in bytes from
   ours while the extension API cannot see the field at all — the one place our rebuilt prefix is *not*
   guaranteed by construction. **Latent today, but the field is on the wire already**: for an OpenAI-compatible
   endpoint `supportsStrictMode` is true (only Moonshot/Together/Cloudflare/NVIDIA are excluded), and
   `convertTools` emits `strict: strict ?? false`, so every tool in a llama.cpp request carries an explicit
   `"strict": false`. Our rebuilt tools are `{ name, description, parameters }` and pi-ai fills in the same
   `false`, which is why the two bodies match byte for byte — that equality depends on nobody declaring the
   field. If one did, pi would send `true` where we send `false`, and because llama.cpp renders tool
   definitions into the templated preamble the break would land before any message token: stage 1 pays full
   price. Detection is the chain's `toolsHash`: a run would read `divergences: ["tools"]` with
   `reference=none`, `prefixUsable` omitted, and `cache-read-zero`. A grammar-flavored tool diverges the shape
   further (`type: "custom"` plus a grammar format, and arguments become one required string property), but
   that path needs `compat.supportsOpenAIGrammarTools`, which defaults to false.
   Upstream ask: add the field to the `ToolInfo` projection, or expose `getToolDefinition`. Side effect worth
   knowing: `strict: "require"` against an endpoint without strict mode **throws** inside the adapter, which
   arrives as `stopReason: "error"` with an unmatched message, classifies as `unknown`, and cascades to stage 2
   — which sends no tools at all, so it succeeds. The cause policy happens to be the right handler for it.
3. **Abort mid-flight returned `undefined`, and mislabelled it. CLOSED 2026-09-05.** Seen live as
   `Warning: pi-coder compaction fell back to pi's default: segment: Request was aborted; reduce: This
   operation was aborted`. Two separate faults in that one line: the warning announced a handover nobody asked
   for, and returning `undefined` really did let pi issue its own summarization call against the dead
   controller. Now guarded twice — before the reduce, so an abort during stage 1 does not burn the second
   request that produced the `reduce:` half of the message, and after the cascade, so an abort arriving last
   still outranks the fallback branch. Both write `outcome: "cancelled"` and stay silent, since the user
   pressed the key. Each guard is killed by its own mutation (`M5`, `M6`).

4. **Children have no UI** (`print` mode), so every warning here reaches only the trace and the run
   diagnostics: a quota-starved child looks like a normal finish with a mediocre summary.
5. **Silent-overflow providers could accept a clipped stage-1 input and produce a confident checkpoint of half a
   conversation. CLOSED 2026-09-06 on the detection half.** The check the gap asked for is our estimate of a
   request against the tokens the provider counted for **that same request** (`usage.input + cacheRead +
   cacheWrite`); `estimatedTokens`, `reportedContextTokens` and `usage` were all logged, so no new field was
   needed - what was missing was a comparison that held, and `estimate-skew` had been comparing the estimate with
   pi's whole-context count instead. Repaired, the pair sits between -13% and +43% on every live run of this
   pipeline, so the band is 50% either way and the detail names the direction: estimate far **above** the count is
   the clip shape (the provider saw less than we sent) or chars/4 over-reading the content, and the record cannot
   tell those apart, which the flag says out loud; estimate far **below** means the fit gate decided on a number
   too small. The same pair is now much sharper on stage 1, because `estimatedTokens` anchors on a provider count
   from inside the span where one exists (`estimateSource`): +2% mean error instead of +40%, which is why the
   report keeps a 15% band for anchored estimates and 50% for the heuristic. **(Both figures later turned out to
   be inflated by the stored-row artifact in "The counts, measured against a real session" — the tiers are now
   `exact-cut` 5% / `usage-anchor` 15% / `chars4` 50%, and the 5% one is a count of the very body being sent.)**
   What stays open is the *other* half
   of the gap: a provider that clips without the token count moving is still invisible, because a clip that the
   provider itself does not count is not a number we can receive.
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

8. **A missing cut point is invisible. CLOSED 2026-09-06.** If `preparation.firstKeptEntryId` is not on the path,
   `spanContextEntries` returned everything and stage 1 silently stopped truncating - full price, and a checkpoint
   overlapping the messages that survive. `spanContextEntries` now returns `{ entries, cutFound }` and stage 1's
   attempt record carries `cutFound`, because no other field can recover the fact: an uncut span and a merely long
   one carry identical counts, and the prefix record's `truncated` compares our message count against a
   *reference's* depth, so a shallow reference prints the same shape with nothing wrong. That made
   `span-not-truncated` an inference, and the report now treats it as one - it stays quiet when `cutFound` says
   the thing directly, the same one-fact-one-flag rule as `prefix-uncomparable` under the shape gate. The attempt
   line prints `cut=found` / `cut=missing` / `cut=unrecorded` so a record written before the field cannot read as
   a found cut.

## Validation

`test/modules/compaction/{serialize,sections,handler,trace,prefix-diff,span-session,summarize,prompt,chain,native-sizing,real-session-sizing,fold-chain,cut-shapes,cut-invariants,cut-selection,budget,session-fixture}.test.ts`
plus `test/scripts/compaction-report.test.ts` — 261 cases, two reviewed file snapshots, no provider calls
(`createCompactionHarness()` in `test/helpers/compaction-doubles.ts` records the contexts and options a
`stubModelRegistry` receives, and `evaluateSummarizationResponse` is pure so the accept/reject policy is testable
directly). Stage-1 truncation is pinned by a 1.2M-char
*retained-tail* fixture: if someone re-sends the live context, the fit gate skips stage 1 and that test fails.
`real-session-sizing.test.ts` is the one sizing suite that checks against numbers a provider produced rather than
ones a fixture claims, so read it before trusting any accuracy claim in this file.
`cut-shapes.test.ts` is the readable catalogue of cut shapes (located **by role pair, never by index** - the
recorded session's branch order is its parent chain, not its line order, and hard-coded positions found the wrong
rows while still passing arithmetic); `cut-invariants.test.ts` is the property version over 8 fixed seeds plus
3^5 exhaustive short sequences, and `cut-selection.test.ts` is the repair walk's arithmetic: a nine-row branch with
known counts on both sides of every boundary, one case per rejection condition, and a monotonicity sweep over
tightening windows. `cut-shapes.test.ts` is the readable catalogue of cut shapes (located **by role pair, never by
index** - the recorded session's branch order is its parent chain, not its line order, and hard-coded positions
found the wrong rows while still passing arithmetic).
Mutation-verified: reverting the fit formula to `reserveTokens` fails the sizing test; deleting
`trace.modelResponse(...)` fails two trace tests; forcing `cutFound: true` in the stage-1 fields, or
`cutMissing = false` in the report, each fails exactly one of the two new cut-point tests; disabling the anchored
branch of `fitRequirementTokens` fails both sizing tests and the handler case where the span fits but the live
context does not. From the 2026-09-06 sizing pass: charging stored rows instead of the wire shape fails 3, dropping
the `countBoundary` filter fails 3, disabling the exact-cut tier fails 5, widening the 5% band to 50% fails 1, and
ignoring `skippedEntries` when offering the kept entry fails 1 — the last of which it did **not** do until a test
was written for it, because the guard had no coverage at all when the mutation was first tried.
**The fuzz caught itself being vacuous, which is the lesson worth keeping:** the first version survived three of
four mutations (ignoring `countBoundary`, dropping the assistant-type check from the exact-cut tier, and losing
the instruction term) because its boundary assertion only ran *when* the result was null, every probe passed
`extraTokens: 0`, and no generated branch ever contained a metadata row at the cut. Rewritten as a pair of
directions (admit what is after the boundary, reject what is not) with non-zero instruction terms and metadata
rows spliced at every position, each of the four now fails exactly one test. A property test that cannot be
killed is not a property test.

The cut repair was mutation-checked the same way, and all seven killings landed: persisting core's boundary
instead of ours (1 failure), building the span from core's boundary (1), no walk at all (7), allowing a *later*
boundary (5), dropping the orphan check (5), ignoring the keep budget (1), and restoring the old unconditional
`overflow` skip (2). Two of those seven taught something: the first draft of the persist test asserted a
relationship against itself (`sent < sent + 1`) and would have passed no matter what, and it then failed for the
right reason once written properly - the harness's default fixtures carry `zeroUsage()`, so a test about count
driven cuts has to supply counts.
**Gate fixtures need margin, not coincidence**: the "span plus instruction will not fit" case sat within ~130
tokens of its own threshold, so the projection improvement made it fit and the test read as a sizing failure. It
now pins a window that leaves far less room than the request needs, with the arithmetic in the comment.
Real provider behavior (no-tool-call instruction adherence, cache serving,
`toolCall` refusals) and child execution stay manual — see `src/tools/agent/README.md` § "Changing child
compaction".
