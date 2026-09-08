---
name: failures
description: "The compaction failure inventory and gap ledger: cause taxonomy and what each cause does, retry policy, what each stage does with a truncated reply, and the eight gaps with which half of each stays open."
category: architecture
keep_updated: true
---

# Compaction failures and the gap ledger

Detail companion to the `compaction` memory. `src/modules/compaction/{failure,summarize,index}.ts`.

## Inventory

Degradation is always toward core, never toward a broken session. **Nothing may throw**: the handler catches
everything and warns, because a defect here should cost summary quality, never a session that can no longer be
compacted. Handled today: config off → `undefined`; signal already aborted → `{ cancel: true }`; no model; stage 1
**skipped** by the fit gate; provider call **threw**; response `stopReason` `error`/`aborted`; a **`length`** stop on
stage 1; response contained a **`toolCall`**; **blank** summary; stage 1 failing alone → stage 2 with no segment; stage
2 failing after stage 1 succeeded → **stage 1's text is persisted** (`route: "native"`) plus a warning; both failed →
core default plus a warning; any unexpected throw (span copy, tree walk, config read) → outer catch → core default.

A provider failure never throws at a `complete()` caller, so the exception arm is not the interesting one — see
`upstream-gaps.md`.

## Cause taxonomy (gap 1, CLOSED 2026-09-05)

Context overflow and exhausted quota used to be indistinguishable: both landed as `rejected` with a free-text message,
though the right response to each is the opposite — overflow means the next rung (bounded, no tools) is the fix, while
quota means that rung is a second doomed request and core's default a third. `failure.ts` now names the cause —
`overflow | truncated | content | rate-limit | quota | auth | transient | aborted | unknown` — and holds the policy that
follows, one row per cause with a rationale string that travels into the trace. `transient` is the only cause that
resends; `overflow`, `truncated`, `content`, and `unknown` cascade; `rate-limit`, `quota`, and `auth` end the
compaction. Abandoning returns `{ cancel: true }` — the only return value that means stop, because `undefined` would
let core spend a third request on the same account — writes outcome `abandoned`, and warns with the cause, while an
`aborted` cause takes the silent `cancelled` path because the user pressed the key.

The predicates are pi's (`isContextOverflow`, `isRecoverableLength`, `isRetryableAssistantError`) so provider wording
is not ours to invent; the *policy* is ours because pi retries throttle-shaped 429s (`retry.js:20-76`) and we never
resend a 429, per the rule that 429/401/403 are non-recoverable for that instance of compaction. Ordering matters twice
over: overflow is tested first because it is the one failure compaction exists to resolve (same order as core's
`_isRetryableError`, `agent-session.js:2083-2088`), and quota is tested before rate-limiting because providers deliver
quota with a 429 status — the block-list wording that `retry.js:4-19` keeps module-local is restated and pinned by
test. A `length` stop that produced far less than the budget it asked for classifies as `overflow`, which is where gap 1
and gap 2 meet.

