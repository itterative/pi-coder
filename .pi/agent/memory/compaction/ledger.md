---
name: ledger
description: "The head ledger (ledger.ts): solving P + K as a difference of provider counts, the five rules that were each a bug, what it measures on real captures, and the ledger-backed cut walk."
category: architecture
keep_updated: true
---

# The compaction head ledger

Detail companion to the `compaction` memory. Read `sizing.md` first for where the `head-ledger` tier sits in the
ladder and what refuses it; this file is the derivation, the measurements, and the cut walk that runs on it.

## The head ledger (`ledger.ts`): `P + K` is a difference of counts

Every body pi sends is `[system prompt][tools][checkpoint(s)][rows...]`, and the first three are one quantity — a
**head** — that is in every request and in no row. Taken separately `P` and `K` stay estimates (chars/4 of
`systemChars`; a stage's `usage.output` for text the persisted summary then grew sections onto). Together they are a
difference of provider counts, because the first reply counted under a head was charged for exactly `head + rows`:

```
head = input(A) - t(fk .. A)      A = first counted reply after the fold, fk = that fold's firstKeptEntryId
```

and `t()` is itself mostly counted: `input(next) - input(prev)` brackets everything between two replies on one
basis, whatever kinds of row sit there. API: `measureEntries(entries, {headFoldId?})` ->
`{tokens, counted, estimated, checkpoints, restarts}`, `headAt(branch, atIndex)` -> `BodyHead`,
`bodyTokens(branch, {atIndex, from, to, extraTokens})`, `spanBodyTokens(branch, {windowStartId, cutId, extraTokens,
boundary})` — the entry point a handler calls, which applies the refusals — and the delta view
`foldNet`/`foldNets`/`correctAcrossFolds`. It sits beside the persisted-fields rescue ("The stored-count rescue", in
`sizing.md`) rather than replacing it:
the ledger needs a counted reply **after** the fold, so the window right after a fold — before anything has replied,
which is when the fit gate decides whether stage 1 runs — is still `countedBodyTokens`/`fixedPrefixTokens` territory.
The ledger's advantage is the other window: it needs no persisted state, so it also answers for fold rows written by
older builds.

Rules that were each a bug before they were rules:

- **Any row that changes the count basis restarts the chain and is charged as text only if it is a fold.** A
  `model_change` or `thinking_level_change` produces no message, so it costs nothing and exists only to break the
  bracket; the set is `changesCountBasis`, the same predicate `countBoundary` is built from, so the two cannot drift.
  A fold is charged as the text it now is — except the head's own, which restarts and is charged *nothing*
  (`headFoldId`). Dropping that row from the range instead is the bug it prevents: the walk then differences across
  the basis change the row marks, which measured **-9,236 tokens of nonsense** on the capture and put a stage-1
  request 38% out. An older fold's row inside the same stretch *is* a row (pi hoists only the newest summary and
  leaves older ones inline), and `MeasuredTokens.checkpoints` reports what those cost.
- **`net` is "what the fold did to the body", not literally `checkpoint - span`.** A checkpoint riding inside the
  retained stretch is in both bodies and cancels; one the new cut leaves behind does not. Fold 2 on the capture kept
  fold 1's 1,557-token checkpoint and its net came out as exactly `K2 - t(removed)`.
- **The reply bracketing a fold's start must postdate the previous fold's row.** Otherwise its count describes a body
  the earlier fold has since rewritten, and `foldNets` — which sums every fold after a stale count — would charge
  that fold's net twice. With no such reply the fold refuses (`null`); synthetic case pinned.
- **A head is a property of a request shape.** The session records a `model_change` or `thinking_level_change` (why
  `countBoundary` exists) but *not* the system prompt's text moving — pi's own base-versus-override flip changes it by
  ~12k chars with no row at all. So the capture gate matters: one `systemChars`, one `toolsHash`, one model across the
  session's chain rows, `prefixUsable` and `firstMismatchDepth: null` on every prefix record, `cutFound` and
  `skippedEntries: 0` on every attempt.
