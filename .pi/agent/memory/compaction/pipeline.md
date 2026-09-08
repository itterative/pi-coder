---
name: pipeline
description: "Two-stage compaction internals: span construction (stageOneSpanEntries, non-idempotent hoist), request parity (tool_choice, thinking level, sampling params, Date.now stamps), serializer, and the summary/details contract."
category: architecture
keep_updated: true
---

# Compaction pipeline

Detail companion to the `compaction` memory. Read pi's `docs/compaction.md` and
`dist/core/compaction/compaction.js` before changing any of this.

## Why core is replaced

Core serializes the summarized span (`serializeConversation`): `[Assistant thinking]:` **untruncated**, tool
results at a non-exported fixed 2000 chars, no overall budget — then sends it with `cacheRetention: "none"` and a
fresh `sessionId`, so all of that bulk is billed as fresh input.

## Stage 1 — native span read

`span-session.ts` copies pi's resolved context entries (`ctx.sessionManager.buildContextEntries()`) truncated at
`preparation.firstKeptEntryId` into `SessionManager.inMemory(cwd)`, and
`convertToLlm(spanManager.buildSessionContext().messages)` yields the discarded span as **real message objects** —
previous checkpoint included, retained tail excluded. Built with the parent's `ctx.getSystemPrompt()` and its
active tools in `agent.state.tools` order, so the request is a strict shorter prefix of what the provider already
cached. Tools stay in the request — removing them would move the prefix — and the prohibition on calling them is
the instruction text, because `tool_choice` is not sent (below). There is **no tool-call pruning in
`native-request.ts`**: it never looks at `toolCall` parts, and any future pruning must be measured against the
reuse numbers in `prefix-cache.md`.

Stage 1 forwards the session's thinking level as `reasoningEffort` (below); stage 2 deliberately does not. A
`toolCall` block in the response rejects the stage; a call the server leaves unparsed arrives as text and is
**not** detected. Each stage's reply is capped by the same formula, `summarizationBudgetTokens` —
`min(model.maxTokens, window − request − margin)`, floored at `MIN_OUTPUT_TOKENS` — where `request` is **that
stage's own request** (stage 1: the system prompt, tool schemas, span and appended instruction; the reduce: its
serialized blob plus its own system prompt). A cap that binds discards a checkpoint whole, so the cap must track the
request rather than the session's fullness (see `sizing.md`, "the budgets behind the fit test"). Stage 1 is told it
is an intermediate, because a generous intermediate becomes a rival draft: measured before any cap existed, stage 1
wrote 3,207 tokens and the reduce then produced something *longer* than the material it was handed. That risk is
carried by the instruction and the report's ratio, not by a smaller cap.

## Stage 2 — serialized reduce

One bounded text-only call over `serializeConversationMinimal(span)` + stage 1's `<segment-checkpoint>`, plus
`<previous-summary>` **only when stage 1 did not run** (stage 1's instruction already carries it forward, so
feeding both invites a union of duplicates). Transcript-first on disagreement, checkpoint fills what compression
removed, and the output must be no longer than the checkpoint it was given — merge and drop, never concatenate.

`overflow` **attempts** stage 1: it used to be skipped outright, on the reasoning that the live context provably
does not fit — true of the live context, false of a shorter prefix of it, which is what the cut walk looks for.

## Summary and details contract

`summary` = model text + `buildSupplementarySections()` (`## Verbatim Recent Requests`, `## Tool Ledger`,
`## Delegated Runs`, `## Dropped Context`, all computed by `analyzeSpan` rather than recalled) + pi's
`<read-files>`/`<modified-files>` tail. The model is told to write pi's section skeleton **only** and to skip the
harness-owned ones, so `CompactionSummaryMessageComponent` and the `/agents` transcript keep rendering.

`details` = `{ version: 1, route, provider, model, readFiles, modifiedFiles, summarizedMessages, droppedBlocks }`.
`route` is `"two-stage" | "native" | "serialized"` (renamed from `strategy` when stages arrived; core reads only
the two file-list keys, which **must keep pi's names** or cumulative file tracking breaks silently).
`tokensBefore` passes through from `preparation` (it sizes the whole live context, so a moved cut does not
invalidate it), while `firstKeptEntryId` is **ours to move** — core honors whatever the result returns
(`agent-session.js:1412-1418`), and `cut.ts` only ever moves it earlier, which keeps that tail at least as long as
core intended. So core's default ~20k-token native tail is a floor here, not a fixed choice.

## Serializer

`serialize.ts` keeps pi's labels (`[User]:`, `[Assistant thinking]:`, `[Assistant]:`,
`[Assistant tool calls]:`, `[Tool result]:`, plus `[Bash]`, `[Bash result]`, `[System note]`,
`[Compaction summary]`) and changes the policy: thinking off by default (it is normally the largest block in a session,
and pi keeps it in the live context anyway, so dropping it from the transcript loses nothing — `hideThinkingBlock` is
display-only), per-tool result caps that know an
`agent` report is worth more than `read` output, argument renderings that understand pi-coder's tools (`agent`
keeps action/agent/runId/title and reports `taskChars`; unknown tools degrade to sorted argument **key names**
only), and newest-first packing under `serializedMaxTokens` so an overflow request cannot fail to fit. Look up
transcript-derived keys through `configured()` (`Object.hasOwn`), never bare indexing: a tool or argument named
`constructor` otherwise yields a function where a character budget belongs.

