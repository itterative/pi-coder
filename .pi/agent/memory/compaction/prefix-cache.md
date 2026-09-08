---
name: prefix-cache
description: "What is settled about prefix-cache reuse: the request-chain instrument (hashes retained, bodies dropped, persisted), the prefix funnel's three counts, one-reference verdicts, cached=0 readings, the 12,817-char prompt, and the resolved obs=0 store."
category: architecture
keep_updated: true
---

# Compaction prefix cache and the chain instrument

Detail companion to the `compaction` memory. **Read here before theorizing about a system-prompt divergence, an
unexpected `obs=0`, or a `cache-read-zero` suspect.**

## Settled, in one breath

- The rebuild is a genuine shorter prefix of what the provider cached, verified byte-for-byte against the provider's
  own requests (`verified=649/649` on one hosted route, `362/362` and `19/19` elsewhere). When reuse still reads
  zero, the cause is server-side, not ours.
- A 12,817-char system prompt is pi's **base** prompt and means the compaction ran outside an active agent run; it
  costs the cache nothing and is not a rebuild bug. Do not reconstruct the prompt.
- Memory edits do not break the cache mid-session — the index is frozen per session. Measured false, 2026-09-05.
- `obs=0` / `chainObservations: 0` describes the instrument, not the request. On a run where the chain is empty,
  every cache conclusion from that run is uninterpretable.
- Local llama.cpp reports reuse and loses it with size (per-slot eviction between turns); the hosted endpoint reports
  a hit at ~30 KB and nothing at ~330 KB.

## The request chain: hashes retained, bodies dropped

`chain.ts` replaced the parent-body capture. `index.ts` keeps `WeakMap<sessionManager, RequestChain>`, and
`before_provider_request` calls `observeParentRequest()`, which folds a cumulative head over `body.messages` and then
**drops the body**:

```
head(0) = sha256("pi-coder/compaction-chain/v1")
head(k) = sha256(head(k-1) + 0x1f + JSON.stringify(messages[k-1]))   truncated to 16 hex
```

One observation per provider request: `{leafId, depth, head, systemHash, toolsHash, systemChars, keys, model,
toolNames?}` — `toolNames` only when the shape changed — plus the **whole ladder** for the newest two requests
(`LADDER_RETENTION`). The retention is not an optimization: a truncated span is shallower than every request pi made
in a resumed process, and the first llama.cpp run after this shipped had ten observations at depths 70-87 against a
64-message span, so nothing was comparable and the code called that `usable: false`. Only per-request records can
localize a mismatch; only a ladder can say anything at all about a short span. About seventy bytes where a body was
one to two megabytes, so the cap (`MAX_OBSERVATIONS`) is a memory bound rather than a correctness one, and dropping
the oldest only costs resolution on depths compaction passed long ago.

**Persisted, so those numbers describe the session rather than the process** (`chain-store.ts`, 2026-09-05). Every
request appends a `chain_request` row to the trace file, and a `chain_ladder` row lands when depth has grown by
`LADDER_DEPTH_GROWTH` or as soon as the shape changes. Hydration runs once per chain at creation, reading
segments newest-first and stopping at the first whose `mtime` predates the session's first entry; rows already held
are skipped, which is what keeps a second chain over the same session id from counting requests twice. Two
consequences: `MAX_OBSERVATIONS` is now also the *restore* window, and `LADDER_RETENTION` does **not** need
raising for long sessions — ladders are cumulative and nested, so one retained ladder at depth N already carries a
head at every depth ≤ N, and the second slot exists for shape churn rather than length. A row caps at
`MAX_LADDER_HEADS` depths. Raise the retention only if a live trace shows `chain=N/N/0` (branch entries, none
comparable) with shapes alternating.

`chainObservations` used to be `observations: 0` and used to mean "this process is young" (reload, `/resume`,
restart). Persistence narrowed what the number can claim: `chainObservations: 0` now means **no readable row for this
session survived in the retained trace file** — not the same as "never recorded", because persistence may have been
off, the rows may have rotated out of the window, or the session predates this build.

