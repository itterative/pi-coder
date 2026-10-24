---
name: stage-gating
description: "Mid-run stage-gating probe (session-midturn.py) and the window lessons it transplanted into the live reminder path: the model's own state over time, the endpoint's cost shape, and the planned session window."
category: architecture
keep_updated: true
---

# Mid-run stage gating

Index: [../reminders.md](../reminders.md). Question: should reminders be scoped by the conversation's current
stage, and if so how is the stage maintained mid-run? The harness is `session-midturn.py` under
`.pi/local/reminder-transitions/` (gitignored scratch, not repo code): it walks a session JSONL, rebuilds the
turns/checkpoints, sends a window to `clef-flash`, and carries the model's **own** accepted state checkpoint
to checkpoint - no tool-derived stage label.

## What the state machine looks like

- Base states: discussing / exploring / implementing / validating / reporting. A proposed change is accepted
  only at confidence >= 0.5, and the state is sticky: a turn moves through a few stages, not many.
- Mid-run matters: one turn crosses several stages (e.g. exploring -> implementing -> validating ->
  reporting), so a turn-start-only decision lags the conversation.
- `--annotate` inserts the model's own accepted states into the sent transcript; `--show conversation` prints
  the messages continuously, marking only the state changes. `ask_user` is modeled (the question plus
  `<- user answered:`).
- A 6th `documenting` state (`--states doc`) removes false `validating`/`reporting` on prose writes. Read
  against a 270-step transcript it is the *recording* phase: it enters on memory/TODO/doc edits and sits
  immediately before the hand-back. Keep it broad (docs + memory + TODO) and split it against `reporting` (a
  summary to the user with no file write), not against memory-vs-docs.
- The stage is sticky across turns: in the 12-turn probe transcript every turn starts in the previous turn's
  last accepted state (12/12). The turn-start checkpoint usually corrects it, but a gate that reads the stage
  at the user turn sees a stale value every time, so a user turn should force a re-judge rather than inherit.
- Per-step noise is intra-cluster (exploring <-> implementing <-> validating <-> documenting): 270 steps gave
  33 accepted changes, most of them re-deciding inside the same working phase (79% of steps are exploring or
  validating). Scope by the coarse question/working/reporting distinction, or by whether the turn has mutated
  anything yet, not by the instantaneous state.

## The endpoint's cost shape (measured)

- Per-call latency tracks the input: `clef-flash` answers a fitted transcript in ~0.269s at 800 chars, 0.350s
  at 1800, 0.419s at 3000 and 0.465s at 4500 (roughly 0.2s of overhead plus 0.05ms/char, measured on the same
  transcripts with the order alternated). An earlier ~0.23s-at-200 / 0.36s-at-4500 reading recorded here
  suggested the size did not matter - it does, so the tier-1 budget is a real cost knob.
- The transcript window is cumulative within a turn, so inside one long turn the window grows 155 -> 4620
  chars and the call grows 221 -> 860ms (~0.14ms/char), then resets at the next turn. Per-session means
  therefore grow with the turn length (window mean 1619/2840/3027 chars on the three probe sessions), while a
  fixed short cap saturates (800 chars -> ~390ms).
- So for this endpoint the lever is the *cadence* (how often a check runs), not the window size.

## Two-tier cascade (current shape)

`--tier` is the cascade: tier 1 asks the `next_state` question (`state = {current_state, conversation}`) on the
same window fitted to `--short-chars` every step, and only an unsure check (`s_conf < --tier-confidence`)
escalates to the window, which is then asked once. `--tier-reference` adds the window call on every step
purely to score the cascade; `--tier` implies `--checkpoint-every 1`. (The script calls the id `next_text`; the
live question is named `next_state`.)

Current measurements, with the planned window (see *Harness rendering* below):

| session (steps) | tier-1 chars | esc% | t1/s | casc/s | window/s |
|---|---|---|---|---|---|
| `08-00` (34) | 800 | 11.8% | 0.29 | 0.34 | 0.47 |
| `08-00` (34) | 1800 | 11.8% | 0.34 | 0.39 | 0.47 |
| `08-00` (34) | 4500 | 11.8% | 0.40 | 0.45 | 0.47 |
| `11-16` (270) | 800 | 26.7% | 0.29 | 0.41 | 0.47 |
| `11-16` (270) | 1800 | 25.2% | 0.35 | 0.46 | 0.47 |

