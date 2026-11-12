---
name: outline-nudge
description: "The event-driven outline nudge: search classifier, quiet window, turn cooldown, branch seed, and the selection-model gate."
category: architecture
keep_updated: true
---

# The outline nudge

`src/modules/reminders/outline-nudge.ts` is the fourth event-driven steer (beside the memory audit, the measured
context trio, and their turn-boundary arms) and the only one aimed at a tool-choice habit: repeated
`rg`/`grep` searches for code without `outline`. Its text is `OUTLINE_NUDGE_REMINDER` in `catalog.ts`, deliberately
outside `ROTATION_REMINDERS`: a cadence cannot time it to the behavior, and the step boundary can.

## Trigger and timing

The trigger is observed per step, from the step's own assistant message (`turn_end`, no branch scan):

- pi's `grep` tool, or a bash segment whose command word is `grep`, `egrep`, `fgrep`, `zgrep`, `rg`, `ag`, or `ack`,
  plus `git grep`. Lead assignments are stripped first, so `FOO=1 rg x` counts. `find`/`ls` and `rg --files` are
  not searches here: `outline` does not replace a filename listing.
- A search on the **right of a pipe** is not a search: `npx vitest … | rg "×"` filters another command's output.
  A search on the left (`rg x src | head`) still counts. A search inside a **heredoc body** is script text, not a
  call, and is skipped; the rest of the command is still scanned. Both exclusions came from replaying real
  sessions, where the pipeline form was the most common false positive.
- The nudge fires at the `turn_end` of the step that searched and crossed the threshold, so the steer lands before
  the model's next tool choice. A step that does not itself search never nudges, even when the counters are high.

## Quieting rules

- At least 2 searches since the last `outline` call (`OUTLINE_MIN_SEARCHES`). One search can be a legitimate log,
  config, or string search; two read as exploration.
- No `outline` call within the last 20 tool calls (`OUTLINE_QUIET_CALLS`). A model that just used the tool does not
  need to be reminded of it. A session that never called `outline` has no quiet window to respect.
- At least 8 user turns between nudges (`OUTLINE_COOLDOWN_TURNS`). The turn cooldown also caps a single run at one
  nudge, because a run has one user turn.
- Any `outline` call resets the search count to zero. The counters live in `OutlineNudgeTracker` in memory and are
  seeded from the post-fold branch at every restart (`outlineUsageFromEntries`), so a reload does not re-nudge
  immediately.
- The branch seed reads the last delivered nudge's own `custom_message` turn, including the `ids` of a message
  combined with another reminder, as the cooldown anchor. Because the seed also counts what the branch already
  did, a session that searched twice before the nudge existed - or before a reload of the extension - crosses the
  threshold on its first new search; the 8-turn cooldown then holds. Confirmed live on the first session after
  the change landed.

## The gate

The deterministic trigger decides when a consult is worth paying for; the selection model decides whether the
nudge is emitted. The gate runs whenever the decision model is enabled (`decisionModel.enabled`); it does not
require `reminders`, and there is no outline-specific key. The consult enables the reminder subject internally
for that one question, so the rotation stays deterministic unless `reminders` is separately on.

- At a trigger the module builds `{recent_conversation, command, output}` and **awaits** the consult, because the
  steer must land before the next inference. The trigger's rarity and the evaluator's cooldown keep that cost
  bounded; a failed consult cools the evaluator and fails open.
- A `none` decision suppresses the nudge (its turn slot is still spent, so the rotation does not also fire at that
  step). A `reminder` decision emits it. A disabled, failed, timed-out, or unreadable answer has no decision and
  **fails open**, matching the rotation's fallback: an absent answer must not silently stop reminders.
- The state is:
  - `recent_conversation` is `WINDOW_POLICY_CONVERSATION` over the branch, not the reminder policy. Replay showed
    its message-heavy 1,200-char shape kept the current step better than the 2,000-char reminder window.
  - `command` is the triggering search command, clipped to 240 chars (`commandText`).
  - `output` is the matching tool result summarized as `[N lines, M chars]` plus 4 non-empty head lines at 110
    chars (`summarizeToolOutput`), capped at 400 chars. Output is what lets the score see that `rg -A 12` pulled a
    declaration body by hand, which was the missing signal in the first replay.
- The gate threshold is the existing `reminderMinScore` (1.25 on the score form) or `reminderMinProbability` in
  the bool form. The answer is recorded on a `pi-coder-reminder:debug` entry with `trigger: "outline"`, `scores`,
  `consult`, `window`, `modelChoice`, and `outline: {command, output}`; a suppressed point records `modelChoice:
  "none"` and `reminder: null`.
- `consultReminderSelection` gained `stateExtras` and `windowPolicy` for this; `stateExtras` is merged into the
  state and is part of the reminder cache key, so two different commands cannot share an answer.

**What the replay said.** Two real sessions produced 17 trigger points; the score fired 5-6 at 1.25, suppressed
the pipeline/heredoc false positives, and fired the `ContainerMount` case at 1.55. The score is not stable at the
boundary (the same state returned 1.23, 1.25, and 1.28 across runs), and a 1.24 near-miss was a clean declaration
search. That is why the gate fails open on an absent answer and why the threshold is the reminder subject's
existing one rather than a new one; if it proves too strict, `reminderMinScore` is the lever. The broadened
`catalog.ts` guidance covers `digest`, `search`, `show`, `usages`, and reads/docs, not only declarations.

The trigger still counts searches only. Read-heavy exploration (`read` of a large source file) is the `digest`
case and scored well in replay (5/5 chose `outline_digest`), but extending the trigger to reads is deferred.

`PI_CODER_REMINDER_OUTLINE=false` disables the nudge without touching the rest of the module. It is full scope
only: a delegated child is not granted `outline`.

## Tests

`test/modules/reminders/outline-nudge.test.ts` covers the classifier (including pipes and heredocs), the reset, the
quiet window, the turn cooldown, the branch seed, the command text, and the bounded output summary.
`.../outline-gate.test.ts` drives a trigger with a mocked decision module: a high score emits, a `none`
suppresses, an unavailable answer fails open, and a pipeline filter neither nudges nor consults. `test/modules/decision/reminder.test.ts` covers `stateExtras` in the request and its place in the cache
key. `.../emission.test.ts` still covers the end-to-end steer, the quiet window, and the memory-scoped child.