Anchoring cannot help stage 2 sizing and this is not an oversight: stage 2 sends a text blob we serialize ourselves,
so no historical usage describes it. `packWithinBudget` therefore still decides which transcript blocks survive on
a chars/4 estimate — the reason gap 7's budget should come from the window rather than from a number this crude
(see `failures.md`).

## Stage 1's span window (`stageOneSpanEntries`)

pi's resolved context (`buildContextEntries`, `session-manager.js:198`) hoists the **newest** `compaction` entry to
the front and lets any older summary inside the kept range ride along **at its file position**. That order is
neither file order nor newest-first, and the hoist is **not idempotent**: hand it back its own output and the
*last* compaction entry in the list — the older one — takes the front slot.

Stage 1 used to build its body through exactly that trap: `spanMessages` sliced pi's **resolved** list at the cut
and copied it into a fresh in-memory session, so the hoist ran a second time and the older summary jumped to index
0. With one summary in range (fold 2) hoisting is a no-op, which is why folds 1 and 2 looked clean; with two (fold
3 onward) the request stops being a prefix of the cached prompt at precisely its second message. Measured cost on
the run that caught it: `in=41.8k cached=7168` — 83% of a 40k-token stage-1 prompt re-read fresh, every fold.

The fix is to stop feeding an already-hoisted list to a non-idempotent builder.
`stageOneSpanEntries(branch, firstKeptEntryId)` takes the **file-order window** core itself walks —
`previousFoldWindowStart` is the newest fold's `firstKeptEntryId`, mirroring `prepareCompaction`'s
`boundaryStart` — up to the cut, so the hoist runs once on chronological input, reproduces pi's order, and entries
older than the last fold (which no provider ever cached) leave the span. Two things that look like bugs and are
not: the wire format drops `timestamp`, so the fresh stamps `appendCompaction` mints are inert for cache alignment
(`requestShaped` in the fixture test says so), and `keptEntry` still comes from the resolved-or-branch list,
because only that answers whether the boundary's count survives into the cached prefix.

**The same depth-2 signature has a second cause: the window can miss the checkpoint row entirely.** A live body
begins with the newest checkpoint no matter where its row sits, and the retained tail starts at that row's own
`firstKeptEntryId` — so when a fold's cut lands inside that retained tail, the chronological window `[previous
fold's firstKept, cut)` ends *before* the checkpoint row and stage 1 sends a body simply short of the cached front
message: `at messages[2] ours=assistant/1082c pi=user/11910c`, with everything after aligned one place apart.
`stageOneSpanEntries` closes it by appending the newest fold row when the slice lacks it — appending, not
prepending, because a copied row hoists only when it is last among the fold rows, and only by then has
`firstCopiedId` resolved so its `firstKeptEntryId` names an entry the copy contains. `hosted-three-folds` cannot
reach this shape (both its fold rows fall inside the window), which is why a second real session became a fixture:
`hosted-cut-before-checkpoint.jsonl`.

Reading lesson: **an order-only comparison cannot see either defect.** Dropping a leading message leaves an ordered
subsequence, so alignment passes and only message identity at position 0 and the length differ. Shuffled placement
and a missing head both surface as `first=messages[2]` and are told apart exactly that way. A flag you cannot
explain is not a false alarm.

`test/modules/compaction/session-fixture.test.ts` pins this on `hosted-three-folds.jsonl`, whose fold-3 window
holds two summaries, and carries a counterfactual: the same entries taken from the resolved view must **not**
align. Order, not membership, is the invariant, so the assertions compare message identity at each position — the
front slot holds *a* summary either way, which is why index alone proves nothing.

## A rebuilt Context is not byte-stable (pi stamps `Date.now()`)

`buildSpanSession()` re-appends each entry into an in-memory `SessionManager`, and pi gives a `custom_message`
entry a fresh timestamp as it goes. Replaying the same session file twice produced message `timestamp` values
1.5 seconds apart, which varied every downstream cumulative hash. Not a live cache bug, for two independent
reasons: provider adapters do not serialize `timestamp`, and `prefixVerdict()` folds `requestMessages(payload)` —
the **body** pi-ai built — rather than the `Context` objects, so the chain compares wire shapes on both sides. That
asymmetry is why `verified=19/19` was meaningful and is worth preserving if this is ever refactored.

