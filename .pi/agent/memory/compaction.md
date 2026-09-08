---
name: compaction
description: "pi-coder's two-stage compaction in src/modules/compaction — native span read then serialized reduce, the count tiers that size it, the prefix-chain instrument, the trace/report, and the failure policy. Read first for a short system prompt (12,817c), an unexpected `obs=0`, or any prefix-cache divergence: those are settled facts, not new findings."
category: architecture
priority: 4
keep_updated: true
---

# Compaction

pi owns compaction; pi-coder replaces it with one `session_before_compact` handler in
`src/modules/compaction/index.ts` (`registerCompactionExtension`), installed for the parent from `src/index.ts` and for
every child as the `pi-coder-compaction` entry in `src/tools/agent/child/index.ts:childExtensionEntries`. Read pi's
`docs/compaction.md` and `dist/core/compaction/compaction.js` before changing this; every invariant here came from
reading core, not from guessing. Returning `undefined` hands the compaction back to core.

## The pipeline, in three lines

1. **stage 1 (native span read)** — rebuild the discarded span as *real message objects* in an in-memory session and
   send it as a strict shorter prefix of what the provider already cached, so the model reads the transcript instead of
   a re-serialized blob.
2. **stage 2 (serialized reduce)** — one bounded text-only call over our own minimal serialization plus stage 1's
   `<segment-checkpoint>`, merging rather than concatenating.
3. **core default** — `undefined`, reached whenever a rung fails.

Degradation is always toward core, never toward a broken session, and nothing may throw: a defect here must cost summary
quality, never a session that can no longer be compacted. Stage 1 failing alone → stage 2 with no segment; stage 2 failing
after stage 1 succeeded → **stage 1's text is persisted** (`route: "native"`); `event.signal.aborted` → `{ cancel: true }`.

Core's design is the reason this exists: `serializeConversation` sends `[Assistant thinking]:` **untruncated**, tool
results at a non-exported fixed 2000 chars, with no overall budget, then with `cacheRetention: "none"` and a fresh
`sessionId` — so the bulk is billed as fresh input. Thinking is normally the largest block in a session, and pi keeps
thinking in the live context anyway (`hideThinkingBlock` is display-only).

## The five things most likely to be gotten wrong

1. **The request must be a prefix, so parity rules everything.** Tools stay in the request (removing them moves the
   prefix) and the no-tool-call prohibition is instruction text, because `tool_choice` is **not** sent; stage 1 forwards
   the session's thinking level as `reasoningEffort`; the model's own `samplingParams` are merged. Each removal has a
   measured reason in `compaction/pipeline.md`.
2. **Sizing is a ladder of counts, not an estimate.** `nativeRequestFits` asks `fitRequirementTokens`, which takes
   `countSpanTokens`'s best answer first — `exact-cut`, anchored (`usage-anchor`/`exact-anchor`), `head-ledger`, the
   persisted-fields rescue — and only then falls back to `ctx.getContextUsage()` and whole-body chars/4. Every count
   tier is filtered by `countBoundary` (a count predating the newest `compaction`/`model_change`/`thinking_level_change`
   row describes a body that no longer exists; rejections count as `staleAnchors`). A hot estimate alone used to skip
   stage 1 on ~200k windows. `compaction/sizing.md`, and `compaction/ledger.md` for the arithmetic tier.
3. **A `ledger`/`prefix` field that is *absent* is never `false`, `0`, or "no problem".** A declined derivation records
   no field, because `tokens: 0` reads as "this request is free" and `prefixUsable: false` reads as "the rebuild is
   misaligned". Every such field keeps "this record predates the field" separate from the negative answer —
   `unrecorded`, `undefined`, or omitted.
4. **`cached=0` is not evidence about our rebuild.** The body has been verified byte-identical to prefixes the provider
   had already served, hundreds of times over, with reuse still zero; the surviving causes are server-side. And the
   12,817-char system prompt is pi's *base* prompt — it means the compaction ran outside an active agent run, and it
   costs the cache nothing because that state has sent no request yet. Do not reconstruct the prompt.
   `compaction/prefix-cache.md`.
5. **A `length` stop answers differently on each rung, on purpose.** Stage 1 refuses one (its checkpoint is stage 2's
   input and a lost section is gone for good); stage 2 keeps it (rejecting would hand the session to core, which
   re-summarizes from scratch under no section contract). A `length` stop with *empty* text is a starved output budget,
   not a verbose model. `compaction/failures.md`.

## Configuration

