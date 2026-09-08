---
name: sizing
description: "How a stage-1 request is sized: the four count tiers, countBoundary/staleAnchors, the wire projection, cut admissibility and the repair walk (cut.ts), the stored-count rescue, and the output budgets behind the fit gate."
category: architecture
keep_updated: true
---

# Compaction sizing

Detail companion to the `compaction` memory. Everything here is arithmetic over what the session already recorded;
`src/modules/compaction/{native-request,usage,cut,ledger,index}.ts`.

## The fit gate and the tier ladder

The gate is `nativeRequestFits`: `needed < contextWindow - outputBudgetTokens`. What it asks is `fitRequirementTokens`,
which takes the best number it can get in **three** steps — `countedRequestTokens` (the ladder below), then
`reportedContextTokens` (`ctx.getContextUsage().tokens`), then whole-body **chars/4** (`estimateRequestTokens`). The
room that matters is the *output* budget, not pi's whole `reserveTokens`: a threshold-triggered compaction runs at
exactly `contextWindow - reserveTokens`, so a gate that re-reserved that window would reject every request this
strategy exists for. An overflow-triggered compaction does reach it, and that is the point — the live context no longer
fits, but a shorter prefix of it might.

`countSpanTokens` (`native-request.ts`) is the ladder behind `countedRequestTokens`, best evidence first:

1. **`exact-cut`** — the provider's own `input + cacheRead + cacheWrite` for the reply sitting *at* the cut point,
   whose request body was exactly this span.
2. **anchored** — a provider's `usage.totalTokens` for a reply inside the span, plus chars/4 only for what followed it
   and for the appended instruction; labelled `usage-anchor`, or **`exact-anchor`** when the tail is empty, because with
   nothing left to charge the anchor *is* the body (`estimateAnchoredSpanTokens`).
3. **`head-ledger`** — arithmetic over the counts bracketing the span's rows (`ledger.md`).
4. **the persisted-fields rescue** — `correctedSpanFromNewest`, labelled `usage-anchor` again, with `foldCorrected`.

If all four decline, `countedRequestTokens` is null and the gate falls back to pi's hybrid count. Every count tier is
filtered by `countBoundary`: a number that predates the newest `compaction`, `model_change`, or `thinking_level_change`
row describes a body that no longer exists and is rejected, counted in `staleAnchors`. The last of the three steps is
*not* the provider's count of the request — `ctx.getContextUsage()` counts the retained tail stage 1 drops, and it is
`null` right after a compaction, which is when compaction usually runs. A hot estimate alone used to skip stage 1 on
~200k windows; the counts are what removed that and the tail's inflation.

Report bands are four, over these tiers: 5% `exact-cut`, which `src=exact` and `src=exact-anchor` both get — the
`exact-anchor` label exists without a band of its own — (a disagreement there means the request is *not* the body that
count describes: check `skippedEnt` and for a fold or model change inside the span), 5% `head-ledger`
(`--ledger-estimate-skew`), 15% `usage-anchor`, 50% `chars4`. `src=` prints `exact` / `ledger` / `anchor` /
`chars4` / `unrecorded`, and `stale=` prints only when non-zero. Two bands for one quantity is deliberate: one
threshold for both would either bury the anchor or cry wolf on the heuristic.

Why the counts outrank chars/4 at all: every assistant entry carries the `usage` of the request that produced it —
`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` — and that request covered the **system prompt, the tool
definitions and every message before it**. So the newest usable usage inside a span is an exact token count for a
prefix of the body stage 1 is about to rebuild, and the system prompt needs no separate term because it is already
inside that number. Only two things still require guessing: the entries after the anchor, and the instruction no
reference ever sent.

Rules worth knowing before "fixing" this:

- **An `aborted` or `error` reply, or an all-zero `usage`, is not an anchor.** It is not a measurement of a context
  that still exists, so the walk keeps going backwards rather than believing the newest big number.
- **`ctx.getContextUsage().tokens` is a hybrid, not the provider's count.** It is `estimateContextTokens(messages)`
  — last assistant usage *plus* chars/4 for everything after it (`compaction.js:148-153`), images counted at 4800
  chars each — and it returns `tokens: null` when the newest compaction has no assistant reply after it
  (`agent-session.js:2556-2574`). Treat `rep=` as a ceiling for the whole live context, never as the size of a
  request.
