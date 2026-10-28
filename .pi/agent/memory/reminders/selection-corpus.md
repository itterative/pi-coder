---
name: selection-corpus
description: "The tier-2 reminder-selection measurement: what the S0-S11 shapes are, what the hindsight oracle is and which half of it to trust, and what survived replication at the 1.25 gate."
category: architecture
keep_updated: true
---

# Tier-2 reminder selection: the shapes, the oracle, and the corpus

The tier-2 reminder-selection consult asks the decision model which reminder, if any, the coming turn should get.
This doc owns the *measurement* of that consult's state: the candidate states, the hindsight oracle they are
judged against, the schedule those decisions happen on, and what survived replication. The allocator that renders
the state is `decision-model/window.md`; the selection subject itself is `reminders/selection.md`; the rotation's
pool and cascade are there too.

**What production sends now.** `consultReminderSelection` runs `selectWindow(items, WINDOW_POLICY_REMINDER)` over
`decisionSessionContext`'s raw atoms and sends the single field `conversation: lines.join("\n")` - nothing else,
and no `request` field beside it, because the conversation's newest `User:` line is the request. `WINDOW_POLICY_REMINDER`
is `{ ...WINDOW_POLICY_PLAN, budget: 2000 }`, a named constant so production and the probe's S11 reference one
policy and cannot drift. Where the branch does not carry the turn's prompt yet (the `before_agent_start` override,
and the deferred judgement that reads the branch before pi's write lands), `reminderConversationAtoms` appends it
as its own newest user item, the way `windowTranscript` already did for the state ask - a no-op when the branch
already holds that request, which is the mid-run case, so at the measured points this is byte-identical to S11.
`buildReminderState` is gone from `src/`; the tier-2 cache key is conversation, options and form, because those
are the bytes the request carries; `ReminderConsult.window` records the allocator's kept items at the lengths they
were sent, so a debug entry or a replay shows the window that was read rather than a planner window that was
discarded. `ReminderContext.recent` and `.signals` are no longer read by this subject - the fields remain on the
shared interface for the other subjects' sake, but do not assume the tier-2 state still carries them.

**The gate moved with it:** `DEFAULT_REMINDER_MIN_SCORE` is 1.25 (see below for why 1.0 was wrong).

## What the shapes are (S0-S11), and what each was asked

Every shape is a candidate *state* for the same question, sent with the same `reminderChoiceRequest` and the same
offered pool, so the state is the only variable. They live in `.pi/local/reminder-state/turn_shapes.mts`, which
builds each one from the same branch prefix and replays it at the module's own evaluation points.

| id | state | what it was asked |
|----|-------|-------------------|
| S0 | `request` + `recent_messages` + `cwd` + `session` + `todo` + `memories` | the structured state production sent before S11; the baseline |
| S1 | S0 minus `recent_messages` | does the window matter at all, given the signals |
| S2 | S1 + `conversation` = the planner's window rendered as text | one rendering instead of structured fields |
| S3 | that rendering, signals dropped | is it the rendering or the signals |
| S4 | S1 + `conversation` = the tier-1 transcript (800 chars) | the phase ask's window, which already reads well |
| S5 | S1 + `conversation` = `WINDOW_POLICY_CONVERSATION` | the allocator: message-heavy, markers dropped |
| S6 | S1 + `conversation` = `WINDOW_POLICY_TRANSCRIPT` | the allocator: tier-1 caps, `keepTurns` 3, markers forced |
| S7 | S1 + `conversation` = `WINDOW_POLICY_PLAN` | the allocator: tier-2 numbers, markers compete |
| S8 / S9 / S10 | S5 / S6 / S7 with the signals dropped | S3's shape with each allocator window |
| **S11** | **S10 at a 2000-char budget** | **the winner, and what production sends** |
| S12 | the oracle's own policy at 1200 chars | ablation: is it the policy's shape or its size |
| S13 | S10 with the oracle's caps (2000/400) and perTurn (12/16) | ablation: are we clipping the messages away |
| S14 | S10 with message weights (user/assistant 2 against tool 0.85) | ablation: is it how the item kinds are ranked |
| S15 | S14's weights at 2000 chars | do the two knobs that helped on their own add up |

