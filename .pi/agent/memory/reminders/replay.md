---
name: replay
description: "The reminder-report replay tool: flags, fold modeling, the recorded-decision view, and why the script must stay .mts."
category: architecture
keep_updated: true
---

# Reminder replay

Detail companion to the `reminders` memory.

`npm run reminder-report -- <session.jsonl> [--turn N] [--turns N] [--compact] [--recorded] [--json]`
replays a session turn by turn, rebuilding the exact state that would be sent, simulating the schedule
(turn cadence and threshold interaction visible), and printing each turn's reminder in full (compact clips
it to one `shows=` line). It applies the activity gate and models a mid-run steer only for a tool-calling
assistant message, printing it with its emitting turn. A turn is a run-starting prompt; a steered message
stays under its run's turn and never reaches the decision.

A `compaction` entry is modeled as the live `session_compact` restart: the scheduler, the shown map, and
the context estimate reset there, the compaction reminder is armed, and the module turn counter restarts;
the report keeps global numbering and marks folds in the header and at the first post-fold turn. The opening
reset mirrors a session start and arms `memory-read`, and a fold replaces that arm with `compaction`. The
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