- **The anchor over-counts when it predates a fold — and that is refused, not tolerated.** An assistant kept from an
  older round carries a count of the context *before* a later compaction folded material away, so its number exceeds
  what this span holds by the whole reclaim. Calling that "rare" and "conservative" was wrong on both words: rare is
  not never, and "conservative" here means the gate loses stage 1, which is the harm. `countBoundary` uses branch
  timestamps, because `buildContextEntries` reorders and can drop rows.

Two retired numbers, quoted in older notes: an anchored-vs-heuristic comparison of **+39.6% mean / +93% worst vs
+2.0%** measured over a recorded child session's 14 turns. Most of the +39.6% was the stored-row artifact below, and
there is now a tier above the anchor — do not quote those four numbers as they stood. With the projection fixed,
anchored sizing measured **within ±1.1% on 11 real turns** (mean -0.2%) once the tail is charged as wire; the
recorded span is 32.5k against the provider's 32,308.

## The wire projection (one copy, in `usage.ts`)

`estimateEntryTokens` and `estimateRequestTokens` used to charge `JSON.stringify(storedMessage)` — which for a
`toolResult` includes **`details`**, and pi keeps a truncated `read`'s full output a *second* time under
`details.truncation.content` (fixture entry `49f16eaf`: 51,134c of content plus 52,318c of details). No provider
receives it: `openai-completions.js:998-1015` sends `{role:"tool", content, tool_call_id}`. Measured on one tail:
provider 13,289t, stored 26,294t (**+98%**), `{role, content}` 13,237t (**-0.4%**). Over the live span the same
heuristic went **+42.2% → -0.3%** by projection alone (and the live record it reproduces says `est=46987` against
`in+cached=32782`). pi's own `estimateTokens` (`compaction.js:188-227`) walks content **by role** and never charged
`details`, so `rep=` was never inflated — which makes **`est > rep` on one run a free tripwire** that the stored-row
bug is back.

The projection is now pi's own `convertToLlm`, in `usage.ts`, one copy. A hand-written `{role, content}` projector is
right for the three roles pi passes through and silently wrong for the four it rewrites:

- a `custom_message` entry becomes a user message (`session-manager.js:177`) and was charged **0** — measured 52
  tokens for one 208-char `pi-memory` marker, and that module's memory-index marker runs to kilobytes;
- a `bashExecution` becomes derived text ("Ran \`cmd\`" plus its output, and *nothing* when `excludeFromContext`) and
  has no `content` field at all, so it was charged as empty;
- a `compaction` or `branch_summary` gains pi's `<summary>` wrapper (~26 tokens).

`usage.ts` now maps an entry to the message pi would build and charges `convertToLlm`'s output through `wireShaped`;
`native-request.ts`'s private duplicates of `wireShaped`/`estimateWireMessages`/`estimateEntryTokens`/
`promptTokensFromUsage`/`contextTokensFromUsage` are gone — the second copy is how the blind spot survived into the
fold ledger. Its count readers are typed by the fields they read
(`Pick<Usage, "input" | "cacheRead" | "cacheWrite">`) so a trace record's `usage`, which is not a pi-ai `Usage`, is
read by the same function instead of a test re-summing it and forgetting the aborted/error refusals. `custom`,
`label`, `session_info` and the two change rows still cost nothing, correctly: `buildContextEntries` returns `[]`
for them.

## `exact-cut` is the common case, not the lucky one

`firstKeptEntryId` names the *kept* entry, so when that entry is an assistant with usable usage, its prompt is the
**fixed prefix plus the span** — no estimation of the body at all, but not a span-only number either:
`countedFoldTokens` subtracts `fixedPrefixTokens` before treating it as what a fold removed (fixture: 32,308,
asserted as equality). Measured 3 of 3 real compactions in `.state/agent-sessions/**` cut on an assistant with
usable usage, for a structural reason: `findCutPoint` snaps forward to the first *valid* cut point at or after the
entry that crossed the keep budget, and a `toolResult` is not valid (`compaction.js:227-240`) — so a mid-turn
crossing lands on the assistant that consumed it. `skippedEntries > 0` disqualifies the tier, because a row stage 1
could not append makes our span smaller than the body counted.

