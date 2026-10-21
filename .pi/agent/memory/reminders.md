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

- `catalog.ts` — `MEMORY_READ_REMINDER` (session start, tree navigation, compaction) plus `ROTATION_REMINDERS`
  (memory-hygiene, sandbox, delegation, todo, validation), each with `text` and `guidance`. A `disabled: true`
  entry stays in the catalog but is filtered out of the rotation and the model's offer by
  `ACTIVE_ROTATION_REMINDERS`; `sandbox` is disabled until it keys on a real gated event rather than rotating
  context-free. Catalog texts stay extension-generic: they may name pi-coder mechanics but never one
  repository's commands, which live in that project's instructions and memories.
- `scheduler.ts` — pure `ReminderScheduler`: the session reminder first; otherwise rotation due after
  `everyTurns` user turns since the last emission or `thresholdTokens` new context tokens, whichever comes
  first. A model answer naming an offered id is chosen and advances the rotation past it; a deliberate `none`
  suppresses the fallback for that turn; a missing answer leaves the deterministic triggers in charge. The
  optional `available` gate narrows the rotation: the scheduler scans to the next allowed id, and a model pick
  outside the set is dropped with no fallback. Mid-run emissions are capped at `maxMidRunPerTurn` (default 1)
  per user turn, reset by each `decide`.
- `context-growth.ts` — the `message_start` usage baseline plus streamed `chars / 4` estimator lifted out of
  the memory module.
- `settings.ts` — `PI_CODER_REMINDER=false` disables everything; `PI_CODER_REMINDER_EVERY_TURNS` (default 5)
  and `PI_CODER_REMINDER_THRESHOLD` (default 30000, alias `PI_MEMORY_REMINDER_THRESHOLD`) each disable their
  trigger at `0`, and both at `0` also removes the model consult; `PI_CODER_REMINDER_MIDRUN_MAX` (default 1)
  caps the mid-run steers one user turn may receive; `PI_CODER_REMINDER_DEBUG=true` records a
  `pi-coder-reminder:debug` entry per emission.
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

Compaction may summarize an old reminder away, so session start, tree navigation, and compaction each call
`reset()` and re-arm it.

## Decision-model selection

With `decisionModel.reminders: true`, `consultReminderSelection` asks one probability question per offered
reminder before each non-session turn; the strongest answer at or above `reminderMinProbability` (default
0.45) is shown, and nothing at or above it means none. The signals state, the piggybacked labels, and the
measured calibration: [reminders/selection.md](reminders/selection.md).

## Replay

`npm run reminder-report -- <session.jsonl> [--turn N] [--turns N] [--compact] [--json]` replays a recorded
session turn by turn: it rebuilds the exact state that would be sent, simulates the deterministic schedule
(so the turn cadence and the threshold interaction are visible), and prints each turn's picked reminder in
full, compact mode clipping it to one `shows=` line. It applies the same activity gate and only models a
mid-run steer for an assistant message that called a tool, matching the live rules.
The header says the model was not consulted, because a live choice with `reminders: true` may differ. It reads the session's own memory-index,
todo-snapshot, and reminder-state entries, needs no endpoint, and respects `PI_CODER_REMINDER_*`. The script
is `scripts/reminder-report.mts`; the `.mts` and `src/package.json` (`type: module`) exist because the root
package is not ESM and the pi package is ESM-only under `node --import tsx`. `parseArgs`, `replay`, and the
renderers are exported; `tsconfig.check.json` enables `allowImportingTsExtensions` so the test can import the
script with the extension it must carry.

## Tests

`test/modules/reminders/{scheduler,emission,model-policy,session-signals,catalog}.test.ts` cover the pure
schedule, the hidden-message emission, the decision-model wiring, the signal builder and gate, and the catalog
filter;
`test/modules/decision/reminder.test.ts` covers the subject, consult, and prompt clipping; the config key is
pinned in `test/modules/decision/config.test.ts`, and `test/scripts/reminder-report.test.ts` pins the replay
tool. `decision-model.md` covers the classifier plumbing this builds on.

## Targeted references

- `reminders/selection.md` — the selection subject, the signals state, the labels, and the calibration numbers.