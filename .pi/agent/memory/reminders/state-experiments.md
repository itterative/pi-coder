---
name: state-experiments
description: "Replays of state-shape changes and the single-choice question form through lfm2-d1 and clef-flash: enrichment does not fix lfm2, and the choice form collapses to none."
category: architecture
keep_updated: true
---

# Reminder state-shape experiments (Oct 22)

Index: [../reminders.md](../reminders.md). Question: does the state, rather than the model, limit reminder
selection? Method: rebuild every recorded turn state from the session branch, apply one change at a time,
and replay it through `lfm2-d1` and `clef-flash` with the production questions. No extension code was
changed; the harness is throwaway scratch and is not part of the repo.

## Method

- Baseline = the recorded `pi-coder-reminder:debug` state: `request` is the user message after the entry,
  `recent_messages` is `decisionSessionContext`'s window over the branch prefix, and the signals are copied
  from the entry.
- 13 states: the 12 recorded turn consults plus the first live `lfm2-d1` consult (the "do some experiments"
  turn, which chose `none`, max `todo` .388). Re-running the baseline reproduced recorded scores within
  0.01, and the live consult's scores matched its replay.
- Variants, one change each unless noted: recency tags on files/tests, `recent_actions` with targets,
  `since_last_turn` deltas, a `last_failure` channel, dropping `finishing`, dropping all three labels, the
  combined proposal, a lean state (proposal minus the cumulative totals), and a minimal state
  (`request` + `recent_messages` only).
- Labelling: a *fire* is the top reminder answer at or above the module threshold (0.45), and a **misfire** in
  the tables is a fire on an *expect-none* turn. The labels are inferred, not ground truth: expect-none (32,
  36, 163, 190, 298, 312, 394) comes from the recorded d3/clef abstains on questions, discussion, or
  model-comparison turns; 394 is the softest (it follows memory edits) and 163 asks for a command. Expect
  `memory-hygiene`: 246 (d3 and clef live both fired) and 381 (clef live fired, the user endorsed it).  283
  (d3 fired validation, clef and the user read it as a false positive) and 363 stay ambiguous. Metrics:
  misfires, `memory-hygiene` on the two expect-fire turns, the `todo` top-pick count, and separation
  `min(mh@fire) - max(mh@none)`.

## State shapes

All variants are deltas on the production `buildReminderState` shape, rebuilt from the same recorded turn.
The baseline for turn 246:

```json
{
  "request": "<current user message, clipped 600 chars>",
  "recent_messages": [{ "role": "assistant|user|command", "text": "<clipped 240>" }],
  "cwd": "/home/sd/Repos/pi-coder",
  "session": {
    "user_turns": 6,
    "context_tokens": 223721,
    "tools": { "read": 16, "bash": 53, "ask_user": 1, "write": 5, "edit": 11, "memory_audit": 3 },
    "recent_tools": ["edit", "bash", "memory_audit", "bash", "write", "bash"],
    "files_modified": ["src/modules/reminders/session-signals.ts", "…"],
    "tests_run": true,
    "last_test_failed": true,
    "memory_writes": 3,
    "todo_writes": 3,
    "phase": "exploring",
    "finishing": false,
    "unvalidated": false
  },
  "reminders_shown": [{ "id": "validation", "turns_ago": 1 }],
  "todo": { "completed": 2, "total": 5, "current": "<80 chars>" },
  "memories": ["agents", "compaction", "…"]
}
```

- `recent_messages` is the four items before the request; only assistant prose and bash commands become items.
  `request` and `recent_messages` are the only fields every variant keeps.
- The session counts are branch-wide since the last reset; `files_modified` is the last eight distinct write
  paths; `reminders_shown`, `todo`, and `memories` are present only when non-empty; `last_test_failed` is
  present only when the last test run failed.
- Variant deltas (all inside `session` unless noted); `turns_ago` counts consult turns, and a mid-run steer
  does not increment it:

