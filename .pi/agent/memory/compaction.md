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
`reduce-inflated`, `cache-read-zero`, `blocks-dropped`, `summary-truncated`, `fell-back`, `estimate-skew` — with prose in
[docs/compaction-trace-report.md](../../../docs/compaction-trace-report.md). It reads rotated `.1` siblings and
tolerates fields absent in records from older builds, because the file accumulates across checkout.

- `attempt` — per stage: `accepted`/`rejected`/`skipped`, detail, `usage` incl. **`cacheRead`** (the only way
  to tell whether the rebuilt prefix was served from cache), **`stopReason`** whenever a reply arrived (the only
  way to tell a truncated summary from a brief one), estimated tokens, tool/message counts, stage 1's
  `copiedEntries`/`skippedEntries`, stage 2's `serializedChars`/`segmentSummaryChars`. A `skipped` attempt has no
  `stopReason` or `usage`: the request never went out.
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

**`observations: 0` means the chain store was just created (reload, `/resume`, restart), not that the prefix
broke - see the `compaction-chain-blindness` memory for the experiment that proved this, and for the two things
still worth doing there (a total-vs-on-branch count, and whether to persist ladders).**

## `cached=0` in a development session: what is explained and what is not

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

## The prefix funnel, and unknowns the record states itself

One quantity, three names, because each zero has a different cause and the old single `observations: 0` could not
tell them apart:

- `chainObservations` - entries held in this process, unfiltered.
- `branchObservations` - entries whose recorded leaf sits on the current branch.
- `observations` - entries that additionally share our system prompt and tool set (`ChainMatch.compared`).

`parentRequest` mirrors `ourRequest` with the newest on-branch entry's shape (model, `systemChars`, `systemHash`,
`toolsHash`, depth, leaf id) whether or not it was comparable, so a prompt or tool-set difference between our
rebuild and pi's live requests is a field comparison instead of an argument. `unknowns[]` states what the record
cannot answer, and the report prints those as `~ cannot tell:` lines apart from flags: a flag describes the run, an
unknown describes the instrument. `scripts/compaction-report.mjs` adds four suspects from the funnel
(`chain-empty`, `chain-off-branch`, `chain-incomparable`, `system-prompt-drift`) and an `INVARIANTS` section of
cross-field checks - `reference=none` with entries on the branch, an empty chain reporting branch entries, a
usable verdict with no comparable depth, matching hashes over differently sized prompts, comparable observations
with none on the branch. A violation there means the trace is lying, and it must be believed before any cache
conclusion is.

Naming rule for future fields: the trace record and `pi_coder_debug` must use the **same key** for the same
quantity, or the ambiguity this pass removed comes back through a second surface. See
`docs/pi-coder-debug-tool.md`.

## Trace field gotchas

- `ourRequest.systemHash` hashes the **whole** system text as of the funnel pass, matching `requestShape()`, so
  equal hashes do mean equal prompts. Records written before that change hashed only a 320-char excerpt
  (`EXCERPT_CHARS`) and cannot be re-read as evidence that a prompt was stable - `6e84662c` was reported
  unchanged across 12817, 24619, 24813 and 25294 chars. The ladder heads that `verified=N/M` rests on are
  sha256 over messages and never had this weakness.
- A `-key` in `prefix.parameters` means the parent sent a key our rebuild dropped. `+tool_choice` is expected
  (that is our prohibition). `-reasoning_effort` is not: pi's live request carried it and ours does not, so the
  two differ in a decode parameter. Unresolved whether that is cosmetic for the endpoint's cache.
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
exists. `parameters[]` survives as a set difference over body keys, which keeps the "`tool_choice` is a
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

`test/fixtures/session/llamacpp-post-compaction.jsonl` is pi's own output: a 50-entry branch carrying a
`compaction` mid-branch, with the `custom_message`, `model_change`, and `thinking_level_change` entries no
hand-built branch in this suite has. `test/modules/compaction/session-fixture.test.ts` replays that tree through
the span builder and pins what the live run recorded in the trace beside it (29 entries copied, 18 messages,
nothing skipped), so the two fixtures vouch for each other and a change to slicing, copying, or message
conversion trips a golden head hash. Slice the branch with `getBranch()`, never `buildContextEntries()`: the
latter answers with pi's post-compaction view, which has already folded that history into a summary.

`test/fixtures/compaction-trace.healthy.jsonl` — one real llama.cpp run, trimmed to the five records the verdict
depends on (`prefix`, both `attempt`s, `final_summary`, `outcome`), deterministic session/record ids, timestamps re-based with offsets kept,
checkpoint text replaced by a synthetic block of identical length. Used by `test/scripts/compaction-report.test.ts`
to pin "what healthy looks like" (`usable=true`, `verifiedTo=19` at `comparableDepth=19` against
`referenceDepth=33`, only `estimate-skew` flagged). Two lessons it encoded: keep `--json` field names equal to the
record's own names, and never let a flag fire because a record was **absent** — that is what a rotated or trimmed
log looks like, not an empty model answer.

## First clean live verdict (2026-09-05, llama.cpp, fresh session)

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
- **`estimate-skew: -42%` is informational.** chars/4 under-estimated here and over-estimated by 21% on the
  hosted provider, so it swings both ways; the fit gate used `rep=50.9k`, which is why the run went ahead. Keep
  the flag as a report-only observation and do not "fix" the estimate by trusting it.

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

`test/modules/compaction/{serialize,sections,handler,trace,prefix-diff,span-session,summarize,prompt,chain,session-fixture}.test.ts`
plus `test/scripts/compaction-report.test.ts` — 111 cases, two reviewed file snapshots, no provider calls
(`createCompactionHarness()` in `test/helpers/compaction-doubles.ts` records the contexts and options a
`stubModelRegistry` receives, and `evaluateSummarizationResponse` is pure so the accept/reject policy is testable
directly). Stage-1 truncation is pinned by a 1.2M-char
*retained-tail* fixture: if someone re-sends the live context, the fit gate skips stage 1 and that test fails.
Mutation-verified: reverting the fit formula to `reserveTokens` fails the sizing test; deleting
`trace.modelResponse(...)` fails two trace tests. Real provider behavior (`tool_choice`, cache serving,
`toolCall` refusals) and child execution stay manual — see `src/tools/agent/README.md` § "Changing child
compaction".
