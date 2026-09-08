---
name: fixtures
description: "The captured-live-session fixtures and the suites that read them: the trace-helper contract, what each pair uniquely proves, the test inventory, and the mutation results that justify each guard."
category: architecture
keep_updated: true
---

# Compaction fixtures and validation

Detail companion to the `compaction` memory.

## Read a trace fixture through `test/helpers/compaction-trace.ts`, never `readFileSync`

`openTraceLog()` gives the reader `scripts/compaction-report.ts` uses (`createJsonlRecordLog` +
`discoverGenerations`, `maxBytes: 0`), so segment naming, oldest-first ordering across rotations, torn-line tolerance
and `v` normalization behave as they do in the report. `sessionIdOf()` asks a session file for its own id;
`loadCapture({sessionFile, traceFile})` returns `{sessionId, manager, branch, records, foreignRecords}` with the
records **filtered to that session**; `nativeAttempts`/`chainRequests`/`prefixRecords`/`providerPromptTokens`/
`requireAttemptForFold` are the typed selectors. Two defects this ended: three suites hand-rolled
`readFileSync().split("\n")` (a rotated fixture silently lost its oldest runs, a torn line threw instead of counting a
gap), and the ledger's capture test read the **live** `.state/compaction-trace.jsonl` — five sessions in one file, no
filter, machine-local absolute paths, so it was neither portable nor reproducible. **`.state/` is never a test input:
commit the pair.**

## The captured pairs

`hosted-live-ledger.jsonl` + `compaction-trace.hosted-live-ledger.jsonl` — the **live-tier pair** (2026-09-07):
session `01a07b63`, 135 branch rows, three folds at rows 81/128/135, 55 trace records plus three foreign
`chain_request` rows. It is the only fixture written by a build that had the ledger tier, so it is the only one whose
attempts carry real `ledger` fields — which is what `test/scripts/compaction-report.test.ts` pins the report's
`ledger=` print, `LEDGER` aggregate and `--json` against instead of a synthetic record. It holds shapes the first pair
does not: two runs sized by `head-ledger` rather than shadowed by it (`stale=13`, `stale=3`), a reply the user
**cancelled** (`stopReason: "aborted"`, all-zero usage, refused as an anchor), a six-message window with an older
checkpoint riding inline (890 estimated tokens), and a fold at the tip whose head is therefore unsolvable — all
enumerated with their numbers in `ledger.md`, "Live measurements". Its recorded
`ledger` numbers are the **pre-closing-bracket** build's, deliberately: the fixture is a historical record, and
`ledger.test.ts` pins both sides of that change from it.

`hosted-head-ledger.jsonl` + `compaction-trace.hosted-head-ledger.jsonl` — the **head-ledger pair** (2026-09-07):
session `01a078c2`, 216 branch rows, three folds, the first capture from the build carrying the `stageOneSpanEntries`
ordering fix, and 85 trace records (3 runs, 63 chain rows). It exists to be the evidence for `ledger.ts` — every number
in `ledger.md` comes from it — and its trace fixture deliberately keeps **four `chain_request` rows of a second
session** (`01a07721`, which carry no conversation content) so the session filter is a tested property of the pair:
`loadCapture().foreignRecords` must be 4, and an unfiltered read of the same file must see more chain rows than a
filtered one. A fixture with no foreign rows cannot show that the filter ran. `ledger.test.ts` opens with the gate that
earns the rest (one shape, verified prefixes, clean cuts) and fails loudly rather than skipping when a capture cannot
vouch for the arithmetic.

`hosted-three-folds.jsonl` + `compaction-trace.hosted-three-folds.jsonl` — the **first multi-fold pair**, recorded
2026-09-06 from one live hosted session (308 branch rows, 3 folds at rows 128/137/294) whose runs the counting build
itself produced (123 records: 3 runs, 102 chain rows). Provider and model strings stay raw — the file is read,
never replayed, so no test depends on a machine's provider config. `fold-chain.test.ts` reproduces the recorded
`estimateSource`, `staleAnchors`, and `cutMoved` fields **from the session file alone**, so the two artifacts vouch
for each other the way the llama.cpp pair does. What it uniquely proves:

- **The fold guard earned its keep on real data.** Fold 2 had three counted replies land after fold 1 — so "a live
  count exists" was true — but all three sat **below** the boundary in the retained tail, so the span above it held only
  pre-fold counts. Anchoring on the nearest one sizes a 14,830-token request as 55,874 (**+277%**), which is the
  direction that reads as a provider clip inside a 15% band and, on a small window, skips stage 1 outright. Scope
  lesson: the session is the wrong question, the span is the right one.
