---
name: context-usage
description: "The measured-context reminders: the trust rule, 50%/75% thresholds, post-fold estimate, model-change fallback, and their state lifecycle."
category: architecture
keep_updated: true
---

# Measured context reminders

Detail companion to the `reminders` index. `src/modules/reminders/context-usage.ts` owns all of it.

## Why

A model cannot see how much of its window is in use, so it guesses - and the guess is worst right after a fold,
when the number it remembers describes a transcript that no longer exists. The failure is not neutral: believing
it is near a limit makes it skip reads, shorten work, or wrap up on a task that has room. These reminders put the
measured count in front of it and say plainly not to budget from the imagined one.

## What counts as measured

`ctx.getContextUsage()` alone is not evidence. It answers with a number even when the counted reply it anchors on
predates a model or thinking-level change (only a fold makes it refuse), so the number can describe a different
tokenizer. `readMeasuredContext` requires a provider-counted reply after the newest `changesCountBasis` row - the
same predicate compaction uses - and returns nothing otherwise. A reading is shown as **Measured** or not at all;
there is no "probably" path for the threshold reminders or the one-shot.

## The three reminders

All three are change-point reminders in `catalog.ts`, outside `ROTATION_REMINDERS`, and never offered to the
selection model: a fact that can be shown is not something to ask the reader whose assumption is the thing that is
wrong. They also never pass through the scheduler.

- `context-half` (50%) and `context-tight` (75%) fire once each per context epoch when a measured reading crosses
  the threshold, at a `turn_end` step boundary beside the memory audit, so the steer lands before the next
  inference. `ContextThresholdTracker` marks every threshold crossed (a jump 40 -> 80 reports only 75) and asks
  nothing twice. A step that carries one skips `maybeEmitMidRun`, because a second send at the same boundary
  costs a second delivery - the same rule the audit finding follows.
- The 75% text is deliberately framed as *a fold is a reset, not the end of the task*: a near-limit frame makes
  models wrap up or hand off. What it asks for is cheap fold preparation (TODO/memories current), not a narrower
  task.
- The `COMPACTION_REMINDER` gains a post-fold paragraph (`foldContextNote`), in all three cases:
  1. a measured reading wins when one exists (a resume, or a fold old enough that a reply landed);
  2. otherwise a **same-model** estimate, labeled "about", from the current system prompt and tool definitions
     plus compaction's own `estimateEntryTokens` of the retained rows and summary. Reuse, not a new estimator:
     the estimate is only for the window before the first post-fold reply, and it must not grow its own
     approximation of the wire projection;
  3. when the model changed - a `provider`/`model` in the fold details that no longer matches, or a later model or
     thinking-level row - the number is refused, the reminder still says the pre-fold count does not apply, and
     `context-after-fold` is armed. That one waits for the first measured reading and is delivered at a step
     boundary.

The estimate is chars/4-based and model-specific, which is why the model-change rule exists. The TUI's calibrated
`charsPerToken` (`tui/status/stream-rate.ts`) is **not** reused: it is per-process output calibration, not keyed
by model, and wiring it in would couple two unrelated modules for a number that is superseded by the next reply.

## State and lifecycle

- `deliveredThresholds` rebuilds the fired set from delivered reminder entries *after the newest
  `changesCountBasis` row*, so a reload/resume/fork continues the epoch and a fold or model change starts a new
  one without a file. It reads `details.ids` as well as `details.id`, because a delivery point combines what it
  holds into one message.
- `ContextUsageReminders.idle()` skips the reading entirely once both thresholds are delivered and no fallback is
  pending, so a long session does not pay a branch walk per step for nothing.
- The `context-after-fold` flag is per-registration. A reload between the fold reminder and its first measured
  step drops it; that costs one number, never a wrong one, and it is the one deliberate lifecycle gap here.
- Both scopes get the feature: children fold too, and a child's own context assumption has the same cost.

## Tests

`test/modules/reminders/context-usage.test.ts` covers the trust gate (fold/model/thinking reset, no counted reply),
formatting, the tracker (order, jumps, branch rebuild, combined messages), `foldContextNote`'s three cases and the
one-shot. `.../emission.test.ts` pins the three deliveries end to end (measured fold, estimate, model-change
fallback, 50%/75% steers, and the `PI_CODER_REMINDER_CONTEXT=false` switch).