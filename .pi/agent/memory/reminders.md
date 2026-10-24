---
name: reminders
description: "pi-coder reminder module: catalog, deterministic schedule, env switches, and the decision-model selection policy."
category: architecture
priority: 8
keep_updated: true
---

# Reminders

`src/modules/reminders/` emits hidden pi-coder reminders as at most one custom message at the start of a user
turn, plus threshold-driven mid-run steers (`customType: "pi-coder-reminder"`, `display: false`, wrapped in
`<pi_coder_reminder>`). Every block opens with `REMINDER_NOTICE` ("Automated reminder (not from the user)...")
because the message rides in the user role and a bare one would read as the user speaking.

## Files and schedule

- `catalog.ts` — the change-point reminders `MEMORY_READ_REMINDER` (session start) and
  `COMPACTION_REMINDER` (a fold) plus `ROTATION_REMINDERS`
  (memory-hygiene, sandbox, delegation, todo, validation), each with `text` and `guidance`. A `disabled: true`
  entry stays in the catalog but is filtered out of the rotation and the model's offer by
  `ACTIVE_ROTATION_REMINDERS`; `sandbox` is disabled until it keys on a real gated event rather than rotating
  context-free. Catalog texts stay extension-generic: they may name pi-coder mechanics but never one
  repository's commands, which live in that project's instructions and memories.
- `scheduler.ts` — pure `ReminderScheduler`: the armed change-point reminder first; otherwise rotation due
  after
  `everyTurns` user turns since the last emission or `thresholdTokens` new context tokens, whichever comes
  first. A model answer naming an offered id is chosen and advances the rotation past it; a deliberate `none`
  suppresses the fallback for that turn; a missing answer leaves the deterministic triggers in charge. The
  optional `available` gate narrows the rotation: the scheduler scans to the next allowed id, and a model pick
  outside the set is dropped with no fallback. Mid-run emissions are capped at `maxMidRunPerTurn` (default 1)
  per user turn, reset by each `decide`. `reset()` starts a fresh schedule; `seed()` resumes a populated
  branch (a tree move, reload, resume, or fork) with the user-turn count, the last emission turn, and the
  rotation pointer just past the last emitted id, so a shown id is not repeated. Neither arms anything on its
  own: the caller passes the reminder a restart point should arm.
- `context-growth.ts` — the `message_start` usage baseline plus streamed `chars / 4` estimator lifted out of
  the memory module.
