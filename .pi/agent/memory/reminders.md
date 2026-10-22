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
because the message rides in the user role and a bare one would read as the user speaking. The memory module
owns the appendix and snapshot lifecycle.

## Files and schedule

- `catalog.ts` — the change-point reminders `MEMORY_READ_REMINDER` (session start, tree navigation) and
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
  rotation pointer just past the last emitted id, so an id the branch already showed is not repeated.
- `context-growth.ts` — the `message_start` usage baseline plus streamed `chars / 4` estimator lifted out of
  the memory module.
- `settings.ts` — `PI_CODER_REMINDER=false` disables everything; `PI_CODER_REMINDER_EVERY_TURNS` (default 5)
  and `PI_CODER_REMINDER_THRESHOLD` (default 30000, alias `PI_MEMORY_REMINDER_THRESHOLD`) each disable their
  trigger at `0`, and both at `0` also removes the model consult; `PI_CODER_REMINDER_MIDRUN_MAX` (default 1)
  caps the mid-run steers one user turn may receive; `PI_CODER_REMINDER_DEBUG` records a
  `pi-coder-reminder:debug` entry with the state and outcome of every selection decision, and is on by
  default for now (see `reminderDebugEnabled`).
- `index.ts` — `registerRemindersExtension(pi, { scope })`. `scope: "full"` is a parent session;
  `scope: "memory"` is for delegated children, registered by the `memories` capability factory beside the
  appendix, and emits only the session reminder.

Two delivery paths, both appending at the end of the conversation, so the system-prompt prefix stays stable:

- **User turns** (`before_agent_start`): the session reminder, the turn-based rotation, and the model policy.
- **Mid-run** (`message_update` only, when the context-growth estimate crosses
  `PI_CODER_REMINDER_THRESHOLD`): `pi.sendMessage(..., { deliverAs: "steer" })` queues the next rotation
  reminder into the running loop, injected after the current assistant turn and before the run's next
  inference, so a long autonomous stretch does not wait for the user to speak again. It exempts mid-run from
  "one per user turn" and steers only after the message emits a `toolcall_*` event: a tool call means the run
  continues, so the reminder cannot land after a final text-only answer. `message_start` never steers, the
  gate is computed once per message, and only the threshold applies here. Mid-run steers are capped at
  `PI_CODER_REMINDER_MIDRUN_MAX` (default 1) per user turn. Both paths share the emission bookkeeping, and
  full scope only - a memory-scoped child never steers mid-run.

`restart()` runs at three points. Session start (including reload, resume, and fork) and tree navigation
`seed()` from the branch: `reminderResumeState` reads each delivered reminder's `custom_message` entry, whose
`details` carry `{ id, turn }`, to rebuild `shown`, the last emitted rotation id, and the user-turn count, so
the pointer and cadence continue instead of restarting and `turns_ago` keeps a real origin. Compaction is a
full `reset(COMPACTION_REMINDER)`: the fold is a context reset, so pre-fold emissions are ignored, the
rotation restarts, and the fold's own reminder is armed in place of the memory one - it also names the
session JSONL and the runtime `TODO.md` a summary does not carry. Labels are branch-derived
(`reminderLabelsFromEntries`) in every case.

## Decision-model selection

With `decisionModel.reminders: true`, `consultReminderSelection` asks one probability question per offered
reminder before each non-session turn; the strongest answer at or above `reminderMinProbability` (default
0.45) is shown, and nothing at or above it means none. Signals, labels, and calibration:
[reminders/selection.md](reminders/selection.md).

## Replay

`npm run reminder-report -- <session.jsonl> [--turn N] [--turns N] [--compact] [--recorded] [--json]`
replays a session turn by turn, rebuilding the exact state that would be sent, simulating the schedule
(turn cadence and threshold interaction visible), and printing each turn's reminder in full (compact clips
it to one `shows=` line). It applies the activity gate and models a mid-run steer only for a tool-calling
assistant message, printing it with its emitting turn. A turn is a run-starting prompt; a steered message
stays under its run's turn and never reaches the decision.
A `compaction` entry is modeled as the live `session_compact` restart: the scheduler, the shown map, and
the context estimate reset there, the compaction reminder is armed, and the module turn counter restarts;
the report keeps global numbering and marks folds in the header and at the first post-fold turn. The
activity scan keeps reading the whole branch, which is what `getBranch()` serves live, so pre-fold facts
still enter post-fold state; a reload adds no entries and is replayed as it is.
`--recorded` shows what the session recorded: the `pi-coder-reminder:debug` decisions (scores, consult,
labels, judged signals) and the messages actually delivered, matched to their turns, warning when no debug
entries exist or a message carries no id/turn details. The file can lag a live session, so the newest turns
may show no record yet.
It reads the session's own memory-index, todo-snapshot, and reminder-state entries and respects
`PI_CODER_REMINDER_*`. Those entries keep the live choices for comparison. The script
is `scripts/reminder-report.mts`; the `.mts` and `src/package.json` (`type: module`) exist because the root
package is not ESM and the pi package is ESM-only under `node --import tsx`. `parseArgs`, `replay`, and the
renderers are exported; `tsconfig.check.json` enables `allowImportingTsExtensions` so the test can import the
script with the extension it must carry.

## Tests

`test/modules/reminders/{scheduler,emission,model-policy,session-signals,catalog,settings}.test.ts` cover the
pure schedule, the hidden-message emission, the decision-model wiring, the signal builder and gate, the
catalog
filter, and the settings defaults;
`test/modules/decision/reminder.test.ts` covers the subject, consult, and prompt clipping; the config key is
pinned in `test/modules/decision/config.test.ts`, and `test/scripts/reminder-report.test.ts` pins the replay
tool. `decision-model.md` covers the classifier plumbing this builds on.

## Targeted references

- `reminders/selection.md` — selection subject, signals, labels, calibration.
- `reminders/model-comparison.md` — clef/d3/lfm2 speed and real-state decisions.
- `reminders/state-experiments.md` — state-shape and question-form replays.