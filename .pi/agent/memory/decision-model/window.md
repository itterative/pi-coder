---
name: window
description: "The policy-driven window allocator in window.ts - turn-level knapsack, knob list, named policies, and invariants; WINDOW_POLICY_REMINDER renders the tier-2 reminder state."
category: architecture
keep_updated: true
---

# Window allocator

`src/modules/decision/window.ts` is a policy-driven **budget allocator** for the context window: given the
branch items, it decides how many chars each one gets, instead of the priority heuristics
(`planSessionWindow`, `renderFitted`) that guarantee a set and then fill newest-first under per-item floors.

**Status: wired for tier 2, not for tier 1.** `consultReminderSelection` renders its whole state through
`WINDOW_POLICY_REMINDER` (the plan policy at a 2000-char budget), which is the measured winner S11; the phase ask
still uses `fittedTranscript` and the command/file-access subjects still use `planSessionWindow`. The remaining
policies exist for the comparisons in `reminders/selection-corpus.md`, and so the phase ask can be switched on later.

## Why it exists

The heuristics cannot express "fit as much relevant context as we can". The allocator can, and it makes the
choice inspectable: each item has a value curve over its chars, and the budget is spent to maximize the total.

## The optimization

A **turn-level multiple-choice knapsack**, in five stages:

1. **Prepare** — each item becomes an atom with a kind (`user`/`assistant`/`tool`/`marker`), a char `floor`
   and `cap` clamped to its text, and a weight.
2. **Weight** — `kindWeight × recencyDecay^(turns behind newest) × saturation^(rank of same kind in its turn)`.
   The saturation term is the diminishing return that stops one turn's fifth near-duplicate tool line from
   out-bidding another turn's message.
3. **Per-turn knapsack** — 0/1 over the turn's atoms, allocations quantized to `bucket` chars, value
   `weight × curveRatio`. Produces `V_t(c)`.
4. **Combine** — multiple-choice knapsack across turns over the budget, choosing `c_t` per turn.
5. **Backtrack** — per-item chars, then render in original order with the policy's omission style.

## API

- `selectWindow(items, policy) → WindowSelection` (`lines`, `kept`, `omitted`, `value`, `chars`, `turns`).
- `WindowPolicy` is pure data; a policy is the whole configuration.
- `allocationText(allocation)` is the text one kept item was sent as - its `line` without the role prefix - so a
  caller recording the window it judged records what was read rather than the unclipped branch atom.
- Named policies: `WINDOW_POLICY_PLAN` (tier-2 numbers, markers **compete**), `WINDOW_POLICY_REMINDER`
  (the plan policy at 2000 chars - the tier-2 reminder-selection state, wired), `WINDOW_POLICY_CONVERSATION`
  (message-heavy, markers **drop** — the alternative that measured below the plan policy), `WINDOW_POLICY_TRANSCRIPT`
  (tier-1 caps, `keepTurns` 3, markers **forced**). `DEFAULT_WINDOW_POLICY` is `WINDOW_POLICY_PLAN`.

## Knobs

`budget`, `bucket`, `curve` (`log` | `twoSegment`), `weights` per kind, `markerWeight`, `floors`/`caps`
per message/tool, `keepTurns`, `perTurn` count caps (messages/tools), `saturation`, `recencyDecay`,
`markers` (`drop` | `compete` | `forced`), `mustKeep` counts, `omissions` (`leading` | `inline`).

## Invariants and gotchas

- **Budget** is on **text chars**; role prefixes (`User: `) and omission lines are extra, so `lines` can be
  longer than `chars`. `selectWindow` spends `chars ≤ budget` whenever the required floors fit.
- **Must-keeps** (newest user/assistant/tools) are always present, at least at their floor, even when a turn
  gets no budget: the DP gives a required atom no skip option, so a zero-weight required atom still needs that
  branch or it silently disappears.
- **Markers**: `compete` needs a low `markerWeight` (~0.2) or their short length wins every density contest;
  `forced` markers are charged at full length and bounded by `keepTurns`, with the oldest trimmed first when
  even that does not fit. Without a turn span, a long session drowns the budget in markers.
- Deterministic for the same items and policy; `value` is comparable only on the same curve and budget.

## Measured so far (3 sessions, 44 consulted turns, `clef-flash`)

Run by wiring the policies into the reminder probe as extra shapes (S5 conversation, S6 transcript, S7 plan)
alongside S0-S4.