- `settings.ts` — `PI_CODER_REMINDER=false` disables everything; `PI_CODER_REMINDER_EVERY_TURNS` (default 5)
  and `PI_CODER_REMINDER_THRESHOLD` (default 30000, alias `PI_MEMORY_REMINDER_THRESHOLD`) each disable their
  trigger at `0`, and both at `0` also removes the model consult; `PI_CODER_REMINDER_MIDRUN_MAX` (default 1)
  caps the mid-run steers one user turn may receive; `PI_CODER_REMINDER_DEBUG` records a
  `pi-coder-reminder:debug` entry with the state and outcome of every selection decision (default on,
  `reminderDebugEnabled`), including the window judged (the state ask's own `stateTranscript`), the tier-1
  `stateConfidence`, and `escalated`.
- `index.ts` — `registerRemindersExtension(pi, { scope })`. `scope: "full"` is a parent session;
  `scope: "memory"` is for delegated children, registered by the `memories` capability factory beside the
  appendix, and emits only the session reminder. A full-scope session also publishes the judged phase.

Two delivery paths, both appending at the end of the conversation, so the system-prompt prefix stays stable:

- **User turns** (`before_agent_start`): the session reminder, the turn-based rotation, and the model policy.
- **Mid-run** (`message_update` only, when the context-growth estimate crosses
  `PI_CODER_REMINDER_THRESHOLD`): `pi.sendMessage(..., { deliverAs: "steer" })` queues the next rotation
  reminder into the running loop, so a long autonomous stretch does not wait for the user to speak again. It
  steers only after the message emits a `toolcall_*` event: a tool call means the run continues, so the
  reminder cannot land after a final text-only answer. `message_start` never steers, the gate is computed once
  per message, and only the threshold applies here. Both paths share the emission bookkeeping, and full scope
  only - a memory-scoped child never steers mid-run.

`restart()` runs at three points. Session start (including reload, resume, and fork) seeds from the branch
and arms the memory reminder, since the appendix is rebuilt for a new session; a tree navigation seeds the
same way but arms nothing, because landing on an existing branch mid-conversation is not a starting point -
the rebuilt `<memory_system>` list is already in the next prompt. `reminderResumeState` reads each delivered
reminder's `custom_message` entry, whose `details` carry `{ id, turn }`, to rebuild `shown`, the last emitted
rotation id, and the user-turn count, so
the pointer and cadence continue instead of restarting and `turns_ago` keeps a real origin. Compaction is a
full `reset(COMPACTION_REMINDER)`: the fold is a context reset, so pre-fold emissions are ignored, the
rotation restarts, and the fold's own reminder is armed in place of the memory one. Labels are branch-derived
(`reminderLabelsFromEntries`) in every case.

## Decision-model selection

With `decisionModel.reminders: true`, `consultReminderSelection` asks one question per offered reminder
before each non-session turn. The default form is a helpfulness **score** (`reminderForm: "score"`,
`reminderMinScore` default 1.0 on a 0-3 scale); the strongest answer at or above the gate is shown, and
nothing at or above it means none. `reminderForm: "bool"` restores the older per-reminder probability
question (`reminderMinProbability` default 0.45), which measured as flat. The activity gate narrows the
offer too, and it is the **judged state** that does it: each rotation reminder names the states it is
offered in, plus `todo`'s own readable-list-with-open-items gate. The state is the `--states doc` set
(`discussing | exploring | implementing | validating | documenting | reporting`), judged by a two-tier
cascade: tier 1 asks `next_state` against `{current_state, conversation}` on a short (800-char) transcript
to build the pool, and an unsure answer escalates to the same question at 1800 as its own call, while the
pool's questions keep their own state. The state is judged again on every **tool-using response**
(`turn_end`, `trigger: "checkpoint"`), which moves the badge mid-run; the rotation judgement is deferred
into a steer. Signals plus the sent shape: [reminders/selection.md](reminders/selection.md),
[reminders/stage-gating.md](reminders/stage-gating.md).

## Replay

`npm run reminder-report -- <session.jsonl> [...]` replays the deterministic schedule and the state each turn
would send, and `--recorded` shows what the session itself recorded.
[reminders/replay.md](reminders/replay.md) carries the flags, the fold modeling, the export contract, and why
the script is `.mts`.

## Tests

`test/modules/reminders/{scheduler,emission,model-policy,session-signals,catalog,settings}.test.ts` cover the
pure schedule, the hidden-message emission, the decision-model wiring (the cascade and the `turn_end`
checkpoints), the signal builder and state gate, the catalog filter, and the settings defaults;
`.../reminder-window.test.ts` pins the rendered window to `__snapshots__/reminder-window.*.txt`;
`test/modules/decision/reminder.test.ts` covers the subject, both tiers, the carried window, and prompt
clipping; `test/scripts/reminder-report.test.ts` pins the replay tool. `decision-model.md` covers the
classifier plumbing this builds on.

## Targeted references

- `reminders/selection.md` — selection subject, signals, labels, calibration.
- `reminders/replay.md` — reminder-report flags, fold modeling, recorded view, module/export contract.
- `reminders/model-comparison.md` — clef/d3/lfm2 speed and real-state decisions.
- `reminders/state-experiments.md` — state-shape and question-form replays.
- `reminders/stage-gating.md` — mid-run stage probe, the endpoint's cost shape, and the rejected two-tier cascade.