Four consequences, each learned from a real trace:

- **Branch-correct by construction.** `match()` filters observations to leaf ids on `getBranch()`, so a request
  captured on a branch that was navigated away from cannot be chosen as a reference.
- **The span ladder excludes our appended instruction.** `prefixVerdict` folds `messages.slice(0, -1)`, because
  `buildNativeContext` adds exactly one message no reference ever sent. Folding it would guarantee a mismatch at our
  own last depth. That is the same trap the body-to-body diff hit: its `div=messages[42] (assistant), rewind` record
  was first explained as a stale-branch artifact, but was our instruction sitting where pi had a real assistant
  message, and the collapse rule that should have forgiven it required exactly one divergence while the non-content
  `rewind` label made it two. Corrected here so the wrong story does not outlive the code.
- **`prefixUsable` is omitted, never `false`, when no reference exists.** "Could not tell" and "misaligned" were one
  value, and a cold process after a restart read as a broken rebuild. The record carries `reference: "none"` and
  `firstDivergence: "no-reference"`.
- **Comparing at the *reference's* depths makes tail-awareness unnecessary.** Our body is the span plus one appended
  instruction, and every reference depth is at or below the span, so the instruction is never inside the window being
  checked. The `truncated && divergence-at-our-last-message` special case that the body-to-body diff needed is gone
  from `src`; `diffRequestPrefixes` no longer exists.
- **The system prompt must be hashed whole.** `requestShape()` hashes raw text while the human-facing
  `fingerprintPayload()` keeps a 320-char excerpt, because a 24 KB prompt differing only at character 9000 is exactly
  the drift an excerpt would hide.

Cost is a full re-hash per request (single-digit milliseconds on an 880-message body) and is gated by tracing being
on. Nothing here gates compaction: stage 1 is built and sent identically whether or not any observation exists.
`parameters[]` survives as a set difference over body keys, which keeps the "an extra body key is a parameter, not a
verdict" lesson expressible without retaining a body.

## The prefix funnel: one quantity, three names

Each zero has a different cause and the old single `observations: 0` could not tell them apart:

- `chainObservations` — entries held, unfiltered, including rows restored from disk (a floor: the scan stops once it
  holds a ladder and enough requests, and `unknowns[]` says when it did).
- `branchObservations` — entries whose recorded leaf sits on the current branch.
- `observations` — entries that additionally share our system prompt and tool set (`ChainMatch.compared`).

The reason one number was not enough is in `chain.ts`: the `observations` the record printed was
`ChainMatch.compared`, which is **already shape-filtered**. An empty chain and a request whose prompt differed from
the parent's therefore looked identical, and only one of them is a bug.

`parentRequest` mirrors `ourRequest` with the newest on-branch entry's shape (model, `systemChars`, `systemHash`,
`toolsHash`, depth, leaf id) whether or not it was comparable, so a prompt or tool-set difference between our rebuild
and pi's live requests is a field comparison instead of an argument. `unknowns[]` states what the record cannot
answer, and the report prints those as `~ cannot tell:` lines apart from flags: a flag describes the run, an unknown
describes the instrument. `scripts/compaction-report.ts` adds four suspects from the funnel (`chain-empty`,
`chain-off-branch`, `chain-incomparable`, `system-prompt-drift`) and an `INVARIANTS` section of cross-field checks —
`reference=none` with entries on the branch, an empty chain reporting branch entries, a usable verdict with no
comparable depth, matching hashes over differently sized prompts, comparable observations with none on the branch. A
violation there means the trace is lying, and it must be believed before any cache conclusion is.

Naming rule for future fields: the trace record and `pi_coder_debug` must use the **same key** for the same quantity,
or the ambiguity this pass removed comes back through a second surface. See `docs/pi-coder-debug-tool.md`.