| variant | shape delta (before -> after) | review slice |
| --- | --- | --- |
| v1 recency | `files_modified: ["src/a.ts"]` -> `[{"path": "src/a.ts", "turns_ago": 3}]`; `tests_run: true`, `last_test_failed` -> `tests: {"last_change_turns_ago": 1, "ran_turns_ago": 1, "failed": false}` | S1 |
| v2 recent_actions | `recent_tools: ["edit", "bash", "memory_audit"]` -> `recent_actions: [{"tool": "edit", "target": ".pi/agent/memory/reminders.md"}, {"tool": "bash", "target": "npx prettier --write …"}]` (last 6, target clipped 90) | S2 |
| v3 since_last_turn | adds `since_last_turn: {"tools": {"edit": 5, "bash": 10}, "wrote": ["…"], "tests": "passed"}` for the previous turn | S3 |
| v4 no finishing | drops `finishing` | S4 |
| v5 no labels | drops `phase`, `finishing`, `unvalidated` | S4 |
| v6 last_failure | adds `last_failure: {"tool": "edit", "turns_ago": 1}` | S5 |
| v7 proposal | v1+v2+v3, drops `finishing`, recomputes `unvalidated` from the write/test ordering | S1-S4 |
| v8 lean | v7 minus the `tools` totals and `files_modified` | control |
| v9 minimal | state is `{request, recent_messages}` only | control |

The questions and their wording are identical in every variant (four reminder bools plus
`phase`/`finishing`/`unvalidated`); only the state changes.

## lfm2-d1: the state is not the limit

| variant                     | misfires    | mh 246 | mh 381 | todo top | separation |
| --------------------------- | ----------- | ------ | ------ | -------- | ---------- |
| baseline                    | 7/7         | .47    | .43    | 10/11    | -0.157     |
| recency files/tests         | 7/7         | .45    | .41    | 10/11    | -0.168     |
| recent_actions              | 6/7         | .43    | .42    | 11/11    | -0.219     |
| since_last_turn             | 7/7         | .46    | .43    | 11/11    | -0.155     |
| no finishing                | 7/7         | .47    | .43    | 10/11    | -0.141     |
| no labels                   | 7/7         | .46    | .42    | 10/11    | -0.151     |
| last_failure                | 7/7         | .46    | .42    | 10/11    | -0.161     |
| proposal (v1+v2+v3+hygiene) | 6/7         | .46    | .46    | 10/11    | -0.185     |
| lean (proposal, no totals)  | 5/7         | .46    | .47    | 10/11    | -0.190     |
| minimal (request+window)    | 5/7         | .45    | .43    | 8/11     | -0.182     |

- Baseline fires on all seven expect-none turns with `todo` top on 10/11, and no variant fixes it: every
  state stays at 5-7 misfires and the `todo` floor on the Q&A turns never drops below ~.44.
- The four request-shaped turns (32, 36, 163, 190) fire even with no session state at all, so that
  over-firing is the model/request prior, not state content. The two model-discussion turns (298, 312) do
  stop firing once the cumulative totals are removed, so those fires are state-shaped.
- 394 is the softest of the seven (it follows memory edits); excluding it, lfm2 still fires on every pure
  Q&A turn in every variant.
- The one useful movement: recency + actions + delta (proposal/lean) put `memory-hygiene` on top for 381 at
  .46-.47 and keep 246 at .45-.46, but `todo` still outranks both and the misfires remain.

## clef-flash: the current state already works

| variant         | misfires    | mh 246 | mh 381 | separation |
| --------------- | ----------- | ------ | ------ | ---------- |
| baseline        | 0/7         | .58    | .49    | +0.083     |
| recency         | 0/7         | .55    | .49    | +0.070     |
| recent_actions  | 0/7         | .50    | .44    | +0.046     |
| since_last_turn | 0/7         | .54    | .47    | +0.063     |
| no finishing    | 0/7         | .60    | .50    | +0.088     |
| no labels       | 0/7         | .57    | .53    | +0.128     |
| last_failure    | 0/7         | .60    | .52    | +0.100     |
| proposal        | 0/7         | .48    | .47    | +0.088     |
| lean            | 0/7         | .53    | .47    | +0.078     |
| minimal         | 0/7         | .50    | .42    | -0.022     |

- Every variant keeps 0/7 misfires and changes no decision. The recency/actions enrichment shaves
  `memory-hygiene`'s confidence (246 .58 -> .48-.53) and narrows separation, while dropping the model-authored
  labels (v5) gives the widest separation in the set (+0.128 vs +0.083) and `last_failure` +0.100. With only
  two fire states, treat that ordering as a lead, not a result.
- The minimal state loses 381 and its separation, so clef does use the state - the current facts are simply
  sufficient for these turns.