- **The entry just past a range closes its bracket** (`measureEntries`' `closing`, passed by `bodyTokens` and by both
  head routes). A cut lands on the reply that consumed a tool result, so the rows in front of it are uncounted and,
  open-ended, are a guess; when the cut entry itself carries a count on the same basis, one difference covers them and
  the last counted reply together, and the cut entry's own reply is outside the range so it is walked for chaining and
  never charged. A fold row between the two leaves the walk with no basis and the bracket declines, which is what makes
  a **stale** count usable here: staleness disqualifies a count as the size of a body, never as a difference against
  another count taken on the same basis — `measureEntries` was already using stale counts as brackets inside a range,
  it just could not see past the range's end. Measured on the live capture's six-message window: the trailing stretch
  went from 2,077 tokens of chars/4 to an exact 1,770, the request's skew from **+1.31% to +0.005%**, and the
  estimated share from 25% to 14% — the chars/4 over-read was the *entire* skew.
- **A shape change inside a measured range was a silent hole until 2026-09-07.** `measureEntries` restarted its chain
  at `compaction` rows only, so a `model_change` or `thinking_level_change` sitting *between* two bracketing replies
  fell into `pending`, cost nothing, and left `last` set — which made `input(next) - input(prev)` a difference of two
  tokenizers (or two templated preambles) and filed it under `counted`. The head's staleness guard did not see it,
  because the head anchor can postdate the change while the range straddles it, and `MAX_LEDGER_ESTIMATED_SHARE`
  cannot see it either, because such a range is almost entirely "counted". Fixed by making the walk break at
  `changesCountBasis`; the test that kills the old rule uses a *larger* post-change count (a plausible 3,150 rather
  than an obviously wrong negative), because a test that only fails on an absurd number passes on a quiet one.

## What the ledger measures on real data

Pinned by `ledger.test.ts` on `hosted-head-ledger` (three folds, hosted `qwen3.8-flash`, 216 branch rows):

- `P` from the session's first counted reply: **7,628 with 96 tokens estimated** (seven rows in front of it). Heads
  after each fold: **9,379 / 8,746 / 10,056**. Not monotone, because a head carries *that* fold's checkpoint and fold
  2's summary is 3,888 chars against fold 1's 6,281 — a test that assumed monotone heads would pass on a broken walk.
- **Every counted reply's own provider count is reproduced exactly** — 62 of 63, the exception being the anchor the
  bare head was solved from. Exact *by construction*, not by accuracy, and knowing which is the whole point: the head
  subtracts a measured range from its anchor's count and the body adds a range starting in the same place, so the one
  estimated term they share cancels, and since both ranges close on a counted entry neither has an unbracketed end.
  What the equality pins is **symmetry** — the same fold-row restarts, the head's checkpoint charged once, the closing
  bracket applied to both. Before the closing bracket this was an accuracy measurement instead, and its numbers were
  mean **0.41%**, signed mean **-0.05%**, worst **7.29%** on the session's second reply (91% of that range
  unbracketed, chars/4 under-charging two dense tool results by 724 tokens); do not quote those as the module's
  accuracy now, and do not read the present exactness as perfection. **Accuracy is the stage-1 request's question**,
  where the body sized is not the body the head was solved from.
- All three stage-1 requests decompose to **0.05% / 0.01% / 0.03%** as `head + window + instruction` (before the
  closing bracket: 0.96% / 0.01% / 0.26%). The middle one is the reason the module exists: that run expired every
  count in its span (`staleAnchors: 14`), so the shipped tiers fell back to whole-body chars/4 and recorded
  `est=32738` against the provider's **30,086** (**+8.8%**), where head-plus-rows says 30,088. On the two
  `exact-cut` runs the recorded number is a provider count of that very body — and the ledger beats it anyway (0.05%
  against 0.18%), because `exact-cut`'s whole error is the instruction estimate while the ledger's is only the head's
  leading stretch plus that same instruction.