`compaction-config.json`, project (`.pi/`, nearest ancestor) over global (`~/.pi/`), env-overridable with
`COMPACTION_CONFIG_PATH` / `COMPACTION_CONFIG_PATH_GLOBAL`, mirroring `src/tools/agent/config.ts`. Malformed or unknown
fields fall back to defaults, because children run this unattended. `enabled: false` returns `undefined`; core's own
`compaction.enabled: false` still wins (the event never fires). `serializedMaxTokens`, `keepThinking`, and the per-block
char caps govern stage 2; `traceEnabled`/`tracePath`/`traceMaxBytes`/`traceGenerations` govern the trace;
`chainTraceEnabled` gates the persisted chain rows that share the same file, separately because they carry no
conversation content — so history keeps accumulating while bodies are off. The verdict itself is still only recorded
while `traceEnabled` is on (`COMPACTION_CHAIN_TRACE=0`). `model` is accepted but unused — the seam for the planned
dedicated compaction model, which wants the serialized route since it has no cache prefix to protect.
`retryMaxRetries` (extra attempts after the first) and `retryBaseDelayMs` (doubling) bound the transient backoff;
`0` turns resends off entirely. Deliberately below core's agent-retry settings: this stall happens inside a turn the
user is waiting on.

**A field is only configurable once `readConfigFile()` reads it.** That function maps keys through validators into an
explicit return object, so a field added to `CompactionConfig`, the interface docs, and the loader still does nothing
unless it is also added there — "unknown fields fall back to defaults" makes the omission silent, not an error.
`retryMaxRetries` was dead for exactly one test run before `test-defaults.json` proved it: the suite slept a real second
on a backoff that was supposed to be off. Add the field to `readConfigFile` in the same edit, and let a test observe it:
`nonNegativeNumberField` keeps a `0`, `positiveNumberField` drops one.

## Trace, in one line

`trace.ts` appends one JSONL record per stage to `<pi-coder-install>/.state/compaction-trace.jsonl`, all records of one
compaction sharing an `id`; read it with **`npm run compaction-report`**, never by hand-rolling jq joins. Field
semantics, the report's suspects and `INVARIANTS`, and why one-fact-one-flag governs them:
`compaction/trace.md`.

## Validation, in one line

`npx vitest run test/modules/compaction/ test/scripts/compaction-report.test.ts` → **the whole suite, no provider calls**;
the captured live-session fixtures are the evidence for every accuracy claim, and `real-session-sizing.test.ts` is the
suite that checks against numbers a provider produced. `compaction/fixtures.md`.

## Timeline (for reading the detail files)

`git log -- src/modules/compaction/` gives the full order; the phases matter because later numbers supersede earlier ones.
**2026-09-05** — the two-stage pipeline, tracing, abort handling, `stopReason`, the cause taxonomy, whole-prompt hashing
(`obs=0` resolved the same evening). **2026-09-06** — request parity (`tool_choice` dropped, thinking level forwarded,
sampling params merged), the request chain and its persisted rows, the prefix funnel, `stageOneSpanEntries`, the cut
point, `estimate-skew` repaired. **2026-09-07** — the head ledger, the wire projection in `usage.ts`, the closing
bracket, the per-stage output cap, and the ledger-backed cut walk. Where a number was later shown to be an artifact, the
detail file says so at the number rather than silently replacing it.

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory index.
**New dated measurements and play-by-play land in the topical file, never here** — this index carries only what would
change how you edit the module.

- `compaction/pipeline.md` — stage 1/2 contracts, `stageOneSpanEntries` and the non-idempotent hoist, `Date.now()` stamp
  instability, the serializer, the summary/`details` contract, request parity.
- `compaction/sizing.md` — the count tiers and report bands, the wire projection, cut admissibility (ids, not roles),
  `cut.ts`, the stored-count rescue, the budgets behind the fit test.
- `compaction/ledger.md` — the head ledger: `P + K` as a difference of counts, the rules that were each a bug, what it
  measures on the captures, how it was wired as a tier, and the ledger-backed cut walk.
- `compaction/prefix-cache.md` — the request chain and its persisted rows, the funnel's three counts, credited-reference
  verdicts, every `cached=0` measurement, the base-prompt mechanism, the resolved `obs=0` store.
- `compaction/trace.md` — record types, field gotchas, toggles and file policy, what the report prints and flags.
- `compaction/failures.md` — the degradation inventory, cause policy and retry, and the eight-row gap ledger with which
  half of each stays open.
- `compaction/upstream-gaps.md` — what pi and pi-ai do not expose (nested core package, hooks `complete()` bypasses, no
  typed provider error, unreachable `Retry-After`, no client-side deadline, hidden `constrainedSampling`).
- `compaction/fixtures.md` — the captured pairs and what each uniquely proves, the suite, the mutation results.

Also: `docs/compaction-trace-report.md` for flag prose, `src/tools/agent/README.md` § "Changing child compaction" for the
manual checklist (tests never make provider calls).