Conventions that trip people up: S2-S7 carry the request inside the conversation as its last `User:` line and drop
the separate `request` field, and S8+ inherit that; S0 and S1 keep the field, because their state has no
conversation to carry it. The allocator shapes take `decisionSessionContext`'s raw `items`, not its planned
`recent`. S0's builder no longer exists in `src/`, so the probe keeps its own copy purely so the baseline that
ended the comparison stays re-runnable.

## What the oracle is

`oracle_label.mts --points mid-run` labels an evaluation point with **hindsight**: it is told what happened after
the point and asked how much a reminder would have helped. It is a model's opinion, not ground truth, and its two
halves have very different reliability.

- **The state it reads is deliberately shape-independent**: `conversation` (the branch up to the point, 24 000
  chars), `reminders_shown` (what the module already delivered, newest first), and `what_happened_next` (4 000
  chars: the rest of that turn plus up to one further user turn). No `signals`, no `recent_messages`, no `request`
  field - if the oracle read those, it would be a self-fidelity test of the shape under test instead.
- **Questions**: four `score` questions, one per reminder, on `ORACLE_LADDER` = `no help / mild / useful /
  important` (a score is a point on `[0, 3]`), plus one `best` `choice` over the four ids and `none`.
- **Believe the scores, not `best`.** `best` disagrees with the ladder's own argmax on 23 of 40 points, and on 4
  of the 12 points where the ladder is confident; `bestConfidence` averages 0.35 and is *lowest* where the ladder
  is strongest (0.26-0.27 at the two strongest points). `ideal` is not a second opinion either - it is exactly
  `{score >= idealScore}`, default 1.0. And `labelFrom` is `"choice"` on every entry, so every label in every
  corpus came from the untrustworthy half.
- **Consequence**: measure agreement per reminder against the *scores*. A "constant most-common label" baseline
  over an argmax measures option order, not any shape - the ladder is flat, and memory-hygiene and validation had
  identical mean scores while being picked 24 and 2 times.

## The schedule the decisions happen on

The rotation does not decide at turn starts. `message_update` -> `maybeEmitMidRun` -> `scheduler.decideMidRun` ->
`nextAvailableRotation(available)`: a deterministic pick over the phase-gated pool with **no model call** (the
`mid-run` debug records carry no `modelChoice`/`scores`; the `turn` ones do). The trigger is 30 000 tokens of
context growth since the last delivery (`DEFAULT_REMINDER_THRESHOLD`) or 5 user turns
(`DEFAULT_REMINDER_EVERY_TURNS`), whichever comes first, capped at one mid-run reminder per user turn
(`DEFAULT_REMINDER_MIDRUN_MAX`).

A turn-boundary replay therefore evaluates points live never evaluates, and every boundary-schedule number
measured before `--points mid-run` existed is void. Two things to exclude or explain in a mid-run corpus:

- **Turn starts wearing a mid-run record.** 9 of `01a16a00`'s 40 mid-run points sit immediately after a user
  message - mid-run by code path, a turn start in content, nothing finished behind them. They behave like the
  boundary corpus (ladder top memory-hygiene 7 / validation 2) where the other 31 do not (validation 13 /
  memory-hygiene 12), so they are excluded from every figure here.
- **Fires on a fresh baseline.** 13 of those 40 fires carry `thresholdBaseline: 0` with `userTurns: 1`: a reload or
  a fold left a fresh scheduler, whose first threshold check compares the *absolute* context against 30 000, so the
  fire lands within a turn or two of a restart. `ReminderResumeState.baselineContext` landed after that session,
  so it is stale-code behaviour - but a session from before it over-counts fires.

## How shapes are judged (the cross-validation)

Compare the per-reminder **scores** at a **matched threshold**, not a single winner. One point times the reminders
a shape was offered is a pair-observation, which is why this has power where a pick-accuracy figure over a dozen
points does not: Cohen's kappa has a standard error of roughly `1/sqrt(n)`, ~0.09 at 171 pairs.