- Nets: **-11,494 / -19,178 / -54,643**, each with **88-95 tokens estimated** (the gap between two counted replies:
  the earlier reply's own `output`, which is counted, plus the rows behind it).
- **The instruction is measurable and nothing records it.** For an `exact-cut` run, `attempt.usage` prompt minus the
  cut entry's own prompt count isolates the appended instruction: **474 and 511 provider tokens**, against chars/4
  estimates of 512 and 561 (within 10%). That identity is the only way to see the instruction's real cost, and the
  reason a cross-check that forgets the term is off by ~500 tokens per fold.
- **The first cross-check of this was wrong, not the ledger.** It compared `net` against
  `fold.usage.output - (stage-1 prompt - P_est)` and reported 5.5% and 11.5% disagreement, which read as a defect.
  Three real terms were missing from that route: the appended instruction (474/511), the difference between the reduce
  stage's model text and the summary that was persisted (+14/+167/-123 chars/4), and fold 2's riding checkpoint
  (1,557). Do not re-derive a fold's net from `usage.output` minus a span; compare two ledger routes, or a head
  against a provider count of the body it describes.

### Wired as the `head-ledger` tier

`countSpanTokens` ordered it **after** `exact-cut` and the anchor tiers (a count of this body beats a head solved
from a reply in the retained tail) and **before** the persisted-fields rescue (a difference of this session's own
counts beats two numbers a fold row persisted about a request it made, and it works for rows written before those
fields existed). `index.ts` composes it as
`spanBodyTokens(span.branch, { windowStartId: previousFoldWindowStart(branch), cutId: cut.firstKeptEntryId, extraTokens, boundary: span.boundary })`
and passes it in; `spanMessages` returns the branch for the purpose. It reaches the fit gate and the output budget
through the same `counted.tokens` as every other tier.

The shape it fires on is narrower than it looks, and worth knowing before wondering why a run has no `ledger`: the
head's anchor reply must be *outside* the span, because a live count inside the span is the anchor tiers' business.
That is exactly a cut sitting below the newest fold's row — the capture's second run, `staleAnchors: 14`, `chars4`,
+8.8%.

Two guards, each found by a test that failed for a reason worth keeping:

- **`skippedEntries > 0` disqualifies the ledger too**, by the same guard that disqualifies `keptEntry`, and for the
  same reason: a row stage 1 could not copy makes our span narrower than the stored rows imply, so every number built
  from those rows over-sizes the request. The defect was not hypothetical — when the head's anchor *is* the cut entry,
  `head + rows` reproduces that entry's prompt count exactly (the range subtracted to solve the head is the range
  charged back as rows), so the ledger handed back the very number `exact-cut` was disqualified from using and the fit
  gate skipped stage 1 on a run `handler.test.ts` pins as two-stage. One guard for both tiers, since they are refused
  for one reason.
- **A head solved before a shape change is refused** (`boundary`, i.e. `countBoundary`): the anchor reply's count
  describes a prompt and tool set that no longer exist. This is the session-visible half of the shape caveat; pi's own
  base-versus-override prompt flip stays invisible to it, which is what the chain rows are for.

Plus a refusal on estimated share (`MAX_LEDGER_ESTIMATED_SHARE`, `estimatedShare()`): the measured share on real
requests is 1.8-27%, and the case that motivated the limit is the second reply of a session, 91% unbracketed and
7.29% **low** — the one direction a fit gate must not be wrong in. Declining costs nothing, because the tier below is
what answered before.

**The report is the accuracy instrument, and it reads the shadow rather than the chosen tier** — see `trace.md`.

### Live measurements

Three manual `/compact`s on one hosted session (`hosted-live-ledger`) and two on the local route:

