# Compaction trace report

Every compaction the extension owns appends a few JSONL records so a pipeline whose intermediates never reach
the session transcript can still be examined after the fact. The writer is `src/modules/compaction/trace.ts`
(`.state/compaction-trace.jsonl`, rotated into a `.1` sibling); the reader is `scripts/compaction-report.mjs`.

## What is recorded

All records of one compaction share a run id, which is what lets the report group them.

| Stage            | What it carries                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix`         | how the rebuilt stage-1 request compared to the parent session's last real request: `prefixUsable`, `firstDivergence`, `divergences[]`, `parameters[]`, `truncated`, and the message counts on both sides, plus a fingerprint of each request (system/tools hashes, key list)                                                             |
| `attempt`        | one per strategy: the request-side numbers (`messageCount`, `estimatedTokens`, `reportedContextTokens`, `contextWindow`, `maxTokens`, `toolCount`, `copiedEntries`, `serializedChars`, `droppedBlocks`, `segmentSummaryChars`, `previousSummaryChars`) and how it ended (`accepted` / `rejected` / `skipped` with `detail`), with `usage` |
| `model_response` | what the model answered with, before the harness appended anything                                                                                                                                                                                                                                                                        |
| `final_summary`  | the exact persisted text, with `firstKeptEntryId`, `tokensBefore`, `summarizedMessages`, `droppedBlocks`, and the file counts the appended sections were built from                                                                                                                                                                       |
| `outcome`        | how the whole compaction ended: `two-stage`, `native`, `serialized`, `core-default`, `cancelled`, `disabled`                                                                                                                                                                                                                              |

Costs are development numbers only, and they are counted twice by design: a stage-1 resend shows up here as
`usage.input`, and the same tokens may also be counted on the parent's next turn elsewhere.

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

## What the flags mean

Each flag names a failure already observed in a live trace, so the report can point at the wrong runs instead
of leaving the numbers to be compared by eye. They are thresholds, not verdicts — `--min-chars` and
`--inflate-factor` exist to move them.

| Flag                       | What it means                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `prefix-unusable`          | something before the appended instruction differed, so stage 1 could not reuse the provider's cached prefix                        |
| `span-not-truncated`       | stage 1 sent the whole live context instead of the truncated span, i.e. the cut point was never found                              |
| `degenerate-native-output` | stage 1 was accepted but answered with far too little text — the shape of a model replying about the instruction rather than to it |
| `degenerate-final-summary` | what got persisted is implausibly small, whatever route produced it                                                                |
| `reduce-inflated`          | stage 2's output is many times larger than the checkpoint it was handed, so it wrote a new summary instead of merging one          |
| `cache-read-zero`          | a large fresh prompt with no cache read: the span was paid for again                                                               |
| `blocks-dropped`           | transcript blocks left out of the reduce request at the serialization cap, so the summary covers a truncated view                  |
| `fell-back`                | the run ended in `core-default`, `cancelled`, or with no outcome record at all                                                     |
| `estimate-skew`            | the chars/4 estimate diverged from the provider's own context count by enough that the fit gate decided on a stale number          |

## Validation

`test/scripts/compaction-report.test.ts` feeds the script records written by the **real** recorder, so the
fixture cannot drift from the trace schema. Only the schema-drift case writes raw lines, deliberately.