- Escalation is now **independent of the tier-1 size**, so 800 is the right setting: equal escalation at the
  lowest cost, and the cascade beats asking the window every step on both sessions.
- Older numbers, all measured against a tier-1 window that had *no tool lines at all*, are kept as a caution:
  23.5% / 47.1% escalation and 0.36s / 0.51s cascade at 800 - a tie or a loss, which is why this section used
  to say the cascade was rejected. With `--tier-reference` on, tier 1 then agreed with the window 84.6% and
  71% of its proposed changes were false; that agreement figure has **not** been re-measured since the window
  plan landed.
- **Open:** the remaining 26.7% escalation on the long session is tier 1 being genuinely unsure. Whether
  those points are real phase changes or the `validating <-> exploring` flicker decides whether to raise
  `TOOL_MIN` / `--turns` further or accept the escalation.

## Transplanted into the live path (Oct 24)

Three of the probe's mechanisms now run in `src/`: the accept gate, the transition wording, and `--annotate`.
What moved them was a measured failure of the live path without them: one session held the phase `verifying` for
~1000 entries of implementing, testing, and memory writing while the branch read `implementing`, because the
consult's state field carried the previous phase back to the model, the instruction said to keep it, and the
answer was accepted unconditionally - 33 answered consults, all `verifying`.

