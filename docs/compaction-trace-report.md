# Compaction trace report

Every compaction the extension owns appends a few JSONL records so a pipeline whose intermediates never reach
the session transcript can still be examined after the fact. The writer is `src/modules/compaction/trace.ts`
(`.state/compaction-trace.jsonl`, rotated into a `.1` sibling); the reader is `scripts/compaction-report.mjs`.

## What is recorded

All records of one compaction share a run id, which is what lets the report group them.

| Stage            | What it carries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix`         | how the rebuilt stage-1 request compared to what pi actually sent, answered by the retained hash ladder: `reference` (`chain`/`none`), `prefixUsable` (**absent**, never false, when nothing was comparable), `commonPrefixMessages` = deepest reference depth that agreed, `comparableDepth`, `referenceDepth`, `observations` (comparable), `chainObservations` (held), `branchObservations` (on this branch), `verifiedThrough`, `truncated`, `parameters[]`, `historyTruncated`, `modelDivergence`, `unknowns[]`, and fingerprints of our own request and of the newest on-branch parent request |
| `attempt`        | one per strategy: the request-side numbers (`messageCount`, `estimatedTokens`, `reportedContextTokens`, `contextWindow`, `maxTokens`, `toolCount`, `copiedEntries`, `serializedChars`, `droppedBlocks`, `segmentSummaryChars`, `previousSummaryChars`) and how it ended (`accepted` / `rejected` / `skipped` with `detail`), with `usage`, `stopReason` whenever a reply arrived, `cause`, and `retries`                                                                                                                                                                                             |
| `model_response` | what the model answered with, before the harness appended anything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `final_summary`  | the exact persisted text, with `firstKeptEntryId`, `tokensBefore`, `summarizedMessages`, `droppedBlocks`, and the file counts the appended sections were built from                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `outcome`        | how the whole compaction ended: `two-stage`, `native`, `serialized`, `core-default`, `cancelled`, `abandoned` (stopped on purpose: the cause named the account, not the request), `disabled`                                                                                                                                                                                                                                                                                                                                                                                                         |

Costs are development numbers only, and they are counted twice by design: a stage-1 resend shows up here as
`usage.input`, and the same tokens may also be counted on the parent's next turn elsewhere.

## Where the reference comes from

`chain.ts` folds a cumulative hash over every message array pi sends and keeps it in memory keyed by session
manager, about seventy bytes per request instead of a two-megabyte body. The report reads only the verdict the
chain wrote into the `prefix` record; see the `compaction` memory for why comparison happens at the
reference's depths and why an absent reference must never be printed as a failed one.

Three counts describe how much of that store could be used, and they are reported separately because each zero
means something different:

| field                | meaning                                                | what a zero says                                                                                        |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `chainObservations`  | entries held in this process, unfiltered               | nothing has been observed since the chain was created: restart, reload, or a freshly built session view |
| `branchObservations` | entries whose leaf sits on the current branch          | entries exist, but they belong to a branch that was navigated away from                                 |
| `observations`       | entries that also share our system prompt and tool set | the branch's requests were built under a different prompt or tool set than ours                         |

`prefix.parentRequest` carries the newest on-branch entry's shape — model, system-prompt length and hash, tool
hash, depth, leaf id — as the twin of `prefix.ourRequest`, so "did our rebuild send what pi sends" is a field
comparison rather than an inference. Both sides hash the whole system text: `ourRequest.systemHash` used to hash
a 320-char excerpt, which reported no change across a prompt that had grown from 12,817 to 24,813 characters.

One guarantee is worth knowing before reasoning from these numbers: `reference: "none"` is only reachable when
`branchObservations` is zero, and `"chain"` with `observations: 0` is the shape-mismatch case. That distinction
settled a live question about whether an empty verdict meant a cold store or a filtered one, and the report now
checks it as an invariant instead of leaving it to be derived.

## Reading it

```bash
npm run compaction-report                                     # newest 10 runs plus the aggregates
npm run compaction-report -- --runs 0                         # every run in the file
npm run compaction-report -- --suspect --session 01a070e0     # only the runs carrying a flag
npm run compaction-report -- --dump=native --runs 1           # stage 1's answer, verbatim
npm run compaction-report -- --grep bwrap --dump=final        # find a run by its text, read what persisted
npm run compaction-report -- --json | jq '.aggregates.flags'  # machine-readable
```

`--dump` prints stage text unindented and untruncated, because a checkpoint is markdown and the report body
only ever shows a one-line preview. Stages are `native` (stage 1's answer), `serialized` (stage 2's answer),
`final` (what was persisted), or `all`.

The report body renders one block per run: the prefix verdict, one line per stage attempt with its request
numbers and `in/cached/cw/out`, the persisted summary's size and cut point, and any flags. `+Ns` after a
stage is the gap to the previous record, which is as close to per-stage latency as the trace gets.

The prefix line adds `chain=held/branch/comparable` and `sys=<our chars>c`, plus `parent-sys=<chars>c` when a
branch reference existed, because those pairs decide whether the verdict on that same line means anything. A run
can also print `~ cannot tell:` lines: statements from the record about what it cannot answer, kept apart from
flags because they describe the instrument's reach rather than the run's behaviour. `chain-empty` beside
`cache-read-zero` is the pair that means "we do not know whether the cache was reused", and the record now says
so rather than leaving a zero to be read as a measurement.

`INVARIANTS` lists cross-field checks — an empty chain that reports entries on the branch, `reference=none` with
entries to compare, a usable verdict with no comparable depth, matching hashes over differently sized prompts.
A violation there is a bug in the trace, not in the cache, which is the distinction that has to be made before
any other conclusion in this file is worth anything.

`CAUSES` aggregates `strategy outcome cause`, and `ATTEMPT FAILURES` keys each row by its cause
(`native rejected [quota]: ...`) before normalizing the message. That ordering matters: the two failures that
look most alike in free text — context overflow and an exhausted account — call for opposite responses, so a
table that groups them hides the one number that decides it. A skipped stage-2 attempt reading
`not attempted: <cause>` is the trace's way of distinguishing a deliberate stop from a missing budget.

## What the flags mean

Each flag names a failure already observed in a live trace, so the report can point at the wrong runs instead
of leaving the numbers to be compared by eye. They are thresholds, not verdicts — `--min-chars` and
`--inflate-factor` exist to move them.

| Flag                       | What it means                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `prefix-unusable`          | a comparable reference depth disagreed with our rebuild, so stage 1 could not reuse the provider's cached prefix                           |
| `no-prefix-reference`      | no observation covered this branch, so the cache question is unanswered. Not a failure - and the case the old code reported as one         |
| `chain-empty`              | no parent request had been observed in this process when the verdict was taken: restart, reload, or a fresh session view                   |
| `chain-off-branch`         | the chain holds entries and none of them sit on the current branch, so a fork or a rewind is why there is no reference                     |
| `chain-incomparable`       | on-branch requests exist but were built under a different system prompt or tool set, which is also a real reason the cache cannot answer   |
| `system-prompt-drift`      | ours and the parent's system prompts hash apart at the same length — drift no size figure can show                                         |
| `prefix-uncomparable`      | a reference existed but every request in it was deeper than the truncated span, so nothing could be compared                               |
| `span-not-truncated`       | stage 1 sent the whole live context instead of the truncated span, i.e. the cut point was never found                                      |
| `degenerate-native-output` | stage 1 was accepted but answered with far too little text — the shape of a model replying about the instruction rather than to it         |
| `degenerate-final-summary` | what got persisted is implausibly small, whatever route produced it                                                                        |
| `compaction-abandoned`     | the run stopped on a cause no request can fix (quota, rejected credentials, rate limit); not a handover, so `fell-back` stays clear        |
| `retry-exhausted`          | a transient failure used its whole backoff budget and still failed, so the provider was unwell longer than we wait                         |
| `summary-truncated`        | stage 2 hit the output limit, so the persisted summary is missing its tail. Reading the text cannot tell this from a brief complete answer |
| `reduce-inflated`          | stage 2's output is many times larger than the checkpoint it was handed, so it wrote a new summary instead of merging one                  |
| `cache-read-zero`          | a large fresh prompt with no cache read: the span was paid for again                                                                       |
| `blocks-dropped`           | transcript blocks left out of the reduce request at the serialization cap, so the summary covers a truncated view                          |
| `fell-back`                | the run ended in `core-default`, `cancelled`, or with no outcome record at all                                                             |
| `estimate-skew`            | the chars/4 estimate diverged from the provider's own context count by enough that the fit gate decided on a stale number                  |

## Validation

`test/scripts/compaction-report.test.ts` feeds the script records written by the **real** recorder, so the
fixture cannot drift from the trace schema.

It also pins one **real** run: `test/fixtures/compaction-trace.healthy.jsonl` is a llama.cpp compaction
for the repository — provider renamed, `cwd` and session id replaced with deterministic stand-ins,
timestamps re-based while keeping their millisecond offsets, and the checkpoint text swapped for a synthetic
block of the same length. The `model_response` records are dropped entirely, which is what caught a flag that
fired on absent data rather than an empty answer. The test asserts the verdict a healthy run must produce
(`reference=chain`, all 19 span messages verified against a 33-message reference). Only the schema-drift case
writes raw lines, deliberately.
