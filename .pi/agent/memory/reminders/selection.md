---
name: selection
description: "Reminder decision-model subject: per-reminder probability questions, the threshold, the signals state, and the labels."
category: architecture
keep_updated: true
---

# Reminder selection and model state

With `decisionModel.enabled: true` and `decisionModel.reminders: true`, the model decides both cadence and
choice. `consultReminderSelection` (decision module) is asked before each non-session turn: one probability
question per offered reminder (its guidance is the criterion). The strongest answer at or above
`reminderMinProbability` (default 0.45) is shown; nothing at or above it is a deliberate `none`, and an
unreadable response leaves the deterministic schedule in charge. The per-reminder form replaced a single
`choice` over the ids plus `none`, which measured as `none` on almost every real state. The evaluator in
`decision/reminder.ts` has its own cache and cooldown, so a failed reminder request cannot pause a permission
verdict. `reminders` defaults to false, and `timeoutMs`/`cooldownMs` are shared with the rest of the decision
module. The settings dialog does not expose either key yet; they are edited in the config file.

## What the model sees

The live `event.prompt` as `request` (clipped to 600 chars by `clipRequest`, because a template or skill
expansion is otherwise sent whole) plus the branch's four-item recent window, and `signals` built by
`session-signals.ts`:

- `cwd`, `session`: `user_turns`, `context_tokens`, per-tool call counts, the last 6 tool names,
  `files_modified` (memory files and TODO.md excluded, 8 max), `tests_run`, `last_test_failed` (the most recent
  runner result errored), `memory_writes`, `todo_writes`, and the model-built labels `phase` / `finishing` /
  `unvalidated`; `tests_run` is matched at a shell segment's command word, so `echo 'npm test'` does not count;
- `reminders_shown`: rotation ids with `turns_ago`, maintained by the module and cleared on
  session/tree/compaction;
- `todo`: progress from the `pi-coder:todo-snapshot` entry; `memories`: names from the
  `pi-memory:memory-index` entry.

`availableRotationIds` gates `memory-hygiene` on `files_modified` / `todo_writes` or a wrapping-up label.

The candidate list stays in the question criteria, never in the state. Every signal is best-effort: a missing
entry or unreadable snapshot just drops its field.

## State built along the way

The classifier API has no free-text channel (`choice | score | bool`), so model-built state is labels, not
prose. The reminder request piggybacks three questions beside the per-reminder questions: `phase` (choice over
`exploring | planning | implementing | debugging | verifying | wrapping_up`), `finishing` (bool), and
`unvalidated` (bool). The endpoint answers every question in one round trip, as the file-access subject does
with kind/purpose/loss, so this costs no extra request. `reminderStateFrom` reads them, the reminders module
merges them over the persisted labels, and appends a `pi-coder:reminder-state` entry only when a label
changes; `restart()` re-reads the latest entry at session start, tree navigation, and compaction, and the
labels ride in the state on later turns. They cannot inform the same turn's choice because all answers arrive
together. With the model off or a label unreadable, `session-signals.ts` infers `phase` and `unvalidated` from
activity: the last code write is ordered against the last test run, a failed last run reads as `debugging`,
and writes after it read as unvalidated. `finishing` is never inferred.

## Recorded decisions

Every selection decision is written to the session as a `pi-coder-reminder:debug` entry, so the state a
choice was made from survives without re-deriving it. The entry holds `trigger` (`session` / `turn` /
`mid-run`), the emitted id or `null` - a turn that chose nothing is recorded too, because that is the case the
state explains - the full `state`, the gate's `available` set, the `options` actually offered, `modelChoice`,
`scores`, a `consult` summary (status, latency, usage), the labels in force, `contextTokens`, and the
pre-decision `scheduler` snapshot. Debug recording is on by default for now (`reminderDebugEnabled` in
`settings.ts`, temporarily ignoring `PI_CODER_REMINDER_DEBUG` like `isAgentTraceEnabled`); it uses session
entries rather than a `.state/` JSONL because the reminder state is per-session and the replay already reads
the session file. Separate from the debug entry, every delivered reminder message carries `details: { id,
 turn }`; that always-present marker is what `reminderResumeState` reads to resume the rotation pointer, the
shown history, and the turn count after a tree move or reload, so resume never depends on debug being on.

## Measured notes

`vllm-d3-flash`, real session replays: the single-choice form abstained on 30/30 runs; per-reminder
probabilities put read-only states at 0.14-0.21, clear `validation` states at 0.57-0.65, and borderline states
at 0.43-0.44, which is where the 0.45 default sits. Feeding the agent's reasoning text as an extra window item
or state field moved no choice and only one phase label, so it was not adopted.