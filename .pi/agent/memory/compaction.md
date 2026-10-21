---
name: compaction
description: Two-stage compaction in src/modules/compaction — native span read then serialized reduce, the failure policy, and where each detail doc lives.
category: architecture
priority: 5
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

Core's design is why this module exists: `compaction/pipeline.md`.

## The five things most likely to be gotten wrong

- **The request must be a prefix, so parity rules everything.** → `compaction/pipeline.md`.
- **Sizing is a ladder of counts, not an estimate.** → `compaction/sizing.md` and `compaction/ledger.md`.
- **A `ledger`/`prefix` field that is *absent* is never `false`, `0`, or "no problem".** `tokens: 0` would read as "this request is free" and `prefixUsable: false` as "the rebuild is misaligned". → `compaction/trace.md` and `compaction/prefix-cache.md`.
- **`cached=0` is not evidence about our rebuild.** → `compaction/prefix-cache.md`.
- **A `length` stop answers differently on each rung, on purpose.** → `compaction/failures.md`.

## Targeted references

Load only the detail needed; nested documents are on-demand and not listed in the memory index.
**New dated measurements and play-by-play land in the topical file, never here** — this index carries
only what would change how you edit the module.

- `compaction/pipeline.md` — stage 1/2 contracts, the serializer, the summary/`details` contract, request parity.
- `compaction/sizing.md` — the count tiers and report bands, the wire projection, cut admissibility, the
  stored-count rescue, the budgets behind the fit test.
- `compaction/ledger.md` — the head ledger, the rules that were each a bug, how it was wired as a tier, and the
  ledger-backed cut walk.
- `compaction/prefix-cache.md` — the prefix-chain instrument: request chain and persisted rows, the funnel's
  counts, credited-reference verdicts, every `cached=0` measurement, the base-prompt mechanism.
- `compaction/trace.md` — record types, field gotchas, toggles and file policy, what the report prints and flags.
- `compaction/failures.md` — the degradation inventory, cause policy and retry, and the eight-row gap ledger.
- `compaction/upstream-gaps.md` — what pi and pi-ai do not expose.
- `compaction/fixtures.md` — the captured pairs and what each uniquely proves, the suite, the mutation results.
- `compaction/configuration.md` — `compaction-config.json` and its keys, the wiring gotcha, and the dated phase
  timeline.

Also: `docs/compaction-trace-report.md` for flag prose, `src/tools/agent/README.md` § "Changing child
compaction" for the manual checklist.
