---
name: schedule
description: "The reminder module's files, cadence, env switches, and the restart/fold lifecycle."
category: architecture
keep_updated: true
---

# Module files, cadence, and lifecycle

Everything here belongs to `src/modules/reminders/`; the index's `reminders.md` carries what the module is and
where the decision-model gate lives.

## Files

- `catalog.ts` — the change-point reminders `MEMORY_READ_REMINDER` (session start) and
  `COMPACTION_REMINDER` (a fold) plus `ROTATION_REMINDERS`
  (memory-hygiene, sandbox, delegation, todo, validation), each with `text` and `guidance`. A `disabled: true`
  entry stays in the catalog but is filtered out of the rotation and the model's offer by
  `ACTIVE_ROTATION_REMINDERS`; `sandbox` is disabled until it keys on a real gated event rather than rotating
  context-free. Catalog texts stay extension-generic: they never name one repository's commands, which live in
  that project's instructions and memories.
- `scheduler.ts` — pure `ReminderScheduler`: the armed change-point reminder first; otherwise rotation due
  after
  `everyTurns` user turns since the last emission or `thresholdTokens` new context tokens, whichever comes
  first. A model answer naming an offered id is chosen and advances the rotation past it; a deliberate `none`
  suppresses the fallback for that turn; a missing answer leaves the deterministic triggers in charge. The
  optional `available` gate narrows the rotation: the scheduler scans to the next allowed id, and a model pick
  outside the set is dropped with no fallback. Mid-run emissions are capped at `maxMidRunPerTurn` (default 1)
  per user turn, reset by each `decide`; `decideMidRun` takes the same `modelChoice`, so a mid-run crossing is
  decided rather than merely scheduled - a decline spends that budget and restarts the threshold cooldown
  (leaving `lastEmitTurn` alone), which is what keeps an overdue threshold from re-asking on the next streamed
  update. `reset()` starts a fresh schedule; `seed()` resumes a populated
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

## The two delivery paths

Both append at the end of the conversation, so the system-prompt prefix stays stable:

- **User turns** (`before_agent_start`): the session reminder, the turn-based rotation, and the model policy.
- **Mid-run** (`message_update` only, when the context-growth estimate crosses
  `PI_CODER_REMINDER_THRESHOLD`): `pi.sendMessage(..., { deliverAs: "steer" })` queues the next rotation
  reminder into the running loop, so a long autonomous stretch does not wait for the user to speak again. It
  steers only after the message emits a `toolcall_*` event: a tool call means the run continues, so the
  reminder cannot land after a final text-only answer. `message_start` never steers, the gate is computed once
  per message, and only the threshold applies here. The decision is consulted first, when the decision model
  has opted into reminders: the tier-2 question on the judged state, with no `request` of its own (inside a run
  the branch's last user message is the turn's request), no tier-1 re-judge (the checkpoints keep the labels
  current) and no TODO query (it reads a new request). Without it the rotation always has an answer, so a
  crossing could never be refused; a disabled or unreadable consult leaves the pointer in charge. An in-flight
  flag keeps one crossing from asking once per streamed delta. Both paths share the emission bookkeeping, and
  full scope only - a memory-scoped child never steers mid-run.

## Lifecycle: start, navigation, and the fold

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

A fresh scheduler's first threshold check compares the *absolute* context against `thresholdTokens`, since
there is no baseline yet, so a reload or fold can emit within a turn or two of the restart. The branch-derived
`ReminderResumeState.baselineContext` is what keeps a resume from re-firing; a session recorded before that
landed over-counts its fires.