- **`exact-cut` on a second provider.** Two of the three folds sized the request within **0.08%** of what the hosted
  endpoint charged (`49,717` vs `49,679`; `54,798` vs `54,748`) — every prior number in this memory came from llama.cpp.
  Run 1 also served 49.2k of 49.7k from cache on a hosted route (`reuse=87%`).
- **`stale=` coexists with success.** Fold 3 rejected 22 expired counts and still produced an exact number, because the
  boundary row was itself post-fold. The field counts rejections, never trouble.
- **No `cutMoved` in *this* fixture, and that reading was taken too far.** These three folds used core's boundary, which
  is why the note said the repair path was unexercised in the wild — but the trace had already recorded five moves
  elsewhere the same evening, and it has seven now (see `ledger.md`, "The ledger-backed cut walk"). The small-window route
  the note said you needed to force one is real: two of the seven are the local 200k model.
- **`first=messages[2]` was a real defect, and it had been written off.** This file called it a standing false alarm on
  second-and-later folds; that reading was wrong. The body sample added to the chain named it in the first session that
  diverged (`at messages[2] ours=user/4902c/e8332c11 pi=user/13368c/f7830572`): same role, present on both sides,
  different index. The cause and the fix are in `pipeline.md`, "Stage 1's span window".

`hosted-cut-before-checkpoint.jsonl` — the second real session needed because `hosted-three-folds` cannot reach the
missing-checkpoint shape: its two fold rows both fall inside the window.

`llamacpp-post-compaction.jsonl` is pi's own output: a 51-entry branch carrying a `compaction` at its tip
(`firstKeptEntryId: 3162e48e`), with the `custom_message`, `model_change`, and `thinking_level_change` entries no
hand-built branch in this suite has. `test/modules/compaction/session-fixture.test.ts` replays that tree through the
span builder and pins what the live run recorded in the trace beside it (28 entries copied, 17 messages, nothing
skipped — and the replay's `messageCount`/`copiedEntries` must equal the captured `attempt`'s), so the two fixtures
vouch for each other and a change to slicing, copying, or message conversion trips the golden head hash
`2d54d1ca019d4841`. **Slice the branch with `getBranch()`, never `buildContextEntries()`**: the latter answers with pi's
post-compaction view, which has already folded that history into a summary.

`test/fixtures/compaction-trace.healthy.jsonl` — one real llama.cpp run, **captured raw** (re-recorded 2026-09-06 from a
fresh session on the credited-reference build): 20 records, one run's `prefix`/`attempt`×2/`model_response`×2/
`final_summary`/`outcome` plus 13 persisted chain rows, real `cwd`, real session id, real provider name normalized to
`llamacpp` (the alias one machine's provider config uses is not a fact about pi's shape), and the two stage texts. The
earlier fixture was a sanitized five-record extract with synthetic text; the raw capture replaced it because the chain
rows and decode scalars are now part of what a healthy run must show, and because rebuilding stage text from records is
behaviour worth pinning. Used by `test/scripts/compaction-report.test.ts` for "what healthy looks like": `usable=true`,
`verifiedTo=18` at `comparableDepth=18` against `referenceDepth=31`, `parameters: []` — no key added, none dropped —
**zero flags**, `referenceSource: observation`, `otherDisagreements: 0`, and `chainRows` counted outside the run total.
Two lessons it encodes: keep `--json` field names equal to the record's own names, and never let a flag fire because a
record was **absent** — that is what a rotated or trimmed log looks like, not an empty model answer. The second no
longer lives in this fixture (it now contains every record type); it is carried by the synthetic cases at "separates an
absent reference from an unusable one" and the old-build tolerance test.

## The suite

`test/modules/compaction/{budget,chain,chain-store,config,cut-invariants,cut-selection,cut-shapes,fold-chain,handler,ledger,native-sizing,prefix-diff,prompt,real-session-sizing,sections,serialize,session-fixture,span-session,summarize,trace}.test.ts`
plus `test/scripts/compaction-report.test.ts` — the full suite (verified 2026-09-08), two reviewed file
snapshots, no provider calls. `createCompactionHarness()` in `test/helpers/compaction-doubles.ts` records the contexts
and options a `stubModelRegistry` receives, and `evaluateSummarizationResponse` is pure so the accept/reject policy is
testable directly. Stage-1 truncation is pinned by a 1.2M-char *retained-tail* fixture: if someone re-sends the live
context, the fit gate skips stage 1 and that test fails.

- `real-session-sizing.test.ts` is the one sizing suite that checks against numbers a provider produced rather than ones
  a fixture claims — `llamacpp-post-compaction.jsonl` carries 12 counted assistant turns, each an exact measurement of a
  body this module can rebuild, so a sizing change can fail against a tokenizer. **Read it before trusting any accuracy
  claim in this memory.**