- The tier fired for real on the second and third hosted runs: `stale=13` and `stale=3`, no count in the span
  surviving the fold, `src=ledger` against the provider's own `in + cached` at **+0.0%** and **+1.3%** as recorded —
  runs that would have read `src=chars4` before this change. The first run's `exact-cut` tier won and the ledger shadow
  agreed to **+0.2%**, so two routes to one body agreed live, one a count and one arithmetic over counts. Suspects 0,
  invariants 0 (`tier-without-ledger` silent on the runs that claimed the tier, so the fields were recorded),
  `parameters` empty, reuse 82%/75%/78%.
- **Those recorded numbers are the pre-closing-bracket build's**; re-derived with the bracket the same three requests
  come out **+0.045% / +0.004% / +0.005%** with estimated shares 3.0% / 2.3% / 14.0%, and `ledger.test.ts` pins both
  sides of that from the one fixture — the recorded fields as history, the recomputation as the present. The third run
  is the small-window shape: six messages summarized, a **cancelled** reply in the retained tail (`stopReason:
  "aborted"`, all-zero usage, refused as an anchor by every count reader, so the head was solved from the reply
  before it), and an older checkpoint riding inline as 890 estimated tokens — the one term in that body no count can
  reach.
- One measurement only that pairing could give: run 1's head was **7,634 `from:first-reply`** (the bare prefix) and
  run 2's **8,646 `from:after-fold`** (prefix plus the checkpoint run 1 wrote), with `sys=25975c` identical on all
  three — so their difference, **1,012 tokens, is what that checkpoint costs in the next body**, in provider terms,
  with no estimate in it. Stage 2's own `out=902`, which puts the harness-appended part (supplementary sections, file
  lists, pi's `<summary>` wrapper) at **110 tokens**; the second checkpoint derives the same way at **3,979** against
  `out=3740`, i.e. **+239**. That is the gap the capture showed statically as +14/+167/-123 chars/4, and it is why a
  cross-check built on `usage.output` as the checkpoint's size can never close. Run 3's fold wrote the tip and nothing
  replied after it, so its head is **unsolvable** — the refusal, live, and the window the persisted fields still own.
