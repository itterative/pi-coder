---
name: reminders
description: "pi-coder reminder module: what it emits, the two delivery paths, and the decision-model gate that picks a reminder."
category: architecture
priority: 8
keep_updated: true
---

# Reminders

`src/modules/reminders/` emits hidden pi-coder reminders as at most one custom message at the start of a user
turn, plus threshold-driven mid-run steers (`customType: "pi-coder-reminder"`, `display: false`, wrapped in
`<pi_coder_reminder>`). Every block opens with `REMINDER_NOTICE` ("Automated reminder (not from the user)...")
because the message rides in the user role and a bare one would read as the user speaking.

They leave by one of two paths - a user turn, or a mid-run steer - and the module's files, cadence, env
switches and restart/fold lifecycle are `reminders/schedule.md`.

## The gate that picks one

With `decisionModel.reminders: true`, `consultReminderSelection` asks one question per offered reminder and shows
the strongest answer at or above the gate - by default a helpfulness score (`reminderForm: "score"`,
`reminderMinScore` 1.25 on a 0-3 scale); the older per-reminder probability form (`"bool"`,
`reminderMinProbability`) measured flat. It answers on a user turn **and** on a mid-run threshold crossing, so
a mid-run point is decided rather than merely scheduled: a `none` there suppresses the steer the deterministic
pointer would have emitted. The state it sends is one allocator-rendered conversation
(`WINDOW_POLICY_REMINDER`), and the signals gate the pool instead of appearing in that state.

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

`test/modules/reminders/{scheduler,emission,model-policy,session-signals,catalog,settings}.test.ts` cover the
pure schedule, the hidden-message emission, the decision-model wiring (the cascade and the `turn_end`
checkpoints), the signal builder and state gate, the catalog filter, and the settings defaults;
`.../reminder-window.test.ts` pins the tier-2 conversation - the allocator's rendering the selection consult
sends - to `__snapshots__/reminder-window.*.txt`;
`test/modules/decision/reminder.test.ts` covers the subject, both tiers, the carried window, and prompt
clipping; `test/scripts/reminder-report.test.ts` pins the replay tool. `decision-model.md` covers the
classifier plumbing this builds on.

## Targeted references

- `reminders/selection.md` — selection subject, signals, labels, calibration, threshold accounting.
- `reminders/stage-gating.md` — the judged state and the cascade, the mid-run stage probe, the endpoint's cost
  shape, and the rejected two-tier cascade.
- `reminders/selection-corpus.md` — the S0-S11 state shapes and what each asked, the hindsight oracle and which
  half of it to trust, and what survived replication at 1.25.
- `reminders/schedule.md` — the module's files, cadence, env switches, and restart/fold lifecycle.
- `reminders/replay.md` — reminder-report flags, fold modeling, recorded view, module/export contract.
- `reminders/model-comparison.md` — clef/d3/lfm2 speed and real-state decisions.
- `reminders/state-experiments.md` — state-shape and question-form replays.