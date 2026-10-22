---
name: model-comparison
description: "clef-flash, vllm-d3-flash, and lfm2-d1 on the reminder decision: latency, real-state decisions, order sensitivity, and verdicts."
category: architecture
keep_updated: true
---

# Decision-model comparison: clef-flash, vllm-d3-flash, and lfm2-d1

Measured 2026-10-21/22 against the same System One endpoint while the models shared it. The question: can
the faster `clef-flash` replace `vllm-d3-flash`, which scores better on general benchmarks but is slower and
has to share VRAM; and from Oct 22, how the newly added `lfm2-d1` compares. The config lives in
`~/.pi/decision-model-config.json`.

## Method

- The protocol answers every question in one round trip (`POST {baseUrl}/systemone` with
  `{model, state, questions}`), so one state costs one request per model.
- Question set: the four reminder bools (`memory-hygiene`, `delegation`, `todo`, `validation`) plus the
  piggybacked labels (`phase` choice, `finishing`, `unvalidated`), with the module's own guidance and criteria
  wording.
- Budget: ten `vllm-d3-flash` requests - eight labeled synthetic scenarios plus two order tests.
  `clef-flash` and `lfm2-d1` re-runs were free.
- Real states: the recorded turn decisions. The d3/clef comparison used the six d3-judged states; the
  `lfm2-d1` test replayed all eleven recorded turns, including the clef-judged ones that re-validated the
  rebuild (clef reproduces its own live scores within 0.002). The `pi-coder-reminder:debug` entries carry
  the signals, scores, labels, and pick, so only the two live inputs missing from them had to be rebuilt:
  - `request` is the user message *after* the debug entry. The live request is `event.prompt`, which is not
    in the branch yet at `before_agent_start`; the branch prefix's last user message is the previous turn's,
    and scoring with it sends the wrong prompt.
  - `recent_messages` is `decisionSessionContext`'s window: four clipped items, with the last user item
    dropped, built from the prefix before the debug entry.
  - The signals are copied from the debug entry as-is.
- The reconstruction was validated by re-scoring the two recorded live clef decisions, which matched within
  0.002.
- Latency is client wall-clock; the endpoint reports `output_tokens: 0` for all three models.

## Speed

| measurement | vllm-d3-flash | clef-flash |
| --- | --- | --- |
| probe median (same 7-question body) | 3 635 ms | 440 ms |
| probe range, four runs | 3 631-3 646 ms | 435-467 ms |
| endpoint input tokens | 3 673 | 1 371 |
| live session turns | 1 003-1 657 ms | 502-813 ms |

The probe's 3.6 s for vllm is inflated by VRAM pressure with both models loaded; the live turns ran 1.0-1.7 s
while vllm was resident. clef's smaller server-side template (1.4k vs 3.7k input tokens for the identical
body) is why the probe gap is larger than the live one. Neither model reports output tokens, so decode cost
has to be read from latency alone.

Residency confound: the endpoint has less VRAM than multiple models need together, and models that do not
fit are served from CPU/RAM instead of the GPU. Every latency above and in the lfm2 section therefore
tracks which model was GPU-resident at measurement time, not intrinsic model speed - the slow vllm probe
ran while clef was also loaded, the faster vllm live turns ran when it was resident, and clef's 375-640 ms
may itself be CPU-served. Do not rank models by these numbers unless residency is held fixed.

## Real-state decisions

Scores are per-reminder probabilities; the pick is the strongest at or above `reminderMinProbability`
(0.45). `FIRE` means the model would have shown the reminder.

| module turn | request gist | vllm-d3-flash | clef-flash |
| --- | --- | --- | --- |
| 2 | "did you get any reminders?" | validation .370 -> none | delegation .252 -> none |
| 3 | commit/report request | validation .258 -> none | memory-hygiene .321 -> none |
| 4 | report command | validation .286 -> none | memory-hygiene .279 -> none |
| 5 | steer question | memory-hygiene .404 -> none | memory-hygiene .350 -> none |
| 6 | "commit as wip" | memory-hygiene **.471 -> FIRE** | memory-hygiene **.584 -> FIRE** |
| 7 | "send these in parallel?" | validation **.598 -> FIRE** | finishing .414, validation **.175** -> none |

vllm fired on two states, at .471 and .598; its four abstains peaked at .404. clef reproduced the
`memory-hygiene` fire and even agreed on the pick, but abstained on the other fire: `validation` scored .175
against vllm's .598. Across the rest, clef's `validation` and `delegation` scores sit far lower (.035-.175
and .09-.13 on the abstain turns) while `memory-hygiene` tops most states. Whether that second fire was a
d3 strength or a false positive is the open question - see the verdict.

The remaining per-turn detail, for anyone re-reading the table later:

- Turns 2-5 are Q&A and reporting turns; both models abstained, and their top picks often disagreed
  (validation vs memory-hygiene vs delegation) even though neither fired.
- Turn 6 is the "work is done, commit it" state: `files_modified` 5, `tests_run`, `memory_writes` 3,
  labels verifying/finishing. Both models picked `memory-hygiene`, clef more strongly.