It is still a latent hazard: any adapter that forwarded unknown fields would turn it into a real prefix break at
that message. So hash a `{ role, content }` projection when a golden value must be stable — see `requestShaped()`
in the session fixture test — and do not assume the system prompt is the time-varying part:
`core/system-prompt.js` contains no date.

## Request parity

The cache entry stage 1 wants was created by pi's **turn** requests, so anything our rebuilt body adds, drops, or
re-values sits in prefix territory.

**`tool_choice` is not sent** (dropped 2026-09-06). Stage 1 used to send `toolChoice: "none"` while keeping the
parent's tool definitions, on the theory that the field is the portable way to forbid calls and the instruction text
is the backstop. Removed because it was the **only** body key our request carried that pi's own requests do not, and
because on a server that recognizes in-band calls by applying a grammar rather than honoring a parameter, asking for
no tool calls plausibly switches that parser off — and then the call comes back as **text**. The second is inference
from one run, not a proven mechanism: `01a07567` (2026-09-06 06:30, llama.cpp `qwen3.8-27b`) accepted stage 1 at
`stopReason: stop` with a summary whose last line was a bare `</tool_call>` — the model's own tool invocation, in
the summary that got accepted and handed to stage 2. Earlier evidence cuts the other way on cost: an un-truncated
design that *did* send `tool_choice` reached `input: 376, cacheRead: 34339`, so the field did not disturb the cache
then. Residual gap: a call arriving as text is undetected, and that is the one case worth adding a tail-shape
detector for. Verify on the next stage-1 run that `prefix.parameters` is empty, and that if the model still calls,
the rejection reads `attempt.outcome: rejected` with `stopReason: toolUse` rather than a `stop` carrying prose.

**Stage 1 forwards the thinking level.** Omitting it was not neutral: on the compatible branches pi-ai renders
`enable_thinking = !!options.reasoningEffort` before mapping the level through `model.thinkingLevelMap`, so a
request that never asks gets `enable_thinking: false` and no effort key while pi's has `true` plus the user's level
— a difference inside the templated preamble, where it costs the whole cache read. `turnThinkingEffort` in
`summarize.ts` sends the level under the same two conditions pi's turn request would (model supports reasoning,
level not off), and the caller reads it from `pi.getThinkingLevel()` inside a `try/catch`. That guard is for **the
build**, not for children: every bound session answers the getter from its own state, so a delegated child has its
own level and stage 1 is matched against that child's turns, which is what parity means there. The catch covers a
method absent on an older running pi and a handler surface that refuses the call; a presence check would cover only
the first. Two easy-to-miss details: we call `modelRegistry.complete()`, which takes **API-level** options, so the
field is `reasoningEffort` holding a *level* — the `reasoning` → `reasoningEffort` translation lives in
`streamSimple`, which we do not use (same reason `toolChoice` reached the wire as `tool_choice` for us); and passing
`"off"` through is not the same as dropping it, because `!!"off"` is truthy and would flip `enable_thinking` to
`true`, hence the collapse to `undefined`. Stage 2 does not forward it on purpose: no cached prefix (own system
prompt, no tools, `cacheRetention: "none"`, fresh session id), and thinking tokens come out of the same output
budget as the summary — on the one rung that *keeps* a `length`-truncated answer.

**The model's own sampling parameters are merged.** pi's turn request goes through `streamSimple` →
`buildBaseOptions`, which sets `samplingParams: {...model.samplingParams, ...options.samplingParams}`, and
`buildParams` finishes with `Object.assign(params, options.samplingParams)` — **last, so these keys override the
named fields**. Our `modelRegistry.complete()` path never runs `buildBaseOptions`, so anything a user configured on
the model (`top_p`, `top_k`, `min_p`, `repetition_penalty`, `chat_template_kwargs`) reached pi's body and not ours.
On llama.cpp, vLLM and SGLang that is prefix territory, because those land in the chat template; the type doc is
explicit that only the OpenAI-compatible adapters read it, so elsewhere the merge is inert rather than a second
behavior. `callForSummary` now does the merge, which puts it on **both** rungs: stage 1 for parity, stage 2 because
a configured `repetition_penalty` exists to fix that model's output habits and the summarizer is the same model.
Consequences, so nobody calls them bugs: a configured `max_completion_tokens` overrides our stage budget here
exactly as it overrides pi's turn budget there (parity, not a leak — the cap is a default, not a guarantee); and the
omission is detectable rather than silent, because the adapter assigns these as keys and a missing merge shows up as
`-top_p` in `prefix.parameters`. No live record has ever shown one, which is the evidence that neither local route
configures sampling parameters today — the fix closes a latent break for other people's configs, not an active one
for ours.
