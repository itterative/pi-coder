---
name: trace
description: "The compaction JSONL trace: record types and field gotchas, the trace-log toggles and file policy, and how scripts/compaction-report.ts turns them into the prefix verdict, stage lines, suspects, and INVARIANTS."
category: architecture
keep_updated: true
---

# Compaction trace and report

Detail companion to the `compaction` memory.

## The file

`trace.ts` appends one JSONL record per stage to `<pi-coder-install>/.state/compaction-trace.jsonl` (`0600`, dir `0700`,
rotated at `traceMaxBytes`, keeping `traceGenerations` numbered generations), all records of one compaction sharing an
`id`. Order for a successful two-stage run: `prefix`, `attempt(native)`, `model_response(native)`, `attempt(serialized)`,
`model_response(serialized)`, `final_summary`, `outcome`.

Follows `isAgentTraceEnabled()`, which moved to `src/common/trace.ts` (a session module must not reach into the agent
tool to ask whether it may write a file) and is still re-exported from `tools/agent/observability/trace.ts` so
agent-side imports did not move. Separately disable with `COMPACTION_TRACE=0`, relocate with `COMPACTION_TRACE_PATH`.
Writing never throws; with tracing off the recorder is a no-op behind the same API. Records hold raw summary text,
so **`test/setup.ts` disables the trace repo-wide** the way it disables the bash decision log.

Every trace record and every persisted chain row carries `instance` — a random id for one extension load, from
`PROCESS_INSTANCE` in `src/common/trace.ts`. Sessions outlive reloads, and two loads can leave rows in one file whose
chains, config, and handlers were never the same; without the field, joining a live answer to a recorded one is
guesswork. The report names the newest load and how many older ones contributed.

`.state/` contains private runtime state and is not source code — and is **never a test input** (see `fixtures.md`).

## The records

- `attempt` — per stage: `accepted`/`rejected`/`skipped`, detail, `usage` incl. **`cacheRead`** (the only way to tell
  whether the rebuilt prefix was served from cache), **`stopReason`** whenever a reply arrived (the only way to tell a
  truncated summary from a brief one), estimated tokens **with the method that produced them** (`estimateSource`),
  tool/message counts, stage 1's `copiedEntries`/`skippedEntries`/`cutFound`, stage 2's
  `serializedChars`/`segmentSummaryChars`. A `skipped` attempt has no `stopReason` or `usage`: the request never went
  out. Stage 1 also carries **`ledger`** — the head ledger's size for the same body (`tokens`, `estimatedTokens`,
  `headTokens`/`headSource`/`headEstimatedTokens`, `rowsCounted`/`rowsEstimated`/`rowsCheckpoints`) — recorded
  **whether or not its tier answered**, because comparing it with the provider's own count of the request that went
  out is the only live accuracy measurement available. Absent means the derivation declined *or* the record predates
  the field, and nothing may infer which: a `tokens: 0` would read as "this request is free", so a decline is recorded
  as no field at all.
- `prefix` — the verdict from `chain.ts` against our `onPayload` body: which reference answered, how deep the agreement
  went, and the parameters only one side sent. Two rules survive from the body-to-body era: an extra body key is a
  **parameter**, never a prefix verdict, and an absent reference is **unknown**, never `false`. `referenceLeafId`,
  `referenceSource`, `otherDisagreements` and `firstMismatchDepth` all belong to **one** credited reference;
  `parentRequest` mirrors that same row, and the decode scalars on both sides are compared by value into
  `divergences` (see `prefix-cache.md`, "A verdict names one reference").
- `model_response` — what the model said before the harness appended anything.
- `final_summary` — the exact persisted text plus its counts.
- `outcome` — `two-stage`/`native`/`serialized`/`core-default`/`cancelled`/`disabled` (and `abandoned`, written when the
  cause policy stops a compaction; see `failures.md`).

## Field gotchas

- `ourRequest.systemHash` hashes the **whole** system text as of the funnel pass, matching `requestShape()`, so equal
  hashes do mean equal prompts. Records written before that change hashed only a 320-char excerpt (`EXCERPT_CHARS`) and
  cannot be re-read as evidence that a prompt was stable (`prefix-cache.md` names the four sizes one old hash covered).
  The ladder heads that `verified=N/M` rests on are sha256 over messages and never had this weakness.
- `prefix.parameters` should be **empty** on a healthy run: we no longer add a key pi's turn requests lack
  (`tool_choice`, dropped) and no longer omit one they carry (`reasoning_effort` and `enable_thinking`, forwarded).
  Anything left in it is a real difference to explain; a `-key` means the parent sent something our rebuild dropped. If
  `+tool_choice` reappears, someone re-added the option for portability — read the comment at its old call site first.
  A `-top_p`, `-min_p` or `-chat_template_kwargs` is a model with configured sampling parameters whose merge went
  missing again. Note the limit: it is a set difference over body **keys**, so it cannot see a value disagreement.
