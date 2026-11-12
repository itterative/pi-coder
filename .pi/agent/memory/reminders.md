---
name: reminders
description: "pi-coder reminder module: what it emits, the two delivery paths, and the decision-model gate that picks a reminder."
category: architecture
priority: 8
keep_updated: true
---

# Reminders

`src/modules/reminders/` emits hidden pi-coder reminders as at most one custom message at the start of a user
turn, plus threshold-driven mid-run steers and the automatic memory audit's finding steer
(`customType: "pi-coder-reminder"`, `display: false`, wrapped in
`<pi_coder_reminder>`). Every block opens with `REMINDER_NOTICE` ("Automated reminder (not from the user)...")
because the message rides in the user role and a bare one would read as the user speaking.

They leave by a user turn or a mid-run steer; the module's files, cadence, env switches, and lifecycle are
`reminders/schedule.md`. **Everything held for one delivery point leaves
as a single message**: `pendingSteers` holds `{id, text, turn, contextTokens}` entries, `heldMessage` dedupes
them by id and joins the texts under one wrapper, and the combined message records every id in `details.ids` so
a restart can resume from it. Sending two payloads at one boundary was a real defect: pi delivered the first to
the next inference and the second on the next *user prompt*, which put a memory-audit finding a turn late.

## The automatic memory audit

One reminder is not advice but a defect report: `memory-audit`. `reminders/memory-audit.ts` stat-fingerprints both
memory trees at each step boundary and parses them only when that fingerprint moved; a finding set that differs
from the last one reported joins `pendingSteers` and is steered into the run that caused it. It bypasses the
rotation, the judged pool, and the decision model entirely - a memory that no longer parses is missing from every
later prompt, so the reminder is not something to weigh against relevance. A finding is announced once and deduped
on `tree path rule`, not on its message, so a multi-step repair is not reminded on every step of it; the reported
set shrinks to what is still outstanding, so a fixed finding is news again if it recurs. It also replaced the rule
that told agents to run the audit after every memory edit (2026-11).

## Measured context

`context-usage.ts` puts a count the model can trust in front of it: a model that assumes its own usage economizes
against a limit it does not have, worst right after a fold. Only a reading anchored on a counted reply after the
newest `changesCountBasis` row is shown as **Measured**. The 50%/75% thresholds and the post-fold fallback are
change points outside the rotation and the decision model; `PI_CODER_REMINDER_CONTEXT=false` disables them.
Details are `reminders/context-usage.md`.

## The gate that picks one

With `decisionModel.reminders: true`, `consultReminderSelection` asks one question per offered reminder and shows
the strongest answer at or above the gate - by default a helpfulness score (`reminderForm: "score"`,
`reminderMinScore` 1.25 on a 0-3 scale); the older per-reminder probability form (`"bool"`,
`reminderMinProbability`) measured flat. It answers on a user turn **and** on a mid-run threshold crossing, so
a mid-run point is decided rather than merely scheduled: a `none` there suppresses the steer the deterministic
pointer would have emitted. **A judgement is only made when the schedule is due**, and a reminder it picked may
not be emitted more often than its own floor (`PI_CODER_REMINDER_MODEL_TURNS`, default 5). The floor exists
because a threshold the run keeps crossing leaves every turn due: without it the model re-sent the same reminder
on consecutive turns (observed live in a long validating session, 2026-11). It is about emissions - a `none`
spends nothing - and a turn either gate skips calls no `decide` at all, because an absent answer must not fall
back to the deterministic rotation; the turn's debug entry records `skipped: true`. The state it sends is one
allocator-rendered conversation (`WINDOW_POLICY_REMINDER`), and the signals gate the pool instead of appearing
in that state.

**A mid-run decision point is a step boundary, not a streamed delta.** `turn_end` is where it is taken: pi
awaits that dispatch, the run's tools have already run, and a steer therefore lands after the turn and before
the next inference - the only point where delivering one is meaningful. `message_update` now carries only the
growth estimate. Two earlier mistakes compounded here, and both are pinned by tests: the consult ran on
`message_update` (so every delta of a long answer asked the same question), and the per-turn cap was checked
only in `decideMidRun`, i.e. *after* the consult, so once the budget was spent the module kept re-asking until
the turn ended and discarded every answer. Measured on one real session: 51,878 `trigger:"mid-run"` records,
98.9% of them re-asks of an unchanged state, 100% emitting nothing, 49,206 answered from the decision model's
own cache (so the whole cost was our branch read plus window allocation, ~160 ms each), and 199 MB of the
212 MB transcript. `ReminderScheduler.midRunDue` now honours the cap, and the trigger is the step.

`reminders/selection.md` is the subject itself - the signals, the labels, the calibration, and the threshold
accounting. `reminders/stage-gating.md` is the judged state that decides the pool, with the cascade behind it.

## Open items

- **Live `todo` updates are not happening** (user, 2026-10-25). Agents keep the runtime `TODO.md` stale through
a task and write it out only at the end, in full or in batches - the opposite of the reminder's own text ("keep
the runtime `TODO.md` from your prompt current as steps complete"). Reframed by the user as a **reminder** issue
rather than a prompt one: the module prompt's instruction is presumed fine, so the lever is on this side - the
`todo` entry's text, `states`, and `hasOpenTodo` gate (`availableRotationIds` in `session-signals.ts`), the
cadence deciding whether it is offered at all, and the selection gate above it. Not blocking, and left alone on
purpose while the tier-2 measurements ran.

## Tests

`test/modules/reminders/{scheduler,emission,model-policy,session-signals,catalog,settings,context-usage}.test.ts` cover the
pure schedule, the hidden-message emission (including the text-only step that must not steer), the decision-model
wiring (the cascade, the `turn_end` checkpoints, and a deferred turn reminder held until a tool step or handed
to the next prompt), the signal builder and state gate, the catalog filter, and the settings defaults;
`.../memory-audit.test.ts` covers the automatic audit - fingerprint-keyed parse, dedupe of an unchanged finding
set, the restart baseline, and the reminder text;
`.../reminder-window.test.ts` pins the tier-2 conversation - the allocator's rendering the selection consult
sends - to `__snapshots__/reminder-window.*.txt`;
`test/modules/decision/reminder.test.ts` covers the subject, both tiers, the carried window, and prompt
clipping; `test/scripts/reminder-report.test.ts` pins the replay tool. `decision-model.md` covers the
classifier plumbing this builds on.

## Targeted references

- `reminders/context-usage.md` — the trust rule, the 50%/75% thresholds, the post-fold estimate, the model-change
  fallback, and their state lifecycle.
- `reminders/selection.md` — selection subject, signals, labels, calibration, threshold accounting.
- `reminders/stage-gating.md` — the judged state and the cascade, the mid-run stage probe, the endpoint's cost
  shape, and the rejected two-tier cascade.
- `reminders/selection-corpus.md` — the S0-S11 state shapes and what each asked, the hindsight oracle and which
  half of it to trust, and what survived replication at 1.25.
- `reminders/schedule.md` — the module's files, cadence, env switches, and restart/fold lifecycle.
- `reminders/outline-nudge.md` — outline nudge trigger, quiet window, cooldown, seed.
- `reminders/replay.md` — reminder-report flags, fold modeling, recorded view, module/export contract.
- `reminders/model-comparison.md` — clef/d3/lfm2 speed and real-state decisions.
- `reminders/state-experiments.md` — state-shape and question-form replays.