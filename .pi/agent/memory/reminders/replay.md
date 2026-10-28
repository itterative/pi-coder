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
it to one `shows=` line). The tier-2 state is rebuilt through the production path - `reminderConversationAtoms`
over `decisionSessionContext`'s items, then `selectWindow(..., WINDOW_POLICY_REMINDER)` - because a recorded
prefix ends *before* the turn's user message, so the request is appended exactly as the live consult appends it;
`ReplayTurn.state` is the resulting `{ conversation }` and `ReplayTurn.signals` are the signals the pool gate
read, which `--compact`'s `phase=` and `tools=` fields come from. It applies the activity gate and models a
mid-run steer only for a tool-calling
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

Both windows print as transcripts: the replay's own (`ReplayTurn.window`, also in
`--json`, with a `dropped=` count in `--compact`), and under `--recorded` the window the live consult judged
(`debug.window`, recorded since the consult carries it back). That pairing is the point - a window change is
read line by line against what a live decision actually sent, instead of being unrecoverable. The tier-2 state
*is* that window, so the text output prints one `state: {conversation} - the N chars of window above` line and
then the `signals:` JSON instead of repeating the same text twice; an empty window prints
`state: {} - no window, so nothing to send`. An entry whose
consult ran but kept no window says so (`predates the window record`). When the window holds a recorded state
entry it is annotated in place (`── phase: X ──`), the same marker the model is sent (`reminderStateMarker`), so
a replay reads the phase timeline exactly where the consult saw it.

Decision lines print tier 1's own half - `state-conf=` (the raw phase confidence), `state-phase=` (the phase it
named, before the accept rule) and `state-latency=` - plus `escalated`, so a held phase can be told from a
confident one and a *quiet disagreement* from a confirmation without reading the JSON. The accepted labels the
same line carries are the other half of that pair: `state-phase=implementing` beside
`labels={"phase":"documenting"}` is a tier 1 that proposed one thing and lost the argument. A checkpoint
decision is printed as its own `recorded checkpoint:` line under the turn it was judged in: the walker buckets
`trigger: "checkpoint"` like `"mid-run"` (never as `pendingDecision`), because a checkpoint is appended
*during* a run and would otherwise be misattributed as the next prompt's turn decision. A **deferred** rotation
turn is the same shape for the same reason - it is judged off the boundary, so its entry lands after the prompt
it belongs to; the walker attaches it to the run in hand and reads its turn off its own `scheduler.userTurns`
(no `+1`, which is what the pre-boundary shape needed), and the line prints `deferred`. Every recorded
decision also prints the threshold arithmetic - `ctx=` (the context the decision carried), `base=` (the
snapshot's `thresholdBaseline`) and `since=` (their difference) - so a mid-run can be told apart from real
growth instead of one fired against a baseline that was never established - and a `recorded delivered:` line
prints the delivered reminder's own `ctx=` stamp when it has one, which is the prompt-side baseline a resume
reads; `--compact` prints the recorded mid-run picks as `recorded-midrun=` beside the replay's simulated
`midrun=`.

It reads the session's own memory-index, todo-snapshot, and reminder-state entries and respects
`PI_CODER_REMINDER_*`. Those entries keep the live choices for comparison. The script
is `scripts/reminder-report.mts`; the `.mts` and `src/package.json` (`type: module`) exist because the root
package is not ESM and the pi package is ESM-only under `node --import tsx`. `parseArgs`, `replay`, and the
renderers are exported; `tsconfig.check.json` enables `allowImportingTsExtensions` so the test can import the
script with the extension it must carry.