- `prefixUsable` is `undefined` in older records rather than absent; read `reference` first — `none` means no ladder
  covered the branch and the numeric depths are `-1` placeholders, not measurements.
- Three-state fields are deliberate wherever a build may predate them: `cut=found`/`missing`/`unrecorded`,
  `cutMoved=no`/`to:<id>`/`unrecorded`, `ledger=`absent / `ledger=-` / signed percent. "This record predates the
  field" must never read as the negative answer.

## Reading it: `npm run compaction-report`

`scripts/compaction-report.ts` (run under `node --import tsx` so it can share the record log) — never hand-roll jq
joins again. It groups records by run id and prints the prefix verdict, one line per stage attempt with its request
numbers and `in/cached/out`, the persisted summary's size and cut point, then ROUTES / ATTEMPT FAILURES / SUSPECTS /
PREFIX DIVERGENCES / COST AND CACHE / COMPRESSION / LEDGER aggregates. `--dump[=native|serialized|final|all]` prints
stage text **verbatim** (the report body only previews it, because a checkpoint is markdown); `--suspect`,
`--grep <text>`, `--session <prefix>`, `--route`, `--reason`, `--since`, `--runs 0` (all) and `--json` cover the rest.
It reads every retained generation and tolerates fields absent in records from older builds, because the file
accumulates across checkout. Prose for every flag is in
[docs/compaction-trace-report.md](../../../../docs/compaction-trace-report.md).

Its SUSPECTS flags encode the failure modes as thresholds: `prefix-unusable`, `span-not-truncated`, `cut-not-found`,
`degenerate-native-output`, `degenerate-final-summary`, `reduce-inflated`, `cache-read-zero`, `blocks-dropped`,
`summary-truncated`, `fell-back`, `estimate-skew`, `ledger-skew`, plus the funnel four (`chain-empty`,
`chain-off-branch`, `chain-incomparable`, `system-prompt-drift`), `prefix-uncomparable`, `compaction-abandoned`,
`retry-exhausted`, and `refused-cut-shipped`. Two rules govern them:

- **One fact, one flag.** `prefix-uncomparable` stays silent when the shape gate emptied the funnel because that cause
  is already named by the rejection counts; `span-not-truncated` stays quiet when `cutFound` says the thing directly;
  `chain-incomparable` prints the per-gate counts. Two flags for one fact is how a reader debugs the wrong one.
- **Never let a flag fire because a record was *absent*** — that is what a rotated or trimmed log looks like, not an
  empty model answer.

`INVARIANTS` is a section of cross-field checks that name states the instruments cannot produce:
`reference=none` with entries on the branch, an empty chain reporting branch entries, a usable verdict with no
comparable depth, matching hashes over differently sized prompts, comparable observations with none on the branch,
`incomparable-without-rejection`, `tier-without-ledger`, `moved-without-cause` — the full list and why the trace must be
believed before any cache conclusion is in `prefix-cache.md`. `moved-without-cause` is one-directional — a cause with
no move is the legitimate abstain path, flagged instead as `refused-cut-shipped`.

**The LEDGER section is the accuracy instrument, and it reads the shadow tier rather than the chosen one.** A stage
line prints `ledger=+1.0%` beside `est=`/`src=` — three states: nothing when the record carries no `ledger` object,
`ledger=-` when a number was derived but no reply came back to compare it with, the signed percent otherwise. The
section aggregates runs/comparable, mean and worst signed skew naming the run, `over band=n/m`, and the mean chars/4
share, printed only when at least one attempt carried the fields. `ledger-skew` uses band
`--ledger-estimate-skew`, default **0.05**, ranked between `usage-anchor`'s 15% and `chars4`'s 50% and earned by the
0.96%/0.01%/0.26% measurements; `tier-without-ledger` exists because naming the tier while omitting its numbers means
one of the two was written by something that computed neither. `--json` exposes all of it **under the record's own
field names**. `ledger-skew` prose names both candidate causes rather than picking one, since the record cannot tell
them apart: a head solved under a request shape that has since moved, or an estimated share too high to trust.
Direction is not a clip here the way it is for `estimate-skew` — the number is arithmetic over counts, so a breach
says the derivation and the endpoint disagree about the same bytes. Verified by injecting the capture's real three
numbers: the section reads `mean=0.4% worst=+1.0% over band=0/3`, and all three committed fixtures predate the field
and grow no ledger output at all. `estimate-skew`, by contrast, does carry direction: estimate far **above** the
count is the clip shape (the provider saw less than we sent) or chars/4 over-reading the content, and the record cannot
tell those apart, which the flag says out loud; estimate far **below** means the fit gate decided on a number too
small. The CUT histogram and `cut:` detail line are in `ledger.md`.

Two report-era lessons: keep `--json` field names equal to the record's own names, and the report keys `ATTEMPT
FAILURES` by cause with a `CAUSES` section (see `failures.md`).
