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

- `catalog.ts` — the change-point reminders `MEMORY_READ_REMINDER` (session start),
  `COMPACTION_REMINDER` (a fold), `MEMORY_AUDIT_REMINDER` (an automatic-audit finding), the measured-context
  trio `CONTEXT_HALF_REMINDER` / `CONTEXT_TIGHT_REMINDER` / `CONTEXT_AFTER_FOLD_REMINDER`, `OUTLINE_NUDGE_REMINDER`
  (repeated searches without `outline`), plus `ROTATION_REMINDERS`
  (memory-hygiene, sandbox, delegation, todo, validation), each with `text` and `guidance`. A `disabled: true`
  entry stays in the catalog but is filtered out of the rotation and the model's offer by
  `ACTIVE_ROTATION_REMINDERS`; `sandbox` is disabled until it keys on a real gated event rather than rotating
  context-free. Catalog texts stay extension-generic: they never name one repository's commands, which live in
  that project's instructions and memories. `COMPACTION_REMINDER` leads with the room the fold reclaimed, not
  with its loss, and tells the model to keep going: a "you nearly ran out / the summary is lossy" frame makes
  models wrap up, hand off, or re-plan (user, 2026-03). The session-JSONL pointer stays, framed as a fallback
  for one missing pre-fold detail rather than an invitation to re-read the transcript.
- `memory-audit.ts` — the automatic memory-tree audit: a stat fingerprint (paths, sizes, mtimes, top-level and
  nested) of both trees, a parse only when it moved, and a reminder text only when there is news. News is
  keyed on a finding's **identity** - `tree path rule` - not its message, so a repair that spans steps is told
  once: a still-broken file, or a failed attempt that only changes the YAML error text, is the same defect. The
  reported set is *replaced* by what is still outstanding on every audit, so a fixed finding is pruned and is
  news again if it comes back; the reminder lists only the new identities and counts the outstanding ones
  without restating them. The baseline is reseeded at every restart point, so pre-existing findings are never
  reported as the run's doing; `reseed` is generation-stamped so a late read from a session being left cannot
  install its baseline. It is built and checked by the `turn_end` handler in `index.ts`, for both scopes, and
  its finding is pushed into `pendingSteers` like a rotation pick, so both leave together as one message.
- `scheduler.ts` — pure `ReminderScheduler`: the armed change-point reminder first; otherwise rotation due
  after `everyTurns` user turns since the last emission or `thresholdTokens` new context tokens, whichever comes
  first. **The schedule gates the model too**: a model pick is only emitted on a due turn, so the cadence is not
  bypassed by an eager answer. On top of that the model has a floor of its own (`modelEveryTurns`, from
  `PI_CODER_REMINDER_MODEL_TURNS`, default 5): at most one model-picked reminder per that many turns, on a turn
  and on a mid-run point alike, because a sticky threshold leaves every turn due. The floor is about emissions,
  so `none` spends nothing; `seed()` anchors it on the branch's `lastEmitTurn`. `turnDue()` and `modelTurnDue()`
  are the read-only halves the caller uses to skip a consult it could not act on. A model answer naming an offered
  id is chosen and advances the rotation past it; a deliberate `none` suppresses the fallback for that turn; a
  missing answer leaves the deterministic triggers in charge. The optional `available` gate narrows the rotation:
  the scheduler scans to the next allowed id, and a model pick outside the set is dropped with no fallback.
  Mid-run emissions are capped at `maxMidRunPerTurn` (default 1) per user turn, reset by each `decide`;
  `decideMidRun` takes the same `modelChoice`, so a mid-run crossing is decided rather than merely scheduled -
  a decline spends that budget and restarts the threshold cooldown (leaving `lastEmitTurn` alone), which is what
  keeps an overdue threshold from re-asking on the next streamed update. `reset()` starts a fresh schedule;
  `seed()` resumes a populated branch (a tree move, reload, resume, or fork) with the user-turn count, the last
  emission turn, and the rotation pointer just past the last emitted id, so a shown id is not repeated. Neither
  arms anything on its own: the caller passes the reminder a restart point should arm.
- `context-growth.ts` — the `message_start` usage baseline plus streamed `chars / 4` estimator lifted out of
  the memory module.
- `context-usage.ts` — the measured-context reminders: the trust rule (a counted reply after the newest
  `changesCountBasis` row), the 50%/75% threshold tracker, the post-fold estimate, and the model-changed one-shot.
  See `context-usage.md`.
- `outline-nudge.ts` — the step-boundary nudge after repeated `rg`/`grep` searches without `outline`: the search
  classifier (pipes and heredoc bodies excluded), the two-searches threshold, the 20-call quiet window, the
  8-turn cooldown, the post-fold branch seed, and the bounded `{recent_conversation, command, output}` gate
  state. The selection model gates the emission whenever the decision model is enabled; see `outline-nudge.md`.