**Retracted: the claim that pi's `keepRecentTokens` is a floor that can only overshoot.** The forward snap can leave
the retained tail **under** budget when the crossing entry is itself a huge `toolResult` swept into the summary.
(The fixture did not hit it: live 53,771 − span 32,308 = tail 21,463.)

## A cut's validity is about ids, not roles (found by fuzzing, not by reading pi)

Three shapes, and pi forbids only one: a tail starting with a `toolResult` orphans the call that went into the
summary; a tail starting after a metadata row is fine (the *next* context row's call may sit before the cut, and a
provider rejects the request outright rather than degrading); and pi's `findCutPoint` ends by walking the cut index
**backwards** over "adjacent metadata entries that do not affect context" (`compaction.js:339-348`), so
`firstKeptEntryId` can legitimately name a row that produces no message at all — while pi's
`CompactionEntry`/`BranchSummaryEntry` carry an optional `usage` of their own. Any sizing tier that asked "is there a
count here" instead of "is this an assistant reply" would report a branch summary's cost as the size of a body it
never measured. `cut-invariants.test.ts` pins all three, including a `[call][user][result]` ordering (a tool
finishing after the user spoke) where pi's own rule *accepts* the cut and the surviving result cites a call id no
provider has ever seen. So an admissibility predicate has to resolve ids and entry types; "pi would never produce it"
is not a proof.

**(b) and (e) are indistinguishable to pi and must not be conflated by us.** `[assistant][result] | [assistant]` and
`[user] | [assistant]` both land on an assistant row with `isSplitTurn` set (`compaction.js:345-350`), both resolve
every id, both give an exact count — and the first swallows a tool cycle whose answer survives while the second
swallows *the prompt whose answer survives*. Recorded because a future rule stated as "cut at an assistant row"
admits both silently.

## `cut.ts` — choosing our own cut point

`chooseSpanCut` runs before the transcript is built, with core's boundary as its **ceiling**: it uses core's choice
whenever that choice is admissible and fits, and only walks **earlier** when it does not. Six conditions, each with
its own rejection tally so a run that could not be repaired says why: resolvable → countable → not-expired-by-
boundary → no-orphaned-tool-call → `tail ≥ keepRecentTokens` → `span + outputBudget < window`. It also refuses to
move at all when `liveTokens` is null, which is the same post-fold window where the counts are unavailable — moving
a boundary while unable to evaluate the keep budget is how a repair becomes a regression.

- **Measurement and admissibility are separate predicates.** `measureSpanAt` answers "what is this span's size" by
  two routes in order — the provider's count of that very body (an assistant at the cut reads its `prompt`; a user
  turn at the cut reads the reply above it via `totalTokens`), and failing that the ledger's arithmetic over the
  counts that bracket its rows — and `orphanedByPosition` answers "does the tail resolve": one backward pass
  maintaining the earliest call index among results below each position, because both conditions are monotone in the
  earlier direction and that is the whole termination argument. Cutting *at* a tool result is measurable and
  inadmissible; conflating the two is how a size check would be trusted to catch a malformed request.