- Turn 7 is the discussion state with the same files but a parallel-work request ("can you send these in
  parallel?"). vllm read it as validation-due (.598); clef abstained (.175 validation), its strongest
  signal being the `finishing` label question at .414. Nothing was being wrapped up in that turn, so the
  abstain is a defensible reading; the disagreement is really about what the state makes salient, not yet
  about which model is right.

## Order sensitivity

Reversing the question order on the eight synthetic scenarios flipped clef's top pick in 6/8 cases and
dropped `memory-hygiene` by roughly 0.1-0.15 on every scenario (exploration .319 -> .173, planning
.346 -> .163, done-wrap .237 -> .165). The live request always asks `memory-hygiene` first (catalog order),
so the first-question boost is present live. vllm returned byte-identical scores for one real state in both
orders (`validation` .631 forward and reversed), so it did not show the effect. Only one state was tested for
vllm, so treat the asymmetry as directional. `lfm2-d1` later showed the same stability as vllm: reversed and
forward runs of the eight synthetic scenarios differed by at most 0.013.

## Synthetic labeled set (not usable as an accuracy probe)

Eight scenarios derived from the catalog guidance - read-only exploration, unvalidated edits, finishing
with unsaved learnings, stale multi-step TODO, large inline exploration, debugging a failing test, a
planning question, and a validated wrap-up. Both models scored 4/8, and neither separated fire from none:
every intended fire stayed below 0.45 (vllm max .409, clef max .286) while controls reached .439 (vllm) and
.346 (clef). The scenarios are too sparse - the real models key on accumulated activity (`files_modified`,
branch-wide tool counts, `tests_run`, prior reminders) that a hand-built state does not reproduce. The set
was kept only as the source of the order-flip test. The `lfm2-d1` run below reuses the set and reports
which scenarios it fires.

## lfm2-d1 (added Oct 22)

Run through the same scripts: eight synthetic scenarios forward and reversed, and all eleven recorded turn
states replayed from the debug entries. Raw scores sit beside the other models in the comparison results.

- Speed: 192-218 ms on the synthetic states and 245-331 ms on the real-shaped replays, the fastest measured
  and likely GPU-resident at the time (see the residency note under Speed), despite the largest server-side
  prompt (3.0-3.6k input tokens synthetic, 3.7-7.5k on the grown real states, versus clef's 1.2k synthetic
  and 1.6-1.7k real). Question order barely moves it (max delta 0.013).
- Labeled set: 3/8 - the only model that fires the intended reminder on any labeled fire scenario,
  `validation` .789 on the unvalidated-edit state (the strongest expected score any model produced) and
  `todo` .540 on the stale-TODO state. It also fires 3/4 of the "none" scenarios (read-only .582, debugging
  .551, planning .498) and misses `memory-hygiene` and `delegation`.
- Real states: fires on all six d3-judged states and 10/11 recorded turns at 0.45, with `todo` the top pick
  on 10/11 and never below .442. Four of those fires are Q&A turns where d3 and clef both abstained (both
  under .45, max .404). On the turn both other models reminded `memory-hygiene`, lfm2 tops `todo` .610 over
  `memory-hygiene` .470, so it would show the wrong reminder.
- Threshold sweep: its fire and none scores overlap (fires .330-.789, none .439-.582 on the synthetic set;
  on the six shared real states, .55 still fires 3/4 Q&A turns and .60 fires 2/4). At .45 it shows a reminder
  on essentially every turn.

Reading: lfm2-d1 is fast and order-stable but strongly yes-biased in the independent-bool form - the `todo`
question in particular never comes back negative - so no single `reminderMinProbability` makes it behave
like the other two. If it is worth pursuing, change the request shape (one "which reminder, if any" choice
question, or a per-question calibration offset) rather than the threshold.

## Verdict

The real-state samples do not establish a quality ranking. The one practical difference is turn 7: d3 fired
`validation` where clef abstained, and the abstain is arguably the better call - the request was a
parallel-work question and nothing was being finished - so this looks more like a d3 false positive than a
clef miss. The wider practical read is that d3 is slightly ahead on the bash-gate decisions and clef is
acceptable there too; this comparison covers the reminder surface only.

What is measured and worth keeping:

- `clef-flash` is 2-8x faster (see Speed).
- clef scores `validation`/`delegation` much lower and `memory-hygiene` relatively higher, so its threshold
  and its fire mix differ from d3's; it needs its own `reminderMinProbability` if adopted.
- clef is question-order sensitive (6/8 synthetic top-pick flips; `memory-hygiene` drops ~0.1-0.15 when the
  questions are reversed) while d3 was byte-identical across orders on the one state tested. Making the
  request order-robust helps either model.
- Both models fire sparingly, and the `memory-hygiene` fire at turn 6 was state-driven. The turn-7
  disagreement points at how well the state separates "wrapping up" from "still discussing", not at model
  quality - better state shape is the next lever, ahead of another model.
- `lfm2-d1` is a separate case: fastest and order-stable, but so yes-biased that no single threshold
  separates its fires from its none scores. See its section.

Caveats: one session, two fire states, one d3 order test. Every session now records its decisions, so a
real-state corpus can be accumulated and re-scored offline with no extra endpoint requests.

## Refreshing the comparison

- `npm run reminder-report -- <session> --recorded` prints the recorded decisions, scores, labels, and the
  signals they judged; the `pi-coder-reminder:debug` entries are the corpus.
- Rebuild the two missing inputs with the recipe above, send the same question wording to both models, and
  compare scores and picks. Keep the `vllm-d3-flash` request budget small: each request is slow while both
  models are resident.