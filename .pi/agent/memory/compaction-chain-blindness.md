---
name: compaction-chain-blindness
description: Resolved - obs=0 meant the chain store was freshly created by a reload, not a broken filter; covers what survives a reload and the diagnostic that would have shown it in one glance.
category: Architecture
priority: 90
keep_updated: true
status: resolved
---

# `observations: 0` meant a freshly created store, not a broken chain

**Resolved 2026-09-05 19:42 by the experiment below.** The same session (`01a070e0`) that reported `obs=0` at
15:27 reported `obs=97`, `reference=chain`, `prefixUsable=true`, `verified=362/362`, `divergences=[]` at 19:42.
One store therefore served 97 parent requests and then answered the compaction's prefix verdict: the hook fires,
the write and read paths share the chain, and the branch filter keeps entries it should. The three bug
hypotheses below are all dead. What was actually happening is the boring one the user proposed: an extension
reload created a fresh chain, and the compaction ran before enough parent requests had landed in it to matter
for that branch. `obs=0` is a **cold store**, and with hashes instead of bodies it cannot be backfilled from the
session file. Keep the sections below as the record of how to read this, not as an open defect.

Both items below are now closed, and the second is why this file is kept:

- ~~The first compaction after a reload, `/resume`, or restart is unverifiable.~~ **Fixed 2026-09-05 by
  persisting the chain** (`src/modules/compaction/chain-store.ts`): request rows and periodic full ladders share
  the trace file, and a chain hydrates once at creation. `chainObservations: 0` is now a statement about the
  session rather than the process, which was the whole ambiguity in the table above. The restart-durability half
  of the original brief is done; the `compaction` memory records the caps, the cadence, and why
  `LADDER_RETENTION = 2` does not need raising for long sessions.

The other item - the trace printing one number where three are needed - shipped the same evening. See
`## The prefix funnel` in the `compaction` memory for the field names and `docs/compaction-trace-report.md` for
how they read.

Read this before touching `src/modules/compaction/chain.ts`, `prefixVerdict()`, or the `prefix` trace record,
and before concluding anything about a `cache-read-zero` suspect: an empty chain means the **instrument** is
blind, which makes every cache conclusion from that run uninterpretable.

## Evidence (trace `.state/compaction-trace.jsonl`, 5 runs, 2026-09-05)

```
14:06:10 two-stage    sess=01a0714f ref=chain obs=10  sys=24619c
14:32:10 core-default sess=01a0714f ref=none  obs= 0  sys=12817c   <- same session, 26 min later
14:52:02 two-stage    sess=01a071fd ref=chain obs=13  sys=25294c
15:27:51 two-stage    sess=01a070e0 ref=none  obs= 0  sys=12817c   <- 557 msgs, 373k input, 400k ctx
19:42:41 two-stage    sess=01a070e0 ref=chain obs=97  sys=24813c   <- usable=true, verified=362/362
```

`01a070e0` is the pi-coder development session itself. It had been compacted once before 15:27 (the `final`
record says `keptFrom=3898fb95`), and between that compaction and the 15:27 one, dozens of provider requests
went out (a long implementation exchange). A chain cannot forget, and the 14:06 -> 14:32 transition happened in
**the same session id**, so the store was replaced or the read path rejected what the write path kept.

## The argument that misled me

I wrote this, and it is valid and useless at once:

> One observation is sufficient. `RequestChain.observe()` stores the *cumulative* ladder of the request, so a
> single `before_provider_request` after any reload covers every prefix depth the compaction needs. `obs=0`
> therefore requires that **zero** parent requests were observed, not merely that the process was young.

The premise and the inference are both right - `obs=0` does require zero observations. What I got wrong was the
close: I treated "a reload cannot explain this" as "a reload did not do this", and concluded the reload story was
refuted when it was only constrained. The reload explanation needed one more link to be airtight, and that link
was sitting in the same records unexamined: the 12,817-char system prompt, which only occurs *before the first
turn of a process*. `observations: 0` and a base-only prompt are two views of one event, and the second one dated
the first.

Sufficient does not mean present. When a piece of reasoning rules an explanation out by requiring it to be more
specific than the evidence, the fix is to go find the field that makes it specific - not to keep reasoning.

## Candidate mechanisms, cheapest to rule out first

All three below are dead, and the 19:42 run killed them: 97 observations were held, on the branch, and
comparable, from the same store the compaction handler read. So the hook fires, write and read share the chain,
and the branch filter keeps what it should. What remained was the cold store.

1. **The branch filter rejects entries that exist.** `match()` keeps an observation only when its recorded
   `leafId` is in `pathIdSet(sessionManager.getBranch())`. If `getLeafId()` returns null, or returns an id that
   is not on the branch pi reports *after* a compaction entry exists (pi may re-root or the walk may stop at the
   compaction), every entry is filtered and `obs=0` while the chain is full. Test by printing the two counts.
2. **Write and read use different `SessionManager` objects.** `requestChains` is a `WeakMap` keyed on the object
   identity of `ctx.sessionManager`. If the `before_provider_request` ctx carries a different facade than the
   `session_before_compact` ctx, the two never meet - and that needs no reload at all.
3. **The hook genuinely does not fire** on the loaded instance (registration or reload lifecycle). Would also
   explain a total of zero.

## Diagnostic that shipped (same day), with one field dropped

What went in is a four-level distinction rather than three fields: `chainObservations` (held),
`branchObservations` (leaf on the current branch), `observations` (comparable - same system prompt and tool set),
`parentRequest` mirroring `ourRequest`, `unknowns[]`, four funnel suspects, and an `INVARIANTS` section. The
plan's `chainSession` was dropped: it existed to separate candidate 2, which the 19:42 data killed.

The reason one number was not enough is in `chain.ts`: the `observations` the record printed was
`ChainMatch.compared`, which is already shape-filtered. An empty chain and a request whose prompt differed from
the parent's therefore looked identical, and only one of them is a bug.

Original notes, kept as history:

Three fields on the `prefix` record, no behaviour change:

- `chainObservations` - entries held, unfiltered (next to existing `observations`, which is on-branch only).
- `chainSession` - the session id the chain was created for.
- `newestLeafId` (or a boolean `leafOnBranch`) - what `getLeafId()` returned at observe time vs membership in
  `pathIdSet(getBranch())` at match time.

Total vs on-branch separates 1 from 2/3; the leaf fields separate 1 from 2. `scripts/compaction-report.ts`
already tolerates absent fields (older builds), so add the display as `obs=<on>/<total>` and update the handful
of report tests that assert the `obs=` substring. The healthy fixture (`test/fixtures/compaction-trace.healthy.jsonl`)
has no `chainObservations`, so its golden `observations=13` stays valid.

## If it turns out to be identity-scoping (candidate 2)

Key the chain by `sessionManager.getSessionId()` in a bounded map, and decide separately whether to persist
ladders to `.state/` (~70 bytes per request) so verification survives reload, resume, and restart.
Restart-durability was in the original brief for the chain; the implementation got branch-correctness only.
Persistence is a decision about what stays on disk, so ask before doing it.

## Related open items in this area

- A compaction sent right after a reload has no chain no matter what the keying is, unless ladders persist.
- Our summarization requests have **no client-side deadline**: `ModelRegistry.complete()` does not traverse the
  `sdk.js` wrapper that injects `timeoutMs`. Observed stage times 62.2s and 32.2s, so this is live territory.
- Do not conclude "cache miss" from `cache-read-zero` on a run where `observations: 0`.