- **Only earlier is what keeps the blast radius zero.** The tail grows, so `keepRecentTokens` holds by
  construction, and core's `messagesToSummarize` stays a **superset** of what is actually dropped — so the file
  ledger, `previousSummary`, and the split-turn wording remain sound without being recomputed. The cost of the
  superset is duplication (stage 2's transcript can include rows that survive verbatim in the tail), absorbed by the
  merge-don't-concatenate rule. A *later* cut inverts that and is the deferred case.
- **`tokensBefore` is deliberately left as core's.** It is `estimateContextTokens(buildSessionContext(...))` — the
  whole live context, not "tokens before the cut", despite the name — so a moved boundary does not invalidate it.
  Re-deriving it from the new span would understate the session.
- **Two source rows are consulted, in order.** `buildContextEntries()` is sliced for the cut point's *id*, but after
  a fold the old rows disappear from the resolved view; `getBranch()` is consulted for a boundary that only exists
  there. `spanMessages` prefers the resolved view and falls back to the branch when the chosen id is not
  context-visible.
- **Trace and report**: `chosenFirstKeptEntryId` + `proposedFirstKeptEntryId` on the stage-1 attempt, printed as
  `cutMoved=no` / `cutMoved=to:<id>` / `cutMoved=unrecorded` — three states, because "the walk abstained" and "this
  record predates the walk" must not read alike.

Still not built, on purpose: the `exact-anchor` *label* exists but `src=exact` and `src=exact-anchor` both get the 5%
band, and (a) a **later** cut, which would force owning the summarized set and
`computeFileLists(preparation.fileOps)`.

### The stored-count rescue (the persisted route)

A `compaction` row persists `countedBodyTokens` and `fixedPrefixTokens` — and only when its own span was `exact-cut`
counted — so `correctedSpanFromNewest` can answer the window right after a fold, where the first pass rejects every
anchor and the caller would otherwise fall to chars/4: a stale count, minus what each fold in range removed (its
counted request, net of the fixed prefix inside that count), plus each fold's `usage.output`, plus the usual chars/4
tail — labelled `usage-anchor`, with `foldCorrected=N` printed beside `stale=N`.

- **Two operands, not one derived number.** The first version persisted `counted.tokens - instruction` as
  `spanTokens`, which quietly kept the fixed prefix inside it: a fold discards the span, the count covers prefix plus
  span, so the subtraction removed the prefix a second time — 6-12k tokens on these runs — and the error ran
  *toward* "it fits", the one direction the guard exists to refuse. Persisted operands can be audited at the
  subtraction site; a field name cannot.
- **Persisted whatever the stage then did.** A fit-gate skip and a rejected reply still discard the same span, and
  the fold after a rejection is exactly the one whose successor has nothing else counted.
- **Forward-only.** Rows written before this lack the fields, and the rescue refuses (`source: "none"`,
  `foldCorrected: 0`) rather than approximating — including when the two operands imply the fold removed nothing,
  and when the correction would drive the body below zero.
- **A summary is charged once, by choice rather than accident:** `vouchedFolds` returns the rows the persisted counts
  paid for and the tail estimate skips them, because `estimateEntryTokens` started charging fold rows (`ledger.md`) and
  the old "the estimator answers zero for a fold row" compensation silently became a double count. A fold
  nobody vouched for is still charged as the text it now is.

## The head ledger

`P + K` as a difference of provider counts, the rules that were each a bug, what it measures on real
data, how it was wired as the third count tier, and the ledger-backed cut walk: `ledger.md`.

## The budgets behind the fit test

`keepRecentTokens` drives the retained tail, and so drives the cut. `reserveTokens` drives the trigger line **only**:
it used to set the output budget as well (`floor(0.8 × reserve) = 13,107` for stage 2, `/3 = 4,369` for stage 1, which
did match the fixtures' live `maxTokens`), and that anchoring was the defect — a number about the agent's turn headroom
was silently capping what a summarizer may answer with. The earlier idea of using `max(keepRecentTokens, reserveTokens)`
for the cut stays dropped: it would rewrite the user's tail intent whenever they set a high reserve. This **reverses
an earlier ruling** of this note that `reserveTokens` "feeds the trigger line and the output budget".

What the budget is now (`summarizationBudgetTokens` in `index.ts`, exported, pinned by
`test/modules/compaction/budget.test.ts` plus handler cases):

- **Each stage pays for its own body:** `max(MIN_OUTPUT_TOKENS, min(model.maxTokens, window − requestTokens −
  margin))`, where `requestTokens` is the **whole request that stage is about to send** — for stage 1 the system
  prompt, tool schemas, span and appended instruction (`runSegmentStage`, from its own counted request); for the
  reduce the serialized blob plus `SERIALIZATION_SYSTEM_PROMPT`, and no tools (`stageTwoRequest`). The handler case
  "sizes the reduce's cap from its own transcript" is the one that separates the two numbers; it dies if the reduce
  inherits stage 1's again. whereAgainst `~/.pi/agent/models-store.json`, `qwen3.8-flash` reports `maxTokens: 65,536`,
  so the cap went from a constant 13,107 (4,369 for stage 1) to the model's own ceiling.
  **Sharing one number was a live defect until 2026-09-07:** `StageContext.maxTokens` came from chars/4 of *core's
  proposed span* and was read by both the reduce and the walk, so the reduce's cap tracked how full the *session* was
  rather than how big its *request* was — 5,188 tokens on the first fill of a 200k window (against a 10,408-token
  request, answered at 3,249, 63% of the cap) and the 1,024 floor on the second fill (against 8,712). The field is
  now `cutOutputReserveTokens` and only `chooseSpanCut` reads it, which is where it belongs: the walk has to weigh a
  reserve before any stage exists, and the proposed span is its conservative side.
- **A cap must never bind**, because a truncated checkpoint is discarded whole: recorded replies were 2,821t for 9
  events and 2,313t for the reduce, and the cap was never the reason the model stopped. The rival-draft property the
  old `1/3` protected (stage 2 once wrote *longer* than the 3,207-token checkpoint handed to it) is carried by the
  instruction ("must be no longer than the checkpoint you were given") and the report's checkpoint/summary ratio.
  Rationing the fatal direction was the bug; verbosity is only a cost.
- **A floored cap is worse than a binding one, and it fails silently.** The 1,024-token ask above came back
  `stopReason: "length"` with `output: 1024` and **no text at all**: a thinking model spends a budget that size before
  it starts writing, so the rung failed as `content` / "summarization returned an empty summary" rather than as a
  truncation, and `summary-truncated` never had a chance to speak. The cascade held — stage 1's checkpoint persisted
  as route `native` (8,590c from a 5,957c document) and the session lost the merge, not the history — but the reduce
  burned 47s and 8.7k fresh tokens to contribute nothing. Two consequences: the floor's own warning ("a floored
  budget grants room the window lacks") applies on the output side too, and a `length` stop whose text is empty is the
  signature of a starved budget, not of a verbose model.
- **Why the subtracted term is the request and not the span:** the fixed prefix is large — the recorded system prompt
  alone is 25,694 characters, plus six tool schemas — so `window - span - instruction` overstates the room by
  thousands of tokens. A `× 0.9` multiplier briefly hid that; it was a haircut on the wrong quantity (2k on a tight
  window, 94k on a million-token one) and is gone.
- **`marginTokens` is an optional parameter** (default `SUMMARIZATION_MARGIN_TOKENS`) so a test can state the margin
  its case assumes instead of hardcoding the shipped number — `budget.test.ts` passes 0, 1,500 and 2,000 to pin the
  formula and the gate's falsifiability. Hardcoded margins in tests hid a real gap: with the parameter ignored, five
  tests fail now, but when the value was only ever compared against a copied literal the same mutant passed silently.
  Don't reintroduce the literals.
- **The margin is a constant, and the `max(0, ...)` is deliberately unfloored.** The gate is
  `needed < window - output`; at `budget == window - request` it reduces to `needed < needed` and refuses every run,
  so some margin must stay. The margin is sized to the error in the number subtracted: ~1% on a provider count,
  worse on chars/4, and it does not scale with the window. Floors belong on the *request* (`MIN_OUTPUT_TOKENS`, applied
  by the caller): a floored budget grants room the window lacks, and the gate charges it back. `window - span >= tail >=
  keep` is why the remainder has a practical floor (~20k) without needing a proportional haircut.
- **Three limits were built, tested, and deleted here**, all caught by mutation testing rather than by reading: a
  `Math.min(need, budget)` clamp a preceding refusal made unreachable; a per-event `2,600 + 60 × messageCount` cap plus
  the `CHECKPOINT_MIN_USEFUL_TOKENS` floor that existed to repair it; and the `× 0.9`. Any future stage-1-specific
  number needs a test that fails when it is deleted *and* one that fails when it binds.

Still not implemented: the **sanity post-condition** —
`budget + keepRecentTokens + fixedPrefix < window - reserveTokens` (where `budget` is the
`summarizationBudgetTokens` number, no longer a reserve-derived constant), flagged when false. Without it, a window
too small to compact usefully produces a compaction that re-triggers immediately, and the trace shows a healthy run
rather than an impossible configuration. On a 200k window the terms are ~33k against a 184k line, so this only bites on
small windows — which is exactly when it is invisible until it hurts. **The invisible case is now observed**
(2026-09-07 17:30, run `01a07cec`): the reduce's cap was the 1,024 floor on a 200k window, and the trace read as an
accepted stage 1 plus a rejected stage 2 with no flag at all — suspects 0, invariants 0. The post-condition would have
named that configuration before the request went out.