**The gate is 1.25.** `DEFAULT_REMINDER_MIN_SCORE` used to be 1.0, but 1.0 is the *median of the model's own
answers* on that scale, so it fires about half the time by construction - while the deterministic pointer fires on
100% of mid-run points where the oracle credits something on only 9-10% at 1.25. Every comparison here is at 1.25;
1.0 figures are context, not results.

**Power caveat:** at 1.25 the oracle credits a reminder on only 16 of 171 pair-observations (9%), against 48 of
137 (35%) at 1.0. The gate the module ships is also the one with the least room to rank shapes, so the per-session
kappas below are low-precision estimates.

## What the results were

Pooled over three sessions at T=1.25 (70 after-work points, 171 pair-observations; `01a16a00` 31pt, `01a1729d`
25pt, `01a16093` 14pt), per-session kappa after each:

| shape | pooled kappa | per session | above chance |
|-------|--------------|-------------|--------------|
| S11 | 0.28 | 0.35 / 0.23 / -0.04 | 2 of 3 |
| S10 | 0.19 | 0.26 / 0.06 / 0.00 | 1 of 3 |
| S14 | 0.17 | 0.30 / 0.04 / -0.09 | 1 of 3 |
| S8 | 0.11 | 0.18 / 0.12 / -0.08 | 2 of 3 |
| S2 | 0.09 | 0.23 / -0.09 / -0.08 | 1 of 3 |
| S7 | 0.05 | 0.05 / 0.07 / -0.06 | 0 of 3 |
| S3 | 0.04 | 0.18 / -0.11 / -0.10 | 1 of 3 |
| S5 | -0.02 | -0.11 / 0.15 / -0.06 | 1 of 3 |

**What replicated, and what died:**

- **The signal fields hurt the allocator shapes.** S5 -0.02 -> S8 0.11 and S7 0.05 -> S10 0.19, +0.14 each, on
  both allocator policies. The production-renderer pair did *not* replicate (S2 0.09 -> S3 0.04, -0.05), so the
  claim is narrower than it first looked: the allocator's window is better without the signals.
- **S3's precision edge was one session.** Precision 0.68 with 6 false positives in 84 pairs on `01a16a00`,
  0.36 with 9 on `01a1729d`; kappa 0.33 / 0.05. The production renderer without signals is not better than the
  allocator without signals, and it was the session the shape was first measured on that made it look so.
- **The budget knob does not compose, and the weight knob does not replicate.** S15 (S14's weights at 2000 chars)
  is worse than either parent (r 0.33 against 0.41 and 0.39), and S14's advantage at 1.25 is 0.30 / 0.04 across
  sessions. Both were within-noise gains; two of those combining into a loss is what noise looks like in hindsight.
- **The allocator's caps never bind at these budgets.** S13 (S10 plus the oracle's caps 2000/400 and perTurn
  12/16) renders 1368 chars against S10's 1367 and moves kappa by 0.02: the budget's per-item *shares* clip to
  ~80-120 chars first, so `caps: 240` was never what starved the shape.
- **Every shape under-fires `validation` and over-fires `todo`.** At T=1.0 the misfires are structural:
  `validation` is wanted on 15 of 31 points and the best recall was 8; `todo` is wanted on 10 and 8 of those are
  unreachable because the phase list withholds it, while shapes fire it whenever it *is* offered; and every shape
  rejects `delegation` (0-1 false positives in 84 pairs) where the deterministic pointer fires it 6 times.

**Ceiling and the real constraint.** The best pooled kappa is 0.30 (S11 at T=1.25 on two sessions, F1 0.39), so
these states capture roughly a third of what the oracle sees - and the oracle is another model's hindsight
opinion, so kappa measures agreement with it rather than correctness. Above all, the **pool** remains binding, not
the renderer: the phase's `states` list plus the TODO and activity gates decide what is offered, and it makes the
oracle's chosen reminder unavailable on 15 of 40 mid-run points. The phase is fragile by construction - the
accept-rule anchor is self-reinforcing, so one confident answer freezes it for the rest of a session - and
`turn_shapes.mts --recalc-phase` re-judges it with the tier-1 cascade (short window, escalate under
`PHASE_MOVE_CONFIDENCE`, accept rule fed forward). On `01a16a00` that answered `discussing` at 0.51-0.62 where the
branch's own labels said `validating`; the rendered-conversation tier-1 update landed after that session, so its
stuck phase is old code. Wiring S11 did not touch any of that.

