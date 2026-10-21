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
`<pi_coder_reminder>`). The memory module owns the appendix and snapshot lifecycle.

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
  outside the set is dropped with no fallback.
- `context-growth.ts` — the `message_start` usage baseline plus streamed `chars / 4` estimator lifted out of
  the memory module.
- `settings.ts` — `PI_CODER_REMINDER=false` disables everything; `PI_CODER_REMINDER_EVERY_TURNS` (default 5)
  and `PI_CODER_REMINDER_THRESHOLD` (default 30000, alias `PI_MEMORY_REMINDER_THRESHOLD`) each disable their
  trigger at `0`, and both at `0` also removes the model consult; `PI_CODER_REMINDER_DEBUG=true` records a
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
  gate is computed once per message, and only the threshold applies here. Both paths share the emission
  bookkeeping, and full scope only - a memory-scoped child never steers mid-run.

Compaction may summarize an old reminder away, so session start, tree navigation, and compaction each call
`reset()` and re-arm it.

## Decision-model selection

With `decisionModel.enabled: true` and `decisionModel.reminders: true`, the model decides both cadence and
choice. `consultReminderSelection` (decision module) is asked before each non-session turn: one `choice`
question over the rotation ids and `none`. The evaluator in `decision/reminder.ts` has its own cache and
cooldown, so a failed reminder request cannot pause a permission verdict; unreadable, error, and timeout
answers fall back to the deterministic schedule. `reminders` defaults to false, and
`timeoutMs`/`cooldownMs` are shared with the rest of the decision module. The settings dialog does not expose
the key yet; it is edited in the config file.

### What the model sees

The live `event.prompt` as `request` (clipped to 600 chars by `clipRequest`, because a template or skill
expansion is otherwise sent whole) plus the branch's four-item recent window, and `signals` built by
`session-signals.ts`:

- `cwd`, `session`: `user_turns`, `context_tokens`, per-tool call counts, the last 6 tool names,
  `files_modified` (memory files and TODO.md excluded, 8 max), `tests_run` (matched at a shell segment's
  command word, so `echo 'npm test'` does not count), `memory_writes`, `todo_writes`, and the model-built
  labels `phase` / `finishing` / `unvalidated`;
- `reminders_shown`: rotation ids with `turns_ago`, maintained by the module and cleared on
  session/tree/compaction;
- `todo`: progress from the `pi-coder:todo-snapshot` entry; `memories`: names from the
  `pi-memory:memory-index` entry.

`availableRotationIds` gates `memory-hygiene` on `files_modified` / `todo_writes` or a wrapping-up label.

The candidate list stays in the question criteria, never in the state. Every signal is best-effort: a missing
entry or unreadable snapshot just drops its field.

### State built along the way

The classifier API has no free-text channel (`choice | score | bool`), so model-built state is labels, not
prose. The reminder request piggybacks three questions beside the choice: `phase` (choice over
`exploring | planning | implementing | debugging | verifying | wrapping_up`), `finishing` (bool), and
`unvalidated` (bool). The endpoint answers every question in one round trip, as the file-access subject does
with kind/purpose/loss, so this costs no extra request. `reminderStateFrom` reads them, the reminders module
merges them over the persisted labels, and appends a `pi-coder:reminder-state` entry only when a label
changes; `restart()` re-reads the latest entry at session start, tree navigation, and compaction, and the
labels ride in the state on later turns. They cannot inform the same turn's choice because all answers arrive
together. With the model off or a label unreadable, `session-signals.ts` infers `phase` and `unvalidated`
from activity (writes without a test run are implementation, reads are exploration); `finishing` is never
inferred.

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

`test/modules/reminders/{scheduler,emission,model-policy,session-signals}.test.ts` cover the pure schedule,
the hidden-message emission, the decision-model wiring, and the signal builder;
`test/modules/decision/reminder.test.ts` covers the subject, consult, and prompt clipping; the config key is
pinned in `test/modules/decision/config.test.ts`, and `test/scripts/reminder-report.test.ts` pins the replay
tool. `decision-model.md` covers the classifier plumbing this builds on.