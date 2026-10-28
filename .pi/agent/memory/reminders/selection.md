---
name: selection
description: "Reminder decision-model subject: per-reminder score questions, the 1.25 gate, the conversation state, the signals, and the labels."
category: architecture
keep_updated: true
---

# Reminder selection and model state

With `decisionModel.enabled: true` and `decisionModel.reminders: true`, the model decides both cadence and
choice. `consultReminderSelection` (decision module) is asked before each non-session turn: one question per
offered reminder, whose guidance is the criterion. The default form is a helpfulness **score**
(`reminderForm: "score"`): four levels `no help | mild | useful | important`, returned as a continuous level
in `[0, 3]`, gated by `reminderMinScore` (default **1.25**: the gate is a point on that ladder, and 1.0 is the
"mild" rung the model's own answers sit at the median of, so a bar at 1.0 fires about half the time). The
strongest answer at or above the gate is shown; nothing at or above it is a deliberate `none`; an unreadable
response leaves the deterministic schedule in
charge. `reminderForm: "bool"` restores the older probability question gated by `reminderMinProbability`
(default 0.45). Both forms replaced a single `choice` over the ids plus `none`, which measured as `none` on
almost every real state. The evaluator in
`decision/reminder.ts` has its own cache and cooldown, so a failed reminder request cannot pause a permission
verdict. `reminders` defaults to false, and `timeoutMs`/`cooldownMs` are shared with the rest of the decision
module. The settings dialog does not expose either key yet; they are edited in the config file.

## What the model sees

The tier-2 state is **one field**: `conversation`, the branch rendered by the window allocator
(`decision/window.ts`) under `WINDOW_POLICY_REMINDER` - `WINDOW_POLICY_PLAN`'s numbers at a 2000-char budget -
oldest first, ending with the turn's request as its own `User:` line. Nothing else is sent: no `request` field,
no `recent_messages`, no signals. This is shape S11 of the state comparison, which beat the structured state
(kappa 0.28 against a hindsight oracle at the shipped 1.25 gate, over 70 mid-run points of three sessions) and
which measured the structured signal fields at **-0.14 kappa** for every allocator window beside them; the
numbers and the rejected alternatives are in `decision-model/window.md`.

- `consultReminderSelection` allocates over `decisionSessionContext`'s `items` - every item of the branch walk,
  with its turn stamps - rather than over the planner's window, because the allocator is the thing that decides
  what each item is worth. `reminderConversationAtoms` appends the live `event.prompt` as a newest user item when
  the branch does not carry it yet (`before_agent_start` runs before pi persists the message, and the deferred
  judgement can read the branch either side of that write), which is the same rule `windowTranscript` applies
  for the state ask; a clipped (`clipRequest`, 600) request whose text already ends the branch is not doubled.
  The allocator keeps the newest user item, the newest assistant item and the newest two tool items whatever the
  budget, caps each item at `ITEM_CHARS` (240), and lets a recorded state marker compete for its own length.
- What the model read is recoverable: `ReminderConsult.window` carries the kept items back **as they were sent**
  (each clipped to the chars its allocation bought, via `allocationText`) beside the drop count, built from the
  same single branch read and never rebuilt later. That is what the debug entry records and what the replay
  prints, and the rendered `conversation` is those items behind their `User:` / `Assistant:` / `Tool:` prefixes.
- `planSessionWindow` still builds the command and file-access `recent_messages` window, and
  `renderSessionWindow` still draws any window as a transcript for a test, a replay, or a log - the reminder
  subject just no longer sends the planner's items. Flattening the request into the window is what measured
  *worse* than no context for the command subject (`decision-model/state-policy.md`); for the reminder subject
  the flattened conversation measured better than the structured fields, which is why the two now differ.

## The signals

`signals` built by `session-signals.ts` are still what the pool is scoped by and what the debug entry records;
they are no longer part of the state the model reads, and `reminderCacheKey` does not include them - the key is
the state that is sent (the conversation, the option ids and guidance, and the form), because keying on a field
the request no longer carries would let two different conversations share one answer.

- `cwd`, `session`: `user_turns`, `context_tokens`, per-tool call counts, the last 6 tool names,
  `files_modified` (edit/write paths with memory files, TODO.md and `.md` documents excluded, 8 max), `tests_run`,
  `last_test_failed` (the most recent runner result errored), `memory_writes`, `todo_writes`, `doc_writes`, and
  the model-built labels `phase` / `finishing` / `unvalidated`; `tests_run` is matched at a shell segment's
  command word, so `echo 'npm test'` does not count;
- `reminders_shown`: rotation ids with `turns_ago`, maintained by the module and cleared on
  session/tree/compaction;
- `todo`: progress from the `pi-coder:todo-snapshot` entry; `memories`: names from the
  `pi-memory:memory-index` entry.

`availableRotationIds` drives the offer from the state. `memory-hygiene` needs produced or recorded work
(`files_modified`, `memory_writes`, `todo_writes`, `doc_writes`) or a wrapping-up label; `validation` needs
produced work too (a code change, a document, a memory, the TODO list, or a test run), so a turn that only read
and searched is offered neither; `todo` on a readable list with `completed < total` (the score form ranks `todo`
high even with no list, so the gate is what suppresses those turns). The `validation` gate has a **known blind
spot**: the scan sees the `edit`/`write` tools only, so a change made through bash - a heredoc, a redirect,
`sed -i` - leaves it false and the reminder unoffered, which the model then never gets to score (the reuse idea
for it is the last note under "The pool is the judged state"). Every gate here
is a quieting filter over the model's score, not a guarantee about relevance.

The candidate list stays in the question criteria, never in the state. Every signal is best-effort: a missing
entry or unreadable snapshot just drops its field.

## State built along the way

The classifier API has no free-text channel (`choice | score | bool`), so model-built state is labels, not
prose. One state question - `next_state`, a choice over the `--states doc` set below - is asked in its own call
(`reminderStateRequest`), against the state `{current_state, conversation}` the probe's variant sent.
`reminderStateFrom` reads it, the reminders module records it in a `pi-coder:reminder-state` entry when one
changes, and `restart()` re-reads the latest entry at session start, tree navigation, and compaction. The
`finishing`/`unvalidated` questions are gone: nothing gates on them (the pool gate is the phase and the TODO),
and `unvalidated` is inferred from activity instead. A **recorded** `unknown`/`unvalidated` is never read back
(`reminderLabelsFromEntries` and `resolveSessionLabels` take only `phase`): with no question left, a value an
older session stored would be frozen forever and outrank the inference on every later turn.

**The state set is the probe's `--states doc`**: `discussing | exploring | implementing | validating |
documenting | reporting`. Migrating to it folded `planning` into `discussing` (deciding, asking) and
`documenting` (writing the plan), `debugging` into `validating` (its criteria already cover diagnosing a
failure), and split `wrapping_up` into `documenting` (memory/TODO/doc writes) and `reporting` (summarizing with
no write). `isReminderPhase` rejects the old names, so a `pi-coder:reminder-state` entry recorded under them
loses that field on read and the inference takes over - which is how the migration healed the frozen session
below without touching its JSONL.

**The accepted phase is the anchor; the activity scan fills only what it does not answer.** The phase itself is
the model's, moved under the accept gate in `decision/reminder.ts` (`acceptedReminderPhase`: the first answer
is taken, a repeat holds, a different phase needs confidence >= 0.5), and the activity scan is the bootstrap for
a session that has not answered yet and the whole state while the model is off. The gate exists because the
alternatives both failed in practice: accepting every answer left the phase frozen (the state carries the
previous phase back in, so the model confirms it), and letting the activity outrank the model turned the
tracked state into a derived label the probe deliberately does not use. `finishing` is no longer asked or
inferred (nothing reads it). `session-signals.ts` infers `phase` and `unvalidated` from
activity, and now answers every turn: the last code write is ordered
against the last test run (a failed last run is `validating`), writes after it stay `implementing` and read as
unvalidated, a turn whose only writes were memories, the TODO list or `.md` documents is `documenting` (the
recording phase, which is also what stopped a plan edit from arming the validation reminder), reads alone are
`exploring`, and a turn that changed and read nothing is `discussing`. `finishing` is never inferred. Each
recorded state entry also annotates the window (`reminderStateMarker`) with the probe's own line
(`  ── state: X ──`, indentation included, which the transcript keeps and the planned window's clip trims), so
the phase timeline travels in the conversation rather than only in the state's phase field.

## The pool is the judged state

`availableRotationIds` offers a rotation reminder only in the states its catalog entry names (`states` on
`RotationReminderDefinition`). The table, as shipped:

| reminder | states |
|---|---|
| `memory-hygiene` (never for a read-only turn) | implementing, validating, documenting, reporting |
| `delegation` (work already underway) | exploring, implementing |
| `todo` (the list matters from the start) | discussing, exploring, implementing |
| `validation` (a change about to be called finished) | implementing, validating, documenting, reporting |

The list's own gate stays: `todo` also needs a readable list with an open item, whatever the state. The table
replaced the ad-hoc `hasProducedWork` checks (`validation` and `memory-hygiene` were gated on it, `delegation`
was always offered), which is why `delegation` now disappears on a `discussing` or `validating` turn. `phase` is
always known, so there is no empty-pool bootstrap: a fresh session reads `discussing`, where only `todo` (and
only with a list) is offered. Known blind spot, now consequential: the scan sees `edit`/`write` tool calls, so
a change produced through bash leaves the state looking read-only and the hand-back reminders unoffered.

**Open idea for that blind spot (not implemented): reuse the decision model's bash classification** rather than
re-deriving writes from the command text. The capability verdict already exists - `decision/script-classification.ts`
answers `writes_files` / `writes_outside` for the code a command runs (`decision/script.ts` chases package scripts,
file bodies, and inline `-c`/heredocs), and the command form's own verdict sits beside it - so a bash write is a
verdict the model has already reached, not something the scan needs to infer. The catch is where to read it: the
verdict is only *recorded* by the permission gate that consulted (`sandbox/decision-log.ts`, `.state/bash-log.jsonl`,
memory `sandbox/decision-log.md`), so a log-only fix still misses an auto-allowed or sandbox-resolved command that
never consulted, and the log is extension-local while the scan reads the session branch. A complete fix needs the
signal where the gate runs, carried to the scan the way the other best-effort signals are (an entry like
`pi-coder:todo-snapshot`, or the branch's own bash tool call), with the parsed `parseBashAst` command as the cheap
fallback for the shapes that never reach the model. `session-signals.ts` is where the produced-work fields are built.

## The cascade, and the pool it decides

The state decides the pool, so the state cannot be judged in the same request the pool is: `judgeTurn`
(`reminders/index.ts`) runs the cascade, queued off the user-turn boundary rather than inside it.

- **Tier 1** (`consultReminderState` -> `evaluateState`) asks `next_state` alone against the **short
  transcript** (`SHORT_WINDOW_CHARS`, 800: the probed knee), fitted by `decision/transcript.ts` from the branch's
  items (`windowTranscript`) rather than from the pool's planned window, with the accepted phase sent as
  `current_state` (`none` before one exists). It is what the pool is built from, so it goes first, and its
  phase answer goes through the accept gate. Its raw `phaseConfidence` comes back beside the state, and the
  fitted conversation comes back as `transcript` (recorded in the debug entry as `stateTranscript`). Its budget
  is a parameter (`windowChars`), which is how the escalation re-asks it at 1800.
- **Tier 2** (`consultReminderSelection`) asks the pool's questions on its own allocator-rendered conversation
  (`WINDOW_POLICY_REMINDER`, 2000 chars; see "What the model sees" above). The state
  question is **not** among them: when tier 1's phase came back unsure (`phaseConfidence` missing or < 0.5) the
  caller asks the state again as its own call on `TRANSCRIPT_WINDOW_CHARS` (1800), so the state is re-judged
  where the short transcript may have hidden what decided it; that escalated answer wins, otherwise tier 1's
  stands. Keeping each ask to the state it was measured with - the phase to its transcript, the pool to its
  conversation - is why this is a second call rather than appended questions, and it is what
  `judgeStateCheckpoint` already did.
- The debug entry records `stateConfidence`, `statePhase` and `stateLatencyMs` beside `labels`, `escalated`, and
  `consult`: tier 1's raw answer (the phase *before* the accept rule, its confidence, and its latency) next to
  the accepted labels, so a held phase can be told from a confirmed one and a quiet disagreement from a
  confirmation. `answeredPhase` on `ReminderStateConsult` is what carries the raw answer out of the evaluator,
  since `state.phase` is already the gate's output. The tiers are cached separately and share the cooldown, and
  a disabled subject checks its config before entering the shared in-flight count, so it never blinks the badge.
- Probed cost shape: tier 1 is ~0.27s at 800 chars against ~0.47s for the full window, and escalation ran
  11.8% (`08-00`) / 26.7% (`11-16`) once the planned window carried tool lines. **Live, over 185 recorded
  consults** (this repo's session, 20:48-22:25): 77% escalated, confidence median 0.34 and max 0.76, tier 1
  ~525ms (the scheduled window came back ~480ms on the same runs, so the short window buys *no wall-clock* -
  what it saves is the second request when it does resolve confidently). The phase itself is not frozen: the
  timeline moved five times (`validating` -> `documenting` -> `reporting` -> `discussing` -> `validating`),
  including moves at `esc=False`. Earlier entries in this memory claimed 14/14 escalation and a phase that
  cannot move; that was one validation-heavy stretch, and it over-read the data.
- What is left of the escalation *rate* mismatch (77% live at the time against the probe's 12-27%) was request
  shape, and the A/B settled it: the production shape was 1037 prompt tokens / ~0.48s and read `exploring` at
  0.17 confidence, the measured variant 576 tokens / ~0.31s and read `validating` at 0.82. **The live state ask
  now sends the measured variant** (see `stage-gating.md`, *What the state ask sends*); the 0.5 threshold is
  unchanged and still the parameter to revisit first if the rate stays high.

## Deferred judgements

The cascade is a model call, and pi builds the user's message only *after* a `before_agent_start` handler
returns, so awaiting the consult there withholds the user's own message until the model has answered. The
boundary therefore does the bookkeeping and hands the judgement to a background queue:

- `ReminderScheduler.beginTurn()` (`scheduler.ts`) advances `userTurns` and resets the mid-run budget the
  moment the turn starts; `decide(input, { turnBegun: true })` then picks the reminder once the answer
exists. The armed path (below) calls plain `decide`, which runs `beginTurn` itself - the split exists only so a
  deferred turn does not count as two turns.
- Judgements (turn, checkpoint, next turn) run one at a time in request order through `SerialQueue`
  (`common/async.ts`): a checkpoint never lands before the turn judgement that preceded it, and every reader
  that needs the settled state waits on it. `maybeEmitMidRun` awaits it before reading the pool, `judgeTurn`
  and `judgeStateCheckpoint` read `labels` inside their own task, and `registerRemindersExtension` returns
  `{ idle }` for anyone (or any test) that needs to wait for the queue.
- Delivery follows `runActive` (`agent_start` .. `agent_settled`): a reminder whose run is still in flight is
  `steer`ed into that run's next step, and one whose run already settled goes out as `nextTurn` - a `steer`
  sent while nothing streams is appended to the transcript without ever reaching the model.
- The measured motivation: a live tier-1 ask costs ~525ms and the escalated full-window ask ~480ms on this
  endpoint, so a rotation turn's judgement is ~1s of work that used to sit between the user hitting enter and
  seeing their own message. Deferring removed exactly that, which is what the feedback says it feels like.
- A consequence worth knowing when reading entries: the first turn after a reload is the **armed** memory turn
  and consults nothing, so the first `deferred: true` turn entry appears on the *second* user message. State
  checkpoints carry tier 1's half immediately, because they do not care which kind of turn opened the run.
- The **armed reminders are untouched and stay synchronous**: `memory-read` and the fold reminder carry no
  consult, so they are still decided at the boundary and still ride the user message they belong to. "The
  reminder arrives after the user's message" is therefore only ever true of a rotation turn.
- Writes are stamped with an epoch that `restart()` (session start, tree move, fold) bumps: a consult that
  outlived its session drops its answer instead of recording it into the branch that replaced it.
- One reminder per turn still holds across both paths: the deferred `decide` is skipped when a mid-run
  emission already took the turn's slot (`lastEmitTurn >= turn`). A mid-run point the model *declines* does not
  take that slot - nothing was shown - so the turn's own reminder can still arrive.
- `turn_end` no longer awaits the checkpoint: it queues it and returns, which removes the per-step consult tax
  (~0.27s, +~0.47s escalated) from every tool-using response.

## Threshold accounting

The rotation's context trigger is `thresholdTokens` *new* context tokens since the last emission, and the
scheduler's `thresholdBaseline` is the context that emission counted from. The baseline is a **branch fact**:
each delivered reminder stamps the baseline it leaves in force in its `details` (`contextTokens`, the
scheduler's post-emission `thresholdBaseline`), and `reminderResumeState` returns the last one as
`baselineContext` - or, when the stamp is absent (an older session) or `0` (a fold, whose emission renders
before any post-fold usage exists), derives it from the **prompt side of the first assistant response after
that reminder** (`input + cacheRead + cacheWrite`). `restart` seeds it through `seed`, while `reset` (a fresh
session or a fold) leaves it unset.

The prompt side, not `totalTokens`: pi's providers normalize `input` as the uncached prompt and
`cacheRead`/`cacheWrite` as the cached prompt (`openai-completions.ts`: `input = prompt_tokens - cached -
cache_write`), so `input + cacheRead + cacheWrite` is the context that response was given, while `totalTokens`
is that plus the response's own output - growth that happened *after* the reminder. The report's
`contextTokensOf` uses the same convention, so live and the replay share one baseline.

Live, `emit` updates the baseline when the decision already knows the context (a mid-run steer) and leaves it
alone when it is unknown; `noteContext` at `message_start` establishes it only when there is none. A reload is
therefore explicitly **not** a change point: its armed memory reminder renders before the run's first usage
but keeps the branch seed instead of clearing it, so the reload reuses the entries rather than restarting the
cooldown. The boundaries that do reset are a `compaction` (the fold shrank the context) and a fresh session
(`reset`).

Two consequences. **An unknown context defers, it never fires:** `thresholdDue` is
`current - baseline >= thresholdTokens`, so an unknown (`0`) current context is negative, or the baseline is
unset, and nothing emits until a usage lands. A `/tree` branch summary over a span of messages makes the
post-summary size unknowable the same way, and it defers to the first post-summary usage rather than comparing
against a pre-summary baseline - no "context shrank" rule is needed. **A change point owns its turn:** the
armed reminder (memory at session start, compaction at a fold) covers the turn after a fold; the threshold
only counts from after it. `reminderResumeState` resets on `compaction` only, not `branch_summary`, because a
summary injects the target branch's history rather than discarding it. A mid-session `model_change` is **not**
a boundary today; if model switches turn out to matter (a different tokenizer or context accounting), treat one
like a fold - slice at it in `reminderResumeState` and let the baseline reset.

## The checkpoint cadence

The state is not only read at the turn boundary; it is read on **every assistant response that used a tool**.
That is pi's `turn_end` (one response plus the tool calls it made, not a user turn - see
[concepts/turns.md](../concepts/turns.md) for the vocabulary), which is the probe's
checkpoint: its step is a tool call, and `--tier` forces one per step. `maybeEmitMidRun`
never consults the model, so without this the state - and the badge, and the pool a mid-run steer uses - was
frozen at the turn-start judgement for the whole of a long run. `judgeStateCheckpoint` (`reminders/index.ts`)
asks tier 1 on the short transcript, and when that answer was unsure asks the same state question again on the
window transcript (`windowChars: TRANSCRIPT_WINDOW_CHARS`); the escalated answer wins, and neither ask carries
the pool's questions, because a checkpoint has no reminder to decide. Its gates: `scope: "full"`, reminders on,
rotation on, the model opted into reminders, and `event.toolResults.length > 0`. It does **not** look at
`sessionArmed`, so a session-reminder turn (a reload, or the turn after a fold) now judges the state too, which
it never did when this hung off `rotationTurn`.

What it deliberately does not touch: `decide()` is the user-turn boundary event (it counts `userTurns`, resets
the mid-run budget, and advances the rotation pointer), so a checkpoint calls none of it - `everyTurns`,
`turns_ago`, and `midRunThisTurn` keep meaning user turns. The judgement is queued rather than awaited, so a
tool-using response no longer pays the consult before its next request; the mid-run gate reads the same `labels`
the checkpoint wrote, because it waits for the queue first. The emitted reminder still leaves from
`before_agent_start` (armed only, as a returned message) or from the queue (`deliverAs: "steer"` or
`"nextTurn"`). What the checkpoint buys, in one line: the state moves while the work happens, not when the user
speaks. Its debug entry uses `trigger: "checkpoint"` and carries no `pick`, since it decides nothing.

## TODO query and the transition trigger

The TODO signal is used through a dedicated query rather than richer state. `signals.todo` keeps its summary
shape (`completed` / `total` / `current`); the item list travels in the question criteria only, so no per-item
phase is stored and TODO.md keeps its schema. The reminders module builds the query from the parsed snapshot
(`todoItemsFrom` -> `todoQueryFor`, `src/modules/reminders/todo-query.ts`): one bool per `pending` / `blocked`
item (capped at 4, titles only - statuses never reach the model) asking whether the current work is on that
item, plus one `outside` bool. Work on the `in_progress` item was already said, so only a move to an unlisted
item can fire.

`todoChoiceFrom` weighs the answers: the top item at >= 0.30 that beats `outside` counts as a move the list
has not recorded, and it overrides a deliberate `none` or an unreadable reminder answer; an explicit pick of
another reminder wins that turn and the move stays visible on the next one. `ReminderContext.extraQuestions` /
`ReminderConsult.extras` carry a caller's questions and their raw answers through the same round trip, cached
with the rest of the request. The debug entry records `todoMove` (what the query read, won or not) and
`todoScores`.

Measured (Oct 22, clef, 15 recorded states; tables in `reminders/state-experiments.md`): a single choice with
the production-shaped active candidates answered `none` on 12/15, while the per-item bools stayed quiet on
discussion turns (`outside` dominated) and scored the work item where the work existed. The same question with
`status_cur` vs `status_stale` criteria agreed on 14/15, so the model reads the work rather than parroting the
`in_progress` label.

Live reads (Oct 22, after reloads, three turns that were all about their pending item): `alright, is it there
yet?` read the item 0.06 against outside 0.27, `go ahead` 0.32 against 0.24 (the item won, but sat below the
then-0.45 floor), and `alright, let's see` 0.08 against 0.60. The middle pair set the floor to 0.30 - an
item-match probability, not the reminder threshold's "worth showing" one. The pattern is the finding: the item
bools track visible work, not conversational topic, so a passive meta-request about the item still reads as
outside. That is the intended target (a work move, not a topic move). The positive fire then worked in exactly
that shape: with `live-reads` still pending after a turn that documented the reads, the next consult scored it
0.58 against outside 0.26, `todoMove` appeared, and `todo` was forced even though its own reminder score was
only 0.23 (every candidate sat below the 0.45 threshold). The reminder was delivered before the user message
was persisted, and the item was marked complete in that same turn. The ask costs ~250 input tokens for one
item bool plus `outside`.

Not adopted: per-item phases in TODO.md (schema churn), persisted per-item phase labels, a deterministic
stale-TODO gate, and enriching the state with item lists or `updated_turns_ago`.

Live fires (Oct 22): the compaction reminder fired once, after a reload's fold - the next turn's debug entry
read `trigger=session`, `reminder=compaction`, `modelChoice=None` (the armed turn never consults), and a fresh
`sessionArmed: true` / `rotationIndex: 0`; the delivered message carried `{id: compaction, turn: 1}` and the
real session JSONL path appended at emission. The same day's follow-up: an aborted partial message moves the
tree, and a tree move used to re-arm `memory-read` through the same `seed()` as session start. Seeding now
arms nothing on its own - each restart point passes its own reminder - so a navigation only continues the
rotation and cadence, while session start still arms `memory-read` because it rebuilds the appendix. The
rebuilt `<memory_system>` list reaches the next prompt either way, so nothing is lost by not nudging. A
later session (Oct 25) showed the reverse failure: a fold, then a reload before any post-fold turn, armed
`memory-read` and dropped `compaction`, because `reminderResumeState` slices after the fold and returns
`undefined` for an empty post-fold slice, which `restart` read as a fresh start. `restart` now recomputes the
arm from the branch: when the resume finds nothing and the branch holds a compaction, it arms
`COMPACTION_REMINDER` whatever the caller passed, and only a resume with a non-empty post-fold slice (a turn
has seen the fold reminder) lets `session_start` arm `memory-read` again.

## Recorded decisions

Every selection decision is written to the session as a `pi-coder-reminder:debug` entry, so the state a
choice was made from survives without re-deriving it. The entry holds `trigger` (`session` / `turn` /
`mid-run`), the emitted id or `null` - a turn that chose nothing is recorded too, because that is the case the
state explains, and a mid-run point the model declined is recorded the same way, with its `modelChoice`, scores
and the `scheduler` snapshot showing the cooldown the decline left behind - the full `state`, the gate's
`available` set, the `options` actually offered, `modelChoice`,
`scores`, a `consult` summary (status, latency, usage), the labels in force, `contextTokens`, and the
pre-decision `scheduler` snapshot. Debug recording is on by default for now (`reminderDebugEnabled` in
`settings.ts`, temporarily ignoring `PI_CODER_REMINDER_DEBUG` like `isAgentTraceEnabled`); it uses session
entries rather than a `.state/` JSONL because the reminder state is per-session and the replay already reads
the session file. Separate from the debug entry, every delivered reminder message carries `details: { id,
 turn }`; that always-present marker is what `reminderResumeState` reads to resume the rotation pointer, the
shown history, and the turn count after a tree move or reload, so resume never depends on debug being on.

## The state the footer shows

`pi-coder:decision-state` carries the judged labels (`{ labels }`) to the footer's badge, which renders the phase
as `» auto · implementing`. The module publishes it from `reminderSessionLabels` - the same
`resolveSessionLabels` the request state goes through, so the accepted phase the gate holds is what the badge
shows and the activity scan is what an unanchored session shows - at a restart (session start, tree move,
compaction), at every `before_agent_start`
(whether or not that turn asked the model, so a rotation-skipped turn still updates the badge), and at each
mid-run check, where the branch is scanned anyway. The consult itself is counted in flight like the two
permission gates (`withDecisionCheck`), so the badge animates as `⠋ auto · implementing` for its ~0.5 s instead
of sitting static — the reminder consult was the one that reached the endpoint without touching the count.
Publishing is parent-only (`scope: "memory"` stays silent, since a child shares the parent's bus) and off with
`PI_CODER_REMINDER=false`, because the readout belongs to this module.

Recovery after a reload, a tree move, or a fold is **not** a stored copy of the shown state: `restart()` takes
the model's labels from the branch's latest `pi-coder:reminder-state` entry (`findLast` over the branch, so a
tree move reads where it landed, with each field validated separately) and recomputes the activity-derived
fields from that same branch - and since those decide the phase, recovery reproduces what the branch says
rather than what the session last happened to answer. Only model-assigned fields are persisted, and only when
one changes, so the badge is a pure display: nothing is lost when the process or the footer component is
rebuilt. `scanActivity` reads the whole branch rather than only the post-fold span, so a fold resets the
rotation but does not blank the phase.

## Measured notes

`vllm-d3-flash`, real session replays: the single-choice form abstained on 30/30 runs; per-reminder
probabilities put read-only states at 0.14-0.21, clear `validation` states at 0.57-0.65, and borderline states
at 0.43-0.44, which is where the 0.45 default sits. Feeding the agent's reasoning text as an extra window item
or state field moved no choice and only one phase label, so it was not adopted.

Question form (Oct 22, clef-flash, intra-turn checkpoints of the `session-review` build): the bool form kept
`todo` at 0.12-0.29 across the whole turn, including a state with `0/5` completed, 4 files changed, and 26
tool steps since the last list write. A per-reminder **score** question ("How helpful would showing this
reminder be right now: <guidance>", four levels) ranked `todo` first at 0.94-1.21 whenever work was underway
and yielded to `validation` (0.97 vs 1.41) when the list was current; a short-criteria choice surfaced `todo`
too but collapsed the ranking, and the state-shape variants moved nothing. The score form is also eager
(`memory-hygiene` reached 1.0-1.8, and `todo` scored >= 1.0 with no list at all), which is why `todo` is gated
on an open list and why the per-reminder score threshold is not the old probability gate.

The `clef-flash` vs `vllm-d3-flash` speed, real-state decisions, and order-sensitivity results are in
`reminders/model-comparison.md`.