**The instrument names the gate, not the conjunction.** `obs=0` was ambiguous between "nothing on the branch" and
"the shape filter rejected everything on it", and the suspect asserted *both* halves — on the 10:23 run, where
`toolsHash` was identical across three processes and only the prompt moved, that pointed at a tool-set change that
never happened. `compareObservation` knows which predicate fired and reports only a comparison, so `prefixVerdict`
counts rejections per gate (`rejectSystemHash` / `rejectToolsHash`, non-exclusive, printed beside the funnel) and every
sentence that used to presume derives from those counts: the run line shows `rej=4sys/0tools`, `chain-incomparable`
prints the counts, and `prefix-uncomparable` stays silent when the shape gate emptied the funnel because that cause is
already named — two flags for one fact is how a reader debugs the wrong one. `incomparable-without-rejection` is the
invariant for the state `compareObservation` cannot produce: an emptied funnel neither counter accounts for. Records
predating the counters print "(record predates the rejection counters)" rather than having a cause inferred for them.

## A verdict names one reference

A live record read `verified=728/728, usable=true` and `firstDivergence: messages[59]` at once, and both were "true"
— because `match()` folded `max(verifiedTo)` and `min(firstMismatchDepth)` across every comparable reference: every
on-branch observation *and* every retained ladder. A stale ladder left from before an earlier compaction is still on
the branch and still the same shape, so it can disagree at 59 while the live prefix agrees through 728. Two
measurements, one label. It also meant the shallowest stale row could pin the printed divergence for the rest of a
session.

Now each reference is compared alone (`compareLadder`, `compareObservation`) and one is credited: deepest agreement
first, then widest coverage, then an observed request over a derived ladder, then newest. The credited reference
supplies `verifiedTo`, `comparableDepth`, `firstMismatchDepth`, `parameters`, `modelDivergence` and the `parentRequest`
mirror; the losers are counted in `disagreeingReferences` rather than dropped. Cumulative heads give the invariant the
report now checks: **inside one reference a mismatch is always deeper than its agreement**, so
`firstMismatchDepth <= verifiedTo` means the instrument merged references again. An earlier draft of the tie-break
preferred a reference with *no* mismatch, which quietly handed the verdict to the shallowest row and hid the mismatch
that was the point of the run. Coverage wins; clean-ness does not.