- **Cost:** the allocator does not save tokens. It fills the budget exactly, where `planSessionWindow` stops as
  soon as the next floor no longer fits, so S5/S7 carry *more* text than S2 (state ~2.4k vs ~2.1k chars,
  ~963 vs ~912 input tokens, ~425 vs ~410 ms). The budget is on text chars, so `User: ` prefixes are extra.
- **Pick:** on the 30 turns whose pool is `{memory-hygiene, validation}`, S0/S1/S4 fired `validation`
  16-17 / `memory-hygiene` 3-5, while S5 fired `memory-hygiene` 13 / `validation` 11. A message-heavy,
  marker-free window makes memory-hygiene win; the mix of tool lines vs assistant prose moves it, not the size.
  S6 tracks S0 best of the new shapes (80% fired agreement; 21 vs 22 fires).
- **No accuracy signal yet.** All of the above is pick movement, not correctness; the labeled corpus is still
  the missing piece, so do not switch a production renderer on these numbers alone.

## Wired for tier 2

`WINDOW_POLICY_REMINDER` is what production sends: `consultReminderSelection` allocates `decisionSessionContext`'s
raw atoms through it and sends the one field `conversation`, so this policy's numbers are no longer only a
measurement - they are the tier-2 reminder state. It is `{ ...WINDOW_POLICY_PLAN, budget: 2000 }` held as a named
constant so production and the probe's S11 reference one policy and cannot drift. The phase ask still uses
`fittedTranscript`, and the command and file-access subjects still use `planSessionWindow`.

How that policy was chosen - the S0-S11 shapes, the hindsight oracle and which half of it is trustworthy, the
replication, and the pool constraint that outranks all of it - is `reminders/selection-corpus.md`.


## How to try a policy

`scripts/window-report.mts` is the committed reading tool (`npm run window-report`): it replays every prompt's
branch prefix through the allocator and prints the rendered window, chars/kept/dropped, and the per-turn spread.
The default policy is `WINDOW_POLICY_REMINDER` (what production sends); `--policy` picks another named shape,
`--budget` and `--keep` override its two allocation knobs, `--turns a,b` selects prompts, and `--compact` scans
a whole session one line per turn. `--mid-run` adds the recorded mid-run (mid-turn) consults - the
`pi-coder-reminder:debug` records with a `mid-run` trigger, allocated from the prefix ending at the record - with
repeated records of one state collapsed and counted, which is the point to read when tuning the tier-2 window's
knobs. With no file it reads the session `pi --continue` would resume for the current cwd
(`SessionManager.continueRecent`), so a bare `npm run window-report` reads the newest transcript of the repo.
Turns carry `decisionSessionContext`'s stamp, so a steer shares the turn it joined and prints as `(steer)`.

The private probes go deeper. `.pi/local/reminder-state/window_policies.mts` prints each policy's rendered window
plus per-turn chars/value for one turn of a real session. `read_window.mts` is the reading aid: it renders a
session's turns through the allocator at a budget, and prints the branch signals per turn (a 19-turn read is 253
lines instead of 4874), which the committed report leaves out.

```
npm run window-report -- [--turns 3,7] [--policy plan] [--budget 2400] [--compact] [--mid-run]
npm run window-report -- <session.jsonl> [...]
npm run scratch -- .pi/local/reminder-state/window_policies.mts <session.jsonl> [turnIndex]
npm run scratch -- .pi/local/reminder-state/read_window.mts <session.jsonl> --turns 55,63,88
```

S5/S6/S7 are wired into `turn_shapes.mts` as the allocator shapes, and S11 reads the production policy
(`WINDOW_POLICY_REMINDER`) rather than a copy of it, with `--points mid-run` to replay the
schedule the module actually runs on, `--consults` for the turns the live module consulted, `--labels` +
`--min-score` to score against a scored oracle corpus and to gate it on the oracle's own confidence, and
`--recalc-phase` to re-judge the phase instead of reading the persisted label.

What the measurements said before S11 was wired, kept because it is still true of the rest: on the confident
subset a constant label scores higher than any mechanism, on the untrusted side of the oracle the pointer beats
every shape, and on the trusted side no shape beats a constant. S11 went in because it is the best of the shapes
available and it costs one field of state, not because the ranking clears the ceiling above. The lever this
file's subject does not touch is the pool: the gate
withholds the oracle's chosen reminder on a third of the live points, and the rotation offers `delegation`, which
the oracle never wants.