- **Accept gate.** `acceptedReminderPhase` (`decision/reminder.ts`) is the probe's `resolve_change`: the first
  answer is taken as it comes, a repeat holds, and a different phase has to answer at
  `PHASE_MOVE_CONFIDENCE` (0.5, the probe's `--confidence`/`--tier-confidence` default) to move it. The held
  phase travels into `evaluate` as `heldPhase` (threaded from the module's accepted labels) and is part of the
  evaluator's cache key.
- **Transition wording.** `REMINDER_PHASE_INSTRUCTION` is the probe's `TIER_INSTRUCTION` framing - the state
  shows the phase the session is in, and the question is which phase it moves to next - replacing "keep the
  previous phase when the work has not moved on", which made the model confirm rather than judge.
- **Annotation.** `decisionSessionContext(entries, { stateMarker })` inserts each recorded state entry as a
  `──── phase: X ──` item where it was accepted, and `reminderStateMarker` (reminders module) is the reader, so
  the decision module never names the reminder's entry type. Markers are charged their own length instead of
  `ITEM_MIN`, because a dozen annotation lines at a full floor would spend the window on themselves.
- **Vocabulary and pool.** The states are the `--states doc` set, and each rotation reminder names the states it
  is offered in (`availableRotationIds`), so the pool is the judged state's rather than a coarse produced-work
  check (see `reminders/selection.md` for the table and the folds).
- **The cascade.** `judgeTurn` runs tier 1 (state only, `SHORT_WINDOW_CHARS` = 800) to decide the pool, then
  tier 2 (the pool's questions, its own window), and when tier 1's phase answer was unsure it asks the *state*
  again as its own call on `TRANSCRIPT_WINDOW_CHARS` = 1800 (`session-context.ts`) - the README's 800/1800/4500
  sweep measured 1800 equal to 4500 and cheaper. The escalation is **not** state questions bolted onto the
  pool's request: the pool's state stays the signals it was measured with, and the state ask keeps its own
  state. `escalated` and `stateConfidence` are recorded in the debug entry. The cascade is **deferred**: the
  boundary advances the turn (`beginTurn`) and queues the judgement, which delivers a `steer` into the running
  turn (or `nextTurn` once it settled), because pi builds the user's message only after the `before_agent_start`
  handler returns. The armed reminders carry no consult and still ride the prompt.
- **What the state ask sends (the measured variant).** State `{current_state, conversation}`, one question
  `next_state` with the probe's `--tier` instruction and `--states doc` criteria verbatim, and `conversation`
  from the ported transcript (`decision/transcript.ts`: `windowTranscript`/`fittedTranscript`, caps
  `TOOL_LINE_CHARS` 120 / `MESSAGE_LINE_CHARS` 900, `elide=false` because `--annotate` means no tool elision,
  turn selection `KEEP_TURNS` 3). It is pinned byte-for-byte against the script's own renderer by
  `test/fixtures/transcript-window.json` (generated from `session-midturn.py`'s cached checkpoints).
  `current_state` is the *accepted* phase (`none` before one exists), sent rather than only gating: the same
  window in the old shape - structured `recent_messages`, anchor only in a gate, three questions - read
  `exploring` at 0.17 confidence; this shape read `validating` at 0.82 for 576 vs 1037 prompt tokens and
  ~0.31s vs ~0.48s. The `finishing`/`unvalidated` questions are gone (nothing gates on them: the pool gate is
  the phase and the TODO, and `unvalidated` keeps its deterministic inference - a *recorded* value is never read
  back, since with no question left it would be frozen). `--annotate` inserts markers where a phase was
  accepted, in the probe's own wording (`  ── state: X ──`); the live marker reader drops a phase that repeats
  the one before it, as `insert_state_markers` does, and the transcript's turn stamps treat a steer as part of
  the turn it joined. The fitted conversation is recorded in the debug entry as `stateTranscript` (the state ask
  has no pool window to record), and the report prints it.
- **The checkpoint cadence.** The state is also judged on every tool-using assistant response (`pi.on(
  "turn_end")` -> `judgeStateCheckpoint`: tier 1 short, then the same state question on the full window when
  unsure, no pool questions). It gates on `scope: "full"`, reminders/rotation on, the model opted in, and
  `event.toolResults.length > 0` - not on `sessionArmed`, which is what used to hide the state on a reload or
  post-fold turn - and it calls no `decide()`, so the user-turn counters stay the turn boundary's business. Its
  debug entry is `trigger: "checkpoint"`, with no `pick` because it decides nothing. Both judgements share one
  serialized queue (`common/async.ts`'s `SerialQueue`), so they land in the order the session produced them and
  the mid-run gate can wait for a settled state.

## Turn-level posture, asked in the same call (measured)

Refinement of the scoping idea: instead of projecting the six states onto a coarse stage, ask a second, coarser
question in the same call - the turn's *posture* (`understanding | working | handing_back`) - and use it only
as a **candidate-pool filter**; each reminder's own question still decides. Measured on the 270-step `11-16`
transcript at `--checkpoint-every 1`, `--states doc`, gate 0.5.

- Cost is small: adding the question to the same request costs +48ms on a 0.45s call (+11%), measured over 10
transcripts at alternating order.
- It does hold where the fine state oscillates: in turn 5 (135 checkpoints) the posture kept 2 values
(`understanding -> working`) while the fine state moved 5 times, and steps 101-134, where the low-threshold
tier run flickered `validating <-> exploring`, stayed `working` throughout.
- Caveat that weakens the motivation: at the 0.5 gate the six-state track changes only 16 times in 270
  checkpoints, so the "flicker" seen earlier was largely `--tier-confidence 0.3` accepting every change, not
  intrinsic to the six states.
- Two wordings were A/B'd (`--posture current|monotone`: "what is the assistant doing now" vs "what has this
  turn done so far"). Neither is reliable:
  - Turn-boundary inheritance is **not** fixed by turn-scoped wording. Every turn starts in the previous
    turn's posture, and the model often keeps it *confidently* at the turn's first checkpoint (turn 3 cp0:
    `handing_back` at 0.55 while the turn is a fresh investigation).
  - "A turn that only ran something" is undefined in both: turn 10 runs a scout and produces nothing; the
    monotone wording says `understanding` (right), the current wording says `working`, and the fine state stays
    `documenting` (the previous turn's value) for all 4 checkpoints.
  - The current wording lags the first produced write: turn 9's first edit lands at cp12 and the posture only
    moves to `working` at cp15 (its proposals were 0.32-0.43, all under the gate). The monotone wording fixed
    exactly that, but introduced a `handing_back` bias (26 of 270 checkpoints vs 8) and broke turns 2, 3 and 6.
  - Confidence is low in both: mean 0.540 (current) / 0.592 (monotone), with 90-101 of 270 answers under the
    0.5 gate, so much of the stability is the gate holding rather than the model being sure.
- Next form to try: a fact-shaped **bool** ("has this turn produced or changed anything yet?") in the same
  call, with `handing_back` taken from the fine state's `reporting`. Bools were the form that separated
  answers in the earlier reminder replays, and that fact is a much easier question than a 3-way phase choice.

## Harness rendering (fixed Oct 23)

The probe stores structured items per checkpoint and renders at consult time, and two defects in the old
render change how the earlier measurements in this file should be read:

- **`--annotate` was a no-op.** `insert_state_markers` and `prose` mode matched a `  ->` line prefix while the
  renderer emitted `Tool: ` (the prefix was renamed by hand), so every annotated run before this inserted no
  markers; `--annotate`'s only effect was disabling line elision.
- **The window defaulted to one turn** (`--turns 1`), so a turn-start checkpoint - the one the live path
  consults - received exactly one message, the request. Measured over 24 turn starts in three sessions:
  `--turns 1` gave mean 1.0 messages (min 1, max 1); a message-only 3-turn span gives 8.3 / 6.4 / 6.2. That
  is a better explanation of the "stale at turn start" readings (turn 3 cp0 answering `handing_back` at 0.55)
  than the model's judgment was, and it also leaves <=2 messages at 22-59% of checkpoints.
- **The window is planned, not fitted.** The newest user message, the newest assistant message and the newest
  `--tool-min` (2) tool lines are always kept; the rest of the allowance fills with the newest remaining
  messages (each reserving `--message-min`, 220) and then with further tool lines inside `--tool-share`
  (0.30). Each kept message is clipped newest-first, so an older message is trimmed before a newer one is
  dropped, and messages are capped at `--message-chars 900` for the model while the printed `conversation`
  view stays uncapped. The span is the newest turn complete plus the earlier turns message-only.
- **The earlier cascade numbers were measured against a broken tier-1 window.** The greedy fit left the
  tier-1 arm with *zero* tool lines, so the model judged the state from messages alone. With the plan in
  place, escalation drops from 23.5%/47% to 11.8% (`08-00`) and 26.7% (`11-16`), and the cascade now beats
  asking the window every step: 0.34s against 0.47s, and 0.41s against 0.47s. Escalation no longer tracks the
  tier-1 size (11.8% at 800/1800/4500 on `08-00`; 26.7% against 25.2% on `11-16`), so 800 stays the tier-1
  budget - the allocation was the problem, not the size.

## What landed in the extension (Oct 23)

The window lessons were transplanted into the live reminder path, not left in the probe:

- `decisionSessionContext` (`src/modules/decision/session-context.ts`) is now `planSessionWindow`: structured
  items carrying **every** tool call (`tool(<identifying argument>)`, bash still `command(<command>)`), with the
  newest user item, the newest assistant item and the newest two tool items always kept, the rest filled
  newest-first inside `WINDOW_CHARS` (1200), each item capped to `ITEM_CHARS` (240) before the budget is
  measured and clipped to its share newest-first. It used to be the newest four items and **bash-only**, so an
  `edit`, a `read`, an `agent` call or an `ask_user` never reached the model - the extension's version of the
  broken tier-1 window, and why its state had to be inferred from prose. The request stays its own field.
- `session-signals.ts` splits `.md` writes out of `files_modified`: a plan or memory edit no longer counts as a
  code change, so it does not infer `implementing`/`unvalidated` (it reads `wrapping_up`, the recording phase)
  and cannot arm the validation reminder.
- `availableRotationIds` drives the pool from the state: `validation` joined `memory-hygiene` in requiring
  produced work. **Known blind spot**: the scan sees the `edit`/`write` tools only, so work produced through
  bash - a heredoc, a redirect, `sed -i`, which is how this probe's own scratch scripts were written - leaves
  the gate false and the reminder unoffered for the model to score. Every gate is a quieting filter over the
  model's score, not a guarantee.
- No cascade. Escalation was size-independent once the window was composed well, so the live path keeps one
  consult per turn.
- A debug entry records `state: signals`, not the classifier state, so a window change cannot be validated from
  a recorded session: the request and `recent_messages` have to be rebuilt
  (`reminders/model-comparison.md` does exactly that). One recorded mid-run entry showed `available` containing
  `todo` while its own `state` carried no `todo` - whether the two are built at different points is unchecked.

## Open fork

Model-driven transitions only. Deterministic boundaries (write-path or test-runner rules) were considered and
**rejected**: they encode one project's layout, language and tooling, so they cannot be the general mechanism.
The question is only which model question drives the gate, how often it is asked, and how the turn boundary
is handled. The model's mid-run judgment did not beat the event rule often enough to justify a per-step call.
Two product defects found in the current signals:

- `applyWriteCall` in `src/modules/reminders/session-signals.ts` splits only memory paths and `TODO.md` out of
  `files`, so a `.md` doc write counts as `files_modified` and can set `unvalidated` - the validation reminder
  can fire after a plan edit.
- `decisionSessionContext` (`src/modules/decision/session-context.ts`) keeps user/assistant prose and bash
  commands only (`toolCallCommand` matches only `bash`), so the live reminder model never sees `ask_user`.