## TODO-state experiment (Oct 22)

Same 15 recorded states, no extension changes: five fabricated `todo` blocks on top of each state - none,
progress-only, items with per-item phases, stale items (`updated_turns_ago: 5`, in-progress item's phase
mismatched) and a list whose items are nearly all completed. Focus: will the model pick the `todo` reminder
from TODO state, and does a per-item phase reach the label answers?

- **No model raises the todo question for a populated or stale list.** clef's todo score stays .15-.31 in
  every variant (below the .45 threshold); a stale list lowers it, and progress-only is the highest of the
  four. lfm2's `todo` floor does not move either.
- **Both models read completion status, not staleness.** A nearly all-completed list raised `finishing` from
  .08-.42 to .26-.62 (clef) and .06-.64 to .49-.80 (lfm2), usually flipping `phase` to `wrapping_up`.
  `updated_turns_ago: 5` alone changed almost nothing.
- **Per-item phases are read, modestly**: clef's `phase` answer on turn 163 moved verifying -> implementing to
  match the in-progress item's label, but no decision changed.
- **A threshold cannot make the todo reminder trigger-happy on clef**: at .30 the progress-only variant would
  fire on 246, 298, 312, 381 (two discussion turns) and even no-TODO baseline fires on two. A deterministic
  gate (work underway + TODO not updated in N turns) is the only way to make it eager.
- **Risk**: TODO completion is treated as ground truth and `finishing`/`wrapping_up` feed the memory-hygiene
  availability gate, so a stale or optimistic list can cause the wrong reminder. Keep `updated_turns_ago` in
  the state and do not gate on the model's completion reading.

Live: a real three-item `TODO.md` was written during the session; the snapshot landed at 08:00:19, and the next
live consult is the first to carry `todo` at all. Design direction from these results: carry items + per-item
phases + `updated_turns_ago` in the state, make the eager trigger deterministic, and only then consider
persisting the phases (the reminder-state entry, not the TODO frontmatter).

## TODO-item query form (Oct 22)

The same 15 recorded states, clef live, three question shapes, to decide how a TODO-aware query should be asked:

- **Single choice, criteria = item titles only**: answers discriminate (4 `none`, 5 reminder-state, 6
  model-comparison) and do not collapse to `none` like the reminder single-choice did. The list's status
  labels are ignored: the same question with `status_cur` vs `status_stale` criteria agreed on 14/15 states,
  so the model names the item the work is actually on rather than parroting `in_progress`. A comparison-based
  trigger is viable.
- **But active-only candidates go quiet**: with only the pending/in_progress items offered, the choice answers
  `none` on 12/15 states, so a choice-based trigger would rarely fire on real work.
- **Per-item bools work**: one bool per candidate item plus an `outside the list` bool. `outside` dominates on
  every discussion turn (no false fires), and an item scores high only when the turn is about it. Candidate set
  = pending/blocked items (work on the in_progress item was already said); the rule is top item >= .45 and
  above `outside`.

Implementation note: the endpoint rejects a raw `bool` question type (only `choice`, `score`, `noul`), so the
probe had to send `noul` directly; the SDK's typesafe-system-one api translates `ClassifierBoolQuestion` to
`noul`, so production can keep using `bool`.

The shipped rule and its wiring are in `reminders/selection.md`; the per-item bools above are what
`src/modules/reminders/todo-query.ts` builds.

## Single choice collapses for both models

Asking one `choice` question over the four reminders plus `none`, with `none` first or last, returned `none`
on all 13 states for both `lfm2-d1` and `clef-flash`, including the two known fires. The four independent
bools with a threshold on the winner remain the only form that separates anything; this matches the earlier
`vllm-d3-flash` measurement.

## Reading

- State enrichment is not the lever for lfm2-d1: the over-firing survives even a request-plus-window state.
  Its problem is the yes-bias of the model on this form, not the poverty of the state.
- For clef (and by the earlier data d3), the current state already carries what the recorded turns need;
  recency/actions are worth adding only if they fix a named failure, and these replays do not show one. The
  label-free state is the one clef lead worth a larger corpus before any code change.
- The one state-side fact worth keeping from the corpus: cumulative totals are what make the model-discussion
  turns fire, so trimming or aging them has a measurable effect even if it does not fix the request-shaped
  turns.