- `cut-shapes.test.ts` is the readable catalogue of cut shapes (located **by role pair, never by index** — the recorded
  session's branch order is its parent chain, not its line order, and hard-coded positions found the wrong rows while
  still passing arithmetic).
- `cut-invariants.test.ts` is the property version: 8 fixed seeds plus 3^5 exhaustive short sequences, and every ordering
  of a three-row alphabet with a fold spliced at each position.
- `cut-selection.test.ts` is the repair walk's arithmetic: a nine-row branch with known counts on both sides of every
  boundary, one case per rejection condition, a monotonicity sweep over tightening windows, and the post-fold
  counterfactual pair (same branch, `sizer: null` abstaining with `count-expired`/`not-a-countable` tallies versus
  `sizer` repairing to `a1` at 4,900 on `basis: "ledger"`, every number a provider count off the fixture's own table).
- `native-sizing.test.ts` "the head ledger tier" (answers when a fold expired every count, outranks the rescue, leaves a
  live anchor alone) and `ledger.test.ts` "what the ledger declines to size" (unknown cut, inverted window, nothing
  counted, estimated share, shape change). The stage-1 request identity runs through `spanBodyTokens` over the branch
  *as it stood at request time*; `trace.test.ts` covers the shadow record, that a declined derivation records no field
  rather than a zero, `cutLiveTokensSource: "ledger"` with `getContextUsage()` null, `unmeasurable-live-context` still
  named when neither instrument answers, and the chosen case's `tail === live - span` relation. `ledger.test.ts` also
  pins `spanSizer` and `spanBodyTokens` agreeing position-by-position over the real capture, which is what makes the
  prefix walk's equivalence a measurement rather than a claim.

## Mutation results worth keeping

Reverting the fit formula to `reserveTokens` fails the sizing test; deleting `trace.modelResponse(...)` fails two trace
tests; forcing `cutFound: true` in the stage-1 fields, or `cutMissing = false` in the report, each fails exactly one of
the two cut-point tests; disabling the anchored branch of `fitRequirementTokens` fails both sizing tests and the handler
case where the span fits but the live context does not. From the sizing pass: charging stored rows instead of the wire
shape fails 3, dropping the `countBoundary` filter fails 3, disabling the exact-cut tier fails 5, widening the 5% band to
50% fails 1, and ignoring `skippedEntries` when offering the kept entry fails 1 — the last of which it did **not** do
until a test was written for it, because the guard had no coverage at all when the mutation was first tried. From the
cap pass: handing the reduce stage 1's reserve back fails exactly one test — the 43 handler cases otherwise pass on a stub
whose `model.maxTokens` is small enough to bind both asks, which is what made the shared number invisible for so long, so
**a cap test has to put the two bodies on opposite sides of the ceiling.** From the cut-walk pass: dropping the sizer
from the walk's input fails 1, ignoring it inside `measureSpanAt` fails 3, preferring it over a live count fails 1,
deleting the report's `cut:` line fails 1 — and deleting `measureSpanAt`'s window check fails **nothing**, which is
recorded in `ledger.md` rather than deleted.

The cut repair was mutation-checked with seven killings, all of which landed: persisting core's boundary instead of ours
(1), building the span from core's boundary (1), no walk at all (7), allowing a *later* boundary (5), dropping the orphan
check (5), ignoring the keep budget (1), and restoring the old unconditional `overflow` skip (2). Two of those seven
taught something: the first draft of the persist test asserted a relationship against itself (`sent < sent + 1`) and
would have passed no matter what, and it then failed for the right reason once written properly — the harness's default
fixtures carry `zeroUsage()`, so **a test about count-driven cuts has to supply counts**.

**The fuzz caught itself being vacuous, which is the lesson worth keeping:** the first version survived three of four
mutations (ignoring `countBoundary`, dropping the assistant-type check from the exact-cut tier, and losing the
instruction term) because its boundary assertion only ran *when* the result was null, every probe passed
`extraTokens: 0`, and no generated branch ever contained a metadata row at the cut. Rewritten as a pair of directions
(admit what is after the boundary, reject what is not) with non-zero instruction terms and metadata rows spliced at every
position, each of the four now fails exactly one test. **A property test that cannot be killed is not a property test.**

**Gate fixtures need margin, not coincidence**: the "span plus instruction will not fit" case sat within ~130 tokens of
its own threshold, so the projection improvement made it fit and the test read as a sizing failure. It now pins a window
that leaves far less room than the request needs, with the arithmetic in the comment.

Real provider behavior (no-tool-call instruction adherence, cache serving, `toolCall` refusals) and child execution stay
manual — see `src/tools/agent/README.md` § "Changing child compaction".