- The local route gives the same accuracy from the other side of a fold: two stage-1 requests at **+0.0%** skew,
  178,261 tokens with 670 estimated (0.4%) and 183,016 with none (0.3%), and heads 7,636 `from:first-reply` -> 9,168
  `from:after-fold` with `sys=25,975c` identical — so a 5,312c checkpoint costs this tokenizer **1,532 provider
  tokens**, where chars/4 says 1,328 (15% low, against the hosted route's 4% low on the same arithmetic).
- Still unexercised live: a *large* window whose trailing stretch is big and unbracketed — the shape the closing
  bracket now mostly absorbs, but only when the cut entry carries a count on the same basis. Every request measured so
  far has had a counted assistant at its boundary, which is the well-conditioned case, so the share to watch remains
  the `LEDGER` section's `est=` column.

## The ledger-backed cut walk (2026-09-07)

Before this landed, the trace could not say **why** a cut moved: `reason`, `rejections`, `movedRows` and `tailTokens`
were computed by `chooseSpanCut` and dropped by `attemptFields`, so the two ids were the whole record. Of 19 attempts
from builds that record `chosenFirstKeptEntryId`, 7 had moved core's boundary earlier, and the one run reconstructed
by hand from its own session file moved for the **keep budget**, not for fit and not for countability: core's
boundary `2ea0911c` is an assistant the provider counted at 184,588, so its span is 185,100 and
`199,013 - 185,100 = 13,913 < keepRecentTokens 20,000`; the walk stepped back 3 rows to `2267e3bd` (177,749 + 512 =
178,261, tail 20,752) and cleared the floor by **752 tokens**. Two lessons, both from getting this wrong first: a
smaller span *grows* the tail, so `tail-under-keep-budget` and `span-does-not-fit` are easier earlier and are as
likely a cause as an uncountable boundary — "a move can only be a countability move" is backwards; and pi's own cut
can land below the user's floor while its chars/4 accumulation says otherwise, which is the same estimator bias that
inflates `proposedRequest`, arriving on the keep side this time.

What landed:

- **`spanSizer(branch, {windowStartId, boundary})`** answers every prefix of stage 1's window from **one** walk: the
  head is identical for every candidate (all of them describe the request about to be sent), so it and its refusals
  are solved once, and an incremental `total(closing)` over the rows prices any position in O(1). The alternative —
  calling `spanBodyTokens` per candidate — rescans the window at each one, quadratic on a long branch and worst
  exactly in the repair path that walks furthest. `createMeasurementWalk` is now the single implementation behind
  both routes, because two copies of this arithmetic is how this module's blind spots have survived before.
- **`measureSpanAt` has two routes and says which answered**: the provider's count of that body first (`basis:
  "count"`, unchanged, and still preferred), then the ledger's (`basis: "ledger"`). So a position whose count a fold
  expired, or whose row carries no usage at all, is now repairable — the whole point. Passing no sizer leaves the old
  behavior exactly, which is why the counterfactual pair (same branch, `sizer: null` versus `sizer`) is a test rather
  than a paragraph.
- **`liveContextSize`** prefers the ledger's live and falls back to `ctx.getContextUsage().tokens`, recording which in
  `cutLiveTokensSource`. This removes `unmeasurable-live-context` from the post-fold window: pi's hybrid is null
  exactly when nothing has replied after the newest fold, and the ledger does not need a reply after it, only a head.
- **The window became an explicit predicate.** `outside-span-window` is a named rejection now. It used to hold by
  accident — a count under the newest fold is expired, so no count-bearing position existed below
  `previousFoldWindowStart` — and a route that prices expired positions has to be told where the span stops being
  buildable. The mutation battery found a redundancy: deleting `measureSpanAt`'s window check changes nothing, because
  `SpanSizer.spanAt` refuses the same positions on its own. The sizer is the authority; the walk's check exists to
  *name* the reason before any index is read, and it is written down so nobody deletes it as untested dead code.
- **Both sides of the keep-budget check are measured numbers**, and the record admits it: `tail/keep` prints together,
  and `basis` plus `live` say which instrument produced each side. A tail is still computed as
  `live - (body + instruction)`, so the instruction's chars/4 estimate biases the comparison toward moving earlier —
  left alone deliberately, because earlier is the conservative direction and 512 tokens on a 20k floor is not worth a
  second convention.
- **What it did *not* change**: the harm it was gated on still has not happened — **0 of 28 native attempts in the
  trace have ever been `skipped` by the fit gate**, and the 17:30 post-fold overflow repaired itself on the count
  route (`stale=5` refused, `src=exact-cut`, `cutMoved=to:44acb954`) because the band between the fold and core's cut
  held a live count. This is what makes the *next* shape — a fold with no fresh band above it — repairable instead of
  abstaining. Expect `cutMoved=no` to get rarer and `basis=ledger` to appear on the line; both are the new path being
  taken, and neither is a regression signal.

The walk's decision is now in the record (`cutMovedRows`, `cutProposedRejection`, `cutRejections`, `cutTailTokens`,
`cutKeepRecentTokens`, `cutSpanTokens`, `cutSpanBasis`, `cutLiveTokensSource`) and on the report as a `cut:` detail
line plus a `CUT` histogram of causes. Until those existed, a moved cut could not be attributed to a condition at
all: three of the six rejection reasons are about our instruments and only two are about the user's floor or the
window, and the two boundary ids cannot tell them apart. `moved-without-cause` is an INVARIANT and one-directional —
a cause with no move is the legitimate abstain path, which the report flags as the suspect `refused-cut-shipped`
instead.