**Values, not just key names.** `keys` and `parameters` can only report a body key one side sent, so pi's
`enable_thinking: true` against our `false` printed as agreement — key sets caught that case only because the effort
key was absent. A fix that added `max_completion_tokens: 4369` vs `512` would have been invisible. `ChainShape` now
carries four content-free scalars — `maxTokens`, `enableThinking`, `reasoningEffort` (top-level, chat-template kwarg,
or Anthropic's `effort`), and `imageBlocks` — mirrored onto the persisted row, restored as `null` when an older row
never recorded them, and compared by `decodeDivergences` in `index.ts` into `divergences[]`. They are deliberately
**not** part of `shapeKey()`: a thinking toggle or an image count has to stay comparable, because "these differ in a
parameter that moves the prefix" is a diagnosis and "we cannot compare them" is a shrug.
`max_completion_tokens` is recorded but never flagged — stage 1's cap is the design, not a defect. A reference that
recorded *no* cap at all came from a build that recorded no scalars, which is stated in `unknowns[]` as `decode values
unknown: ...` rather than left to read as agreement; that every real body carries an output cap is what makes the
absence diagnosable instead of merely suspicious. An image-count difference is the only route to seeing pi's per-turn
rewrites at all: `blockImages` replaces every image block with a placeholder and the `context` event lets other
extensions rewrite messages, neither of which is readable from the extension API. Count plus `messages[k]` is the
diagnosis; the count alone is nothing. Recording a few scalars on both the chain row and `ourRequest` is the follow-up
`cutFound` should be grouped with.

## Reading `cached=0`

**The short prompt.** A prompt of **12,817 chars** is pi's base prompt — pi's own instructions plus project context
plus the frozen memory appendix, which is why it was byte-identical across two different sessions. The ~24.6-25.3k
values are that plus the blocks `before_agent_start` installs, which vary by session (`<delegated_agents>`,
`<todolist_system>`, `<scratchpad_system>`, `<bash_sandbox>` and the per-session scratchpad path), which is why they
differ from each other by a few hundred chars. Two unrelated sessions growing by a near-identical block (+11,802 and
+11,996, `toolsHash` and the frozen memory index unmoved) is what made this look like a duplicated prompt; nothing was
duplicated. It means the compaction ran **outside an active agent run**; the live turns of these sessions carry ~24.8k.
Two corollaries, read off the code rather than inferred from a trace:

- pi holds **two** prompt fields — `ctx.getSystemPrompt()` reads `agent.state.systemPrompt`
  (`core/agent-session.js:596-598` via `:1923`), while the request path uses `_systemPromptOverride ??
  _baseSystemPrompt` (`:286`). The override is set at `:902` and cleared in the `_runAgentPrompt` finally at `:753`,
  but `state.systemPrompt` is only written back to base at `:908` (a turn whose handlers returned no override) and
  `:1779`, so the accessor and the request path can disagree, and a compaction not inside a run sees base.
- **The base prompt is not a prefix of the override.** All five pi-coder `before_agent_start` handlers insert at the
  same interior anchor `</project_context>`, so the later handler lands *earlier*: base head, `<bash_sandbox>`,
  `<delegated_agents>`, `<todolist_system>`, `<scratchpad_system>`, `<memory_system>`, then pi's base tail
  (`<available_skills>` + the cwd line). Only the head up to the anchor and the tail survive, so "re-send base plus
  our blocks" cannot reproduce a live turn's bytes — and `buildSystemPrompt` is not exported, so base is not
  re-derivable from what we hold. Do not propose reconstructing the prompt on the strength of a size delta. The
  scratchpad path inside `<scratchpad_system>`/`<todolist_system>` is **session**-stable, not per-load
  (`restoreOrCreateScratchpad` replays the `pi-coder:scratchpad` entry), so it is not a cross-restart cache problem
  either.

**The short prompt does not break the cache, and this was worth being wrong about.** "The system prompt is the front
of the cache key, so a 12 KB difference at byte zero costs the reuse" forgot that the same state that produces the
short prompt is a process that has sent **no request yet**. There is no cached prefix to invalidate. So `cached=0` on
a cold-process run is the expected reading, not evidence about the endpoint, and the only cost of the short prompt is
that the summarizer is missing extension blocks it would normally see — 12 KB cheaper, and no reason to reconstruct
anything. The pairing is exact: `obs=0` and a short prompt occurred together in all five records because both are the
first-request state, not because one caused the other. What makes that a certainty rather than a guess:
`reference: "none"` is only reachable when the chain holds nothing on the current branch, so the alternative reading —
a full chain whose entries were all filtered out by a system-prompt shape mismatch — was excluded from the stored
fields. The report prints and checks that distinction (`chain=held/branch/comparable`, plus an `INVARIANTS` section)
instead of leaving it to be derived from `chain.ts`.

**Memory edits do not break the cache mid-session — measured false on 2026-09-05.** The memory index is deliberately
frozen: `session_start` restores it from the `pi-memory:memory-index` custom entry in the session file instead of
rescanning the directory (`src/modules/memory/index.ts:150-177`), and the session file in question holds exactly **one**
such entry, written at 09:22:40 with 14 project + 6 user memories — which is why the index in a live system prompt may
not list a memory file that exists. Adding, editing, or deleting a memory changes the prompt for the *next new
session*, not for this one, and not on `/reload` or `/resume`.

**Why the trace could not see the prompt jump at all:** `ourRequest.systemHash` used to hash a 320-char excerpt
(`EXCERPT_CHARS`) with FNV-1a-32, so `6e84662c` was reported unchanged across 12817, 24619, 24813 and 25294 chars. It
now hashes the whole system text, the same quantity `requestShape()` hashes, so a recorded hash can be joined to a
retained shape without translation. `hashes the whole system prompt, not the printed window` in
`test/modules/compaction/prefix-diff.test.ts` pins both halves, including that the summary and the shape agree.
**Records written before that change cannot support any conclusion of the form "the system prompt did not change".**
The ladder heads that `verified=N/M` rests on are sha256 over messages and never had this weakness.

**One live exception still unexplained:** a run at 14:20:29 on session `01a070e0` reported `sys=12817c` with
`parent-sys=12817c` and a chain holding 374 rows, minutes after the 11:31 run reported 24813. "Short prompt means a
process that has sent no request yet" fits a cold process, not a live 236k session whose recent requests also carry
the short prompt. Check whether a manual `/compact` resolves the prompt outside an active agent run before treating
either reading as settled.

### Measured reuse, by route

- **llama.cpp local (`qwen3.8-27b`), two-stage confirmed**: stage 1 truncated to the span accepted with
  `usage: { input: 766, cacheRead: 31885 }`, and the `prefix` record showed why: identical `systemChars` (24,619),
  identical `toolsHash`, 42 leading messages byte-identical, parent body 64 messages vs our 43 — a real shorter
  prefix, served from cache, for ~2% of the tokens fresh. Stage 2 cost 6,497 fresh with no cache, which is correct
  for a one-off. Whole compaction: ~7.3k fresh tokens.
- **First clean live verdict** (2026-09-05, llama.cpp, fresh session, recorded while stage 1 still sent
  `tool_choice`, which is why `params=+tool_choice` appears):

  ```
  prefix      reference=chain  usable=true  verified=19/19  obs=13  first=verified  truncated  params=+tool_choice
  native      accepted  in=3854  cached=23.9k   out=2513   msgs=18  copied=29  est=29.5k  rep=50.9k   70.8s
  serialized  accepted  in=4036  cached=0       out=4674   ser=6816c  dropped=0  seg=5802c  prev=0     88.4s
  final       5411c via=serialized  keptFrom=cb008170  before=50.9k  summarized=18
  ```

  What each number licenses: `verified=19/19` **from a cold process** proves the retained-ladder design, not just the
  rebuild — no body was held, thirteen observations on the branch answered, and the span matched all of them; 86%
  cache reuse on stage 1 (3,854 fresh of 27.7k) is the two-stage design paying for itself on local hardware, and the
  fresh part is the instruction we append, which is the intended shape; `cached=0` on the reduce is expected and cheap
  (different system prompt, no tools, one message, 4k tokens), not a regression. `estimate-skew: -42%` **meant
  nothing and cannot fire there**: it compared our estimate of the request (29.5k) with pi's count for the whole live
  context (50.9k) — two different bodies once the span truncates, which is why the same healthy pipeline printed -42%
  here and +21% on a hosted run. Against the provider's count for the request it sized (3,854 + 23.9k = 27.8k) the
  estimate was 6% high, inside the noise.
- **Hosted `qwen-token-plan/qwen3.8-flash`**, 572-message session, 1M window: an earlier full-live-context design
  recorded `input: 330054, cacheRead: 0` while ordinary turns in that session report `input ≈ 1k, cacheRead ≈ 330k`.
  Sending the whole live context (retained tail included) was the wrong call; truncating at the cut point is the fix,
  and cost is now bounded by stage 2's `serializedMaxTokens`. The 19:42 run on that session is the one
  clean hosted data point and the answer to the question that started this work: 97 parent requests observed in that
  process, our rebuilt stage-1 prefix verified identical to the provider's own for all 362 comparable messages,
  `prompt_cache_key` and `prompt_cache_retention` on the wire — and `cached=0` across 222,167 fresh tokens. Either
  that endpoint does not reuse prompt cache or it does not report the reuse. **Updated 2026-09-06: it does report
  reuse, so "does not report" is off the table** — a later hosted run (10:23, same session) returned `cached=4096` on
  26.6k fresh tokens. The question narrowed from "does it cache or does it report" to "it reports a hit at 30 KB and
  nothing at 330 KB" — a size or window threshold, not a silent endpoint. Read a hosted `cache-read-zero` as that
  question, never as proof about our own prefix.
- **A verified long prefix with `cached=0`: reuse is not ours to give (2026-09-06).** The 10:16:21 run on session
  `01a070e0` printed `usable=true verified=649/649 obs=300 first=verified truncated`, and reported `cached=0` against
  347k fresh tokens. Our body was a byte-identical prefix of **300** requests that route had already served, with no
  divergence anywhere in the overlap, and the server still read it cold. Nothing about the rebuild — not its length,
  not its shape, not which parts we drop — can account for that, so stop looking for a body-shape cause of low reuse
  on a local llama.cpp route. The two candidates left are both server-side: per-slot prefix-cache eviction between
  turns (a 200k+ context is easy to preempt, and the turns here are minutes apart), and the 4096-token quantization
  that makes "almost nothing reused" print as exactly `4096`/`7168`. Same build, same day, a 52k session got
  `reuse=82-89%`, consistent with size-driven eviction rather than anything in our request.
- Post-compaction the next turn is cold regardless: core renders the summary as a leading user message
  (`COMPACTION_SUMMARY_PREFIX`).

## Resolved: `observations: 0` meant a freshly created store

Closed 2026-09-05 19:42 on session `01a070e0`, the pi-coder development session itself, which reported `obs=0` at
15:27 and then `obs=97`, `reference=chain`, `prefixUsable=true`, `verified=362/362`, `divergences=[]` at 19:42. One
store served 97 parent requests and then answered the compaction's prefix verdict, so the hook fires, the write and
read paths share the chain, and the branch filter keeps entries it should. What was actually happening is the boring
answer: an extension reload created a fresh chain, and the compaction ran before enough parent requests had landed in
it to matter for that branch. `obs=0` was a **cold store**, and with hashes instead of bodies it cannot be backfilled
from the session file. Persistence (above) closed it: `chainObservations: 0` is now a statement about the session
rather than the process.

Five runs were the evidence: `14:06 two-stage 01a0714f ref=chain obs=10 sys=24619c` / `14:32 core-default 01a0714f
ref=none obs=0 sys=12817c` (same session, 26 min later) / `14:52 two-stage 01a071fd ref=chain obs=13 sys=25294c` /
`15:27 two-stage 01a070e0 ref=none obs=0 sys=12817c` (557 msgs, 373k input, 400k ctx) / `19:42 two-stage 01a070e0
ref=chain obs=97 sys=24813c`. The 14:06 → 14:32 transition inside **one session id** is what made the store look
responsible; `01a070e0` had been compacted once before 15:27 (`keptFrom=3898fb95`) with dozens of requests in between.

Three mechanisms were candidates, all dead — kept as the checklist, cheapest to rule out first:

1. **The branch filter rejects entries that exist** — `match()` keeps an observation only when its `leafId` is in
   `pathIdSet(sessionManager.getBranch())`, so a null `getLeafId()` or a re-root after compaction would filter
   everything while the chain is full. Test by printing the two counts.
2. **Write and read use different `SessionManager` objects** — `requestChains` is keyed on object identity, so a
   different facade on the `before_provider_request` ctx than on the `session_before_compact` ctx never meets it, and
   needs no reload at all. (Would be fixed by keying on `sessionManager.getSessionId()` in a bounded map.)
3. **The hook genuinely does not fire** on the loaded instance (registration or reload lifecycle).

The 19:42 run killed all three at once, and the plan's `chainSession` field was dropped because it existed only to
separate candidate 2.

**The argument that misled me, worth keeping as an epistemic rule.** I wrote: "One observation is sufficient.
`RequestChain.observe()` stores the *cumulative* ladder, so a single `before_provider_request` after any reload covers
every prefix depth the compaction needs. `obs=0` therefore requires that **zero** parent requests were observed, not
merely that the process was young." The premise and the inference are both right; what was wrong was the close —
"a reload cannot explain this" was treated as "a reload did not do this", refuting the reload story when it had only
constrained it. The missing link was sitting in the same records unexamined: the 12,817-char system prompt, which only
occurs *before the first turn of a process*. `observations: 0` and a base-only prompt are two views of one event, and
the second one dated the first. Sufficient does not mean present. When a piece of reasoning rules an explanation out by
requiring it to be more specific than the evidence, the fix is to go find the field that makes it specific, not to keep
reasoning.
