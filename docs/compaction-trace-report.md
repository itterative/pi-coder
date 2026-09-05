# Compaction trace report

Every compaction the extension owns appends a few JSONL records so a pipeline whose intermediates never reach
the session transcript can still be examined after the fact. The writer is `src/modules/compaction/trace.ts`
(`.state/compaction-trace.jsonl`, rotated into a `.1` sibling); the reader is `scripts/compaction-report.mjs`.

## What is recorded

All records of one compaction share a run id, which is what lets the report group them.

| Stage            | What it carries                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prefix`         | how the rebuilt stage-1 request compared to what pi actually sent, answered by the retained hash ladder: `reference` (`chain`/`none`), `prefixUsable` (**absent**, never false, when nothing was comparable), `commonPrefixMessages` = deepest reference depth that agreed, `comparableDepth`, `referenceDepth`, `observations`, `verifiedThrough`, `truncated`, `parameters[]`, `historyTruncated`, `modelDivergence`, and a fingerprint of our own request |
| `attempt`        | one per strategy: the request-side numbers (`messageCount`, `estimatedTokens`, `reportedContextTokens`, `contextWindow`, `maxTokens`, `toolCount`, `copiedEntries`, `serializedChars`, `droppedBlocks`, `segmentSummaryChars`, `previousSummaryChars`) and how it ended (`accepted` / `rejected` / `skipped` with `detail`), with `usage`, `stopReason` whenever a reply arrived, `cause`, and `retries`                                                     |
| `model_response` | what the model answered with, before the harness appended anything                                                                                                                                                                                                                                                                                                                                                                                           |
| `final_summary`  | the exact persisted text, with `firstKeptEntryId`, `tokensBefore`, `summarizedMessages`, `droppedBlocks`, and the file counts the appended sections were built from                                                                                                                                                                                                                                                                                          |
| `outcome`        | how the whole compaction ended: `two-stage`, `native`, `serialized`, `core-default`, `cancelled`, `abandoned` (stopped on purpose: the cause named the account, not the request), `disabled`                                                                                                                                                                                                                                                                 |

Costs are development numbers only, and they are counted twice by design: a stage-1 resend shows up here as
`usage.input`, and the same tokens may also be counted on the parent's next turn elsewhere.

## Where the reference comes from

`chain.ts` folds a cumulative hash over every message array pi sends and keeps it in memory keyed by session
manager, about seventy bytes per request instead of a two-megabyte body. The report reads only the verdict the
chain wrote into the `prefix` record; see the `compaction` memory for why comparison happens at the
reference's depths and why an absent reference must never be printed as a failed one.

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