- `settings.ts` — `PI_CODER_REMINDER=false` disables everything; `PI_CODER_MEMORY_AUDIT=false` disables only the
  automatic memory audit; `PI_CODER_REMINDER_MODEL_TURNS` (default 5) is the model's own floor, `0` for none;
  `PI_CODER_REMINDER_EVERY_TURNS` (default 5) and `PI_CODER_REMINDER_THRESHOLD` (default 30000, alias
  `PI_MEMORY_REMINDER_THRESHOLD`) each disable their trigger at `0`, and both at `0` also removes the model
  consult; `PI_CODER_REMINDER_MIDRUN_MAX` (default 1) caps the mid-run steers one user turn may receive;
  `PI_CODER_REMINDER_CONTEXT=false` disables the measured-context reminders without touching the rest;
  `PI_CODER_REMINDER_OUTLINE=false` disables the outline nudge alone;
  `PI_CODER_REMINDER_DEBUG` records a `pi-coder-reminder:debug` entry with the state and outcome of every
  selection decision (default on, `reminderDebugEnabled`), including the window judged (the state ask's own
  `stateTranscript`), the tier-1 `stateConfidence`, and `escalated`.
- `index.ts` — `registerRemindersExtension(pi, { scope })`. `scope: "full"` is a parent session;
  `scope: "memory"` is for delegated children, registered by the `memories` capability factory beside the
  appendix, and emits only the session reminder. A full-scope session also publishes the judged phase.

## The two delivery paths

Both append at the end of the conversation, so the system-prompt prefix stays stable:

- **User turns** (`before_agent_start`): the session reminder, the turn-based rotation, and the model policy.
  The armed session/fold reminders are returned synchronously and ride the user message. A rotation turn is only
  *judged* when `turnDue()` says the schedule is due and `modelTurnDue()` says the model's floor is open; either
  gate failing skips the consult and calls no `decide` (`judged.skipped`, recorded on the debug entry), because
  the model being in charge makes an absent answer non-authoritative for the fallback. A rotation pick is
  deferred, and when the run is in flight the payload is **held in `pendingSteers`** rather than steered at
  once: it is flushed on the first `turn_end` with a tool result, or sent as `nextTurn` from `agent_settled` if
  the run's answer was terminal. Steering earlier let pi poll the queue after a text-only turn and start a new
  inference just to deliver the reminder after the final answer. `rotationReminderTurn` records the turn whose
  rotation slot is taken, so the mid-run gate cannot show a second reminder in that same turn.
  **Everything a delivery point holds leaves as one message** (`heldMessage`/`sendHeld`): pi delivers a queued
  steer before the next inference but two sends at one boundary cost a delivery each, and the second arrived on
  the next *user prompt* - observed live, with a memory-audit finding a whole turn late. Held entries are
  `{id, text, turn, contextTokens}`, deduped by id with the newest winning; the combined message records the
  newest id as `details.id` and every id in `details.ids`, which `reminderResumeState` reads so a restart seeds
  `shown` from all of them. One wrapper and one "automated" notice per message, by construction.
- **Mid-run** (`turn_end` with tool results, when the context-growth estimate crosses
  `PI_CODER_REMINDER_THRESHOLD`): `pi.sendMessage(..., { deliverAs: "steer" })` queues the next rotation
  reminder into the running loop, so a long autonomous stretch does not wait for the user to speak again. The
  decision point is the **step boundary** - pi awaits that dispatch, the step's tools have run, and a steer
  lands after the turn and before the next inference, the only point where delivering one means anything.
  `message_update` contributes only the growth estimate; streaming never consults. A step with no tool result
  may be the run's last, so it steers nothing. The gate is computed once per step, and only the threshold
  applies here. The decision is consulted first, when the decision model has opted into reminders: the tier-2
  question on the judged state, with no `request` of its own (inside a run the branch's last user message is
  the turn's request), no tier-1 re-judge (the checkpoints keep the labels current) and no TODO query (it reads
  a new request). Without it the rotation always has an answer, so a crossing could never be refused; a disabled
  or unreadable consult leaves the pointer in charge. The per-turn cap is checked in `midRunDue` *before* the
  consult, so a spent budget costs a threshold comparison, and the in-flight flag only guards a re-entrant
  dispatch. Both paths share the emission bookkeeping, and full scope only - a memory-scoped child never steers
  from the rotation. The steers a child can receive mid-run are the automatic memory audit's (`memory-audit`) and a
  measured-context one: both are event-driven rather than cadence-driven - a memory the child just broke is
  missing from its own next prompt, and its own context assumption is as stale as a parent's. The outline nudge
  (`outline`) is the third event-driven steer but parent-only, because a child is not granted `outline`; it is
  keyed on the step's own search calls, so it needs no branch scan, and its model consult is awaited when the
  model is enabled: a `none` suppresses the nudge and the point is recorded as a `trigger: "outline"` debug
  entry. A step that carries an audit
  finding, a context reminder, or the outline nudge skips `maybeEmitMidRun` - the rotation keeps its cadence for
  the next step - but everything held still travels in one combined message.

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
