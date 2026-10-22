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
- Known outcomes: seven turns expect no reminder (32, 36, 163, 190, 298, 312, 394) and two expect
  `memory-hygiene` (246, 381); 283 and 363 stay ambiguous. Metrics: false fires, `memory-hygiene` on the
  fires, the `todo` top-pick count, and separation `min(mh@fire) - max(mh@none)`.

## lfm2-d1: the state is not the limit

| variant                     | false fires | mh 246 | mh 381 | todo top | separation |
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

- Baseline fires on all seven known-none turns with `todo` top on 10/11, and no variant fixes it: every
  state stays at 5-7 false fires and the `todo` floor on the Q&A turns never drops below ~.44.
- The four request-shaped turns (32, 36, 163, 190) fire even with no session state at all, so that
  over-firing is the model/request prior, not state content. The two model-discussion turns (298, 312) do
  stop firing once the cumulative totals are removed, so those fires are state-shaped.
- 394 is the softest of the seven (it follows memory edits); excluding it, lfm2 still fires on every pure
  Q&A turn in every variant.
- The one useful movement: recency + actions + delta (proposal/lean) put `memory-hygiene` on top for 381 at
  .46-.47 and keep 246 at .45-.46, but `todo` still outranks both and the false fires remain.

## clef-flash: the current state already works

| variant         | false fires | mh 246 | mh 381 | separation |
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

- Every variant keeps 0/7 false fires and changes no decision. The recency/actions enrichment shaves
  `memory-hygiene`'s confidence (246 .58 -> .48-.53) and narrows separation, while dropping the model-authored
  labels (v5) gives the widest separation in the set (+0.128 vs +0.083) and `last_failure` +0.100. With only
  two fire states, treat that ordering as a lead, not a result.
- The minimal state loses 381 and its separation, so clef does use the state - the current facts are simply
  sufficient for these turns.

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