## The mid-run point that made the case for consulting (01a17500)

The session the user saw two reminders in: one turn, 54 tool calls, one mid-run crossing at 36 758 tokens. Its
single mid-run point (`a585a674`, phase `exploring`, pool the singleton `[delegation]`) is the clearest example
of the pointer being a schedule rather than a judgement, because both halves of the oracle and the shape agree:

  oracle (hindsight)  memory-hygiene 0.845  delegation 0.739  todo 0.558  validation 0.453  -> best `none`
  S11 replay          delegation 0.68                                                       -> `none`
  live pointer        delegation                                                             -> emitted

Nothing clears the 1.25 gate, and `ideal` is empty, so the gate and the pointer disagree about whether this
point deserved a reminder at all. The oracle's top score is `memory-hygiene`, whose `states` do not include
`exploring` - it ranks the reminder for the phase the turn was about to enter (`PLAN.md` was written next),
which is the timing mismatch in one line. S11's state cost 1356 chars / 608 input tokens / ~311 ms; S3, S10 and
S14 scored 0.64, 0.70, 0.70 on the same point and fired the same id, so the gate decided, not the shape.

Pool sizes over the 105 mid-run points recorded in this project's sessions: **9 singleton** (7 `delegation`, 2
`todo`), 96 multi-option. So a mid-run consult is not mainly a veto - in ~91% of points the model's pick would
replace the rotation pointer, and only the gate's refusal rate keeps it from changing every emission.

Replaying S11 on the 45 mid-run points of the three labelled sessions predicts the effect: the pointer emitted at
45/45, S11 fires at **10/45 (22%)** at the shipped 1.25 gate, so ~78% of mid-run steers would be suppressed. The
recorded `fired` field in `shapes_1729d.json` / `shapes_16093.json` was produced at the old 1.0 gate and matches a
1.0 recompute 44/44, so recompute before quoting a fire rate from an old replay file.

**Decision (user, 2026-10-25): consult at mid-run.** `decideMidRun` now takes the same `modelChoice` a turn does -
a named id is emitted, `none` declines, an id the gate withholds shows nothing - and a decline spends the turn's
mid-run budget and restarts the threshold cooldown so an overdue threshold cannot re-ask on the next streamed
update. The consult is tier 2 only: no tier-1 re-judge (the checkpoints keep the labels current), no TODO query
(it reads a new request), and no `request` field (inside a run the branch's last user message is the turn's
request, so `reminderConversationAtoms` appends nothing). A disabled or unreadable consult leaves the pointer in
charge, which is the module's existing failure policy. Declines are recorded in the debug entry, so a replay can
see a refused point.

## Running it

```
# label a session's own mid-run points with the oracle (~10k input tokens/point)
npm run scratch -- .pi/local/reminder-state/oracle_label.mts <session.jsonl> --points mid-run --out labels.json

# replay shapes at the same points against those labels
npm run scratch -- .pi/local/reminder-state/turn_shapes.mts <session.jsonl> --points mid-run \
  --shapes S3,S10,S11,S14 --labels labels.json --out shapes.json
```

`--points mid-run` is required for both; the two join on `${session}|${point}`, where `point` is the mid-run
record's entry id. `--min-score N` keeps only points whose oracle *top* score is >= N - it selects points and never
answers, so no reminder's chance of being correct changes, only the sample. Other probes in that directory:
`read_window.mts` (a session rendered through the allocator, for reading), `screen_sessions.mts` (which sessions
hold consult records), `window_policies.mts` (one turn per policy), `extract_intraturn.mts`. `npm run scratch --`
bundles and runs them; the directory is gitignored.