**Retry:** lives in `callForSummary`, exponential from `retryBaseDelayMs`, `retryMaxRetries` extra attempts,
abort-aware (an abort arriving during the backoff becomes `aborted`, not a provider failure), with the sleep injectable
so the schedule is tested without waiting on it. `retries` is traced on every arm, so an answer that arrived after two
backoffs is not reported as a clean one. That is the whole of our resending: pi's `retryProviderRequest` defaults to
`maxRetries ?? 0` and we do not engage the transport's, so where core's compaction would hand a transient failure to
`getRetrySettings()`, ours names the cause and decides per cause. The asymmetry with core's defaults is deliberate and
recorded in the config note (`retryMaxRetries` 2 from 1000ms, doubling, against core's 3 from 2000ms): this stall
happens inside a turn the user is waiting on.

A rung the policy stopped is still recorded — `skipped` with `not attempted: <cause>` — because "chose not to ask" must
not read as "never had the transcript". The report keys `ATTEMPT FAILURES` by cause and adds `CAUSES`,
`compaction-abandoned`, and `retry-exhausted`; `abandoned` is deliberately outside `fell-back`, since nothing was handed
over.

## A `length` stop (gap 2, CLOSED 2026-09-05)

A `stopReason: "length"` reply used to be accepted as a complete summary. Length can never be the detector — a
cut-off reply and a brief complete one hold the same bytes up to the cut — so the provider's own word now travels out of
the response (`SummarizationAttemptResult.stopReason`) into the trace (`CompactionAttemptResult.stopReason`, on every arm
that got a reply at all). The two rungs answer differently deliberately:

- **stage 1 refuses** a `length` stop, because its checkpoint is stage 2's input and a section lost to the cut is gone
  from the session's memory for good, the section guard cannot see the loss (the surviving headings still satisfy it),
  and refusing costs almost nothing since stage 1's context is cached;
- **stage 2 keeps** the truncated text, because rejecting it would hand the session to pi's default compaction, which
  re-summarizes from scratch under no section contract at all. `summary-truncated` is the report's flag for that
  survivor.

`isRecoverableLength` decides which kind of `length` stop it was: producing the budget asked for is `truncated`,
stopping far short of it is `overflow` — the same split gap 1 names, so the label and the cascade agree. See the
starved-budget signature in `sizing.md`: a `length` stop whose text is *empty* is the floor, not the model.

## Abort mid-flight (gap 3, CLOSED 2026-09-05)

It used to return `undefined`, and mislabel itself. Seen live as `Warning: pi-coder compaction fell back to pi's
default: segment: Request was aborted; reduce: This operation was aborted`. Two separate faults in that one line: the
warning announced a handover nobody asked for, and returning `undefined` really did let pi issue its own summarization
call against the dead controller. Now guarded twice — before the reduce, so an abort during stage 1 does not burn the
second request that produced the `reduce:` half of the message, and after the cascade, so an abort arriving last still
outranks the fallback branch. Both write `outcome: "cancelled"` and stay silent, since the user pressed the key. Each
guard is killed by its own mutation (`M5`, `M6`).

## Silent-overflow providers (gap 5, detection half CLOSED 2026-09-06)

A provider could accept a clipped stage-1 input and produce a confident checkpoint of half a conversation. The check the
gap asked for is our estimate of a request against the tokens the provider counted for **that same request**
(`usage.input + cacheRead + cacheWrite`); `estimatedTokens`, `reportedContextTokens` and `usage` were all logged, so no
new field was needed — what was missing was a comparison that held, and `estimate-skew` had been comparing the estimate
with pi's whole-context count instead. Repaired, the pair sits between -13% and +43% on every live run of this pipeline,
so the band is 50% either way and the detail names the direction (see `trace.md`). The same pair is now much sharper on
stage 1 because `estimatedTokens` anchors on a provider count from inside the span where one exists (`estimateSource`).
**(An earlier version of this note claimed "+2% instead of +40%" from that split; both figures were inflated by the
stored-row artifact in `sizing.md`.)** What stays open is the *other* half: a provider that clips without the token count moving is still
invisible, because a clip the provider itself does not count is not a number we can receive.

## A degenerate stage-1 answer (gap 6, CLOSED 2026-09-05)

On a live run stage 1 answered 509k tokens of context with 35 tokens of *"I don't have any prior thinking to reproduce
— this is the first turn of our conversation, so there is no previous internal reasoning that exists to be audited
verbatim."* Non-empty, fluent, useless, and accepted, so the run persisted as `route: "two-stage"` over a 169-char
checkpoint. Now: `prompt.ts` owns `CHECKPOINT_SECTIONS` (lowercase **words**, beside the format they come from, so the
instruction and the guard cannot drift), `MIN_CHECKPOINT_SECTIONS`, and `checkpointSectionCount(text)`;
`summarize.ts` rejects below that with a `detail` quoting the reply head, which cascades to the serialized rung. Both
regexes are module constants, and a heading resolves to one section by its first recognized word — so
`## Constraints & Preferences` counts once and a single heading can never satisfy the guard twice. Deliberately **not**
in `src`: any character or token floor, because length is provider- and language-dependent; it stays a report flag
(`degenerate-native-output`) where the threshold is a free knob. The baiting clause is also gone — `splitTurn` now says
the remainder is "kept as-is below", and the instruction adds "It is your only input: do not describe, reproduce, or
audit any reasoning, thinking, or internal process" (core leaves reasoning enabled for these calls, `compaction.js:426`).

## Stage 2's transcript cap (gap 7, open by design)

The transcript cap (then an in-code `maxChars`, now `serializedMaxTokens` plus the per-block caps) made
`serializeConversationMinimal` drop **702 message blocks** on that same run, so the persisted summary covered a truncated
view — and because stage 1 failed, the capped reduce was the *only* real input. These are independent knobs: fixing
stage 1 does not raise the cap, and raising the cap does not fix stage 1. Watch `blocks-dropped` and
`degenerate-native-output` separately in `npm run compaction-report -- --suspect`. The cap should be derived from the
window rather than from a chars/4 estimate this crude (`pipeline.md`, serializer).

## A missing cut point (gap 8, CLOSED 2026-09-06)

If `preparation.firstKeptEntryId` is not on the path, `spanContextEntries` returned everything and stage 1 silently
stopped truncating — full price, and a checkpoint overlapping the messages that survive. `spanContextEntries` now returns
`{ entries, cutFound }` and stage 1's attempt record carries `cutFound`, because no other field can recover the fact: an
uncut span and a merely long one carry identical counts, and the prefix record's `truncated` compares our message count
against a *reference's* depth, so a shallow reference prints the same shape with nothing wrong. That made
`span-not-truncated` an inference, and the report now treats it as one (the one-fact-one-flag rule again). The attempt
line prints `cut=found` / `cut=missing` / `cut=unrecorded` so a record written before the field cannot read as a found
cut.

## Children (gap 4, open)

Children have no UI (`print` mode), so every warning here reaches only the trace and the run diagnostics: a
quota-starved child looks like a normal finish with a mediocre summary.

## Also latent

`ToolInfo` hides `constrainedSampling`, which is the one place our rebuilt prefix is *not* guaranteed by construction —
fully worked out in `upstream-gaps.md`, with its detection signature and the accidental way the cause policy already
handles it.
