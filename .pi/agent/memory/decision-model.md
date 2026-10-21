---
name: decision-model
description: "Optional classifier for commands, file accesses, and reminder selection (src/modules/decision). Load when touching that module or its config."
category: architecture
priority: 7
keep_updated: true
status: "Shipped: the veto strategy is wired into the Bash gates, the file gates, and the advisory suggestion; opt-in via enabled, and apply decides whether a verdict resolves a prompt"
---

# Decision model

Optional classifier consulted when the rule/heuristic pipeline leaves a command `ask` (`src/modules/decision/`),
for one advisory question when the permission prompt is choosing the width of a session-rule suggestion, and for
the reminder question `src/modules/reminders` asks before an agent turn. It has three judged subjects — Bash
commands, file accesses no root resolved, and reminder selection (the last grants no authority) — plus that one
advisory question. The code
is `src/modules/decision/` with the shared bridge at `src/tools/decision-model.ts`; the config is the global
`~/.pi/decision-model-config.json` (holds the token) overridden by the project
`.pi/decision-model-config.json`, then `SYSTEMONE_*` environment last.

Measured evidence and rejected alternatives: [decision-model/history.md](decision-model/history.md) (not indexed).
Read this memory first; go there only for the numbers behind a decision.

## What is shipped

- **`veto`** (`DEFAULT_DECISION_STRATEGY`): **one** `choice` request with the neutral veto instruction and seven
  criteria, and the criterion picks the action through `ACTION_TABLE`. Policy lives in the table, not the model,
  so a row changes when the sandbox changes — not when a case is annoying. `decision-model/strategy.md`.
- **The deterministic scope gate** folds a capability × runner-rung check in as another form: a capability above
  the runner's rung refuses at confidence 0, with no request sent. `decision-model/scope-suggestion.md`.
- **The reminder subject** (`reminders: true`, default false): one probability question per offered reminder
  (its guidance is the criterion), asked before a non-session agent turn; the strongest answer at or above
  `reminderMinProbability` (default 0.45) decides the reminder, and nothing at or above it means none. A single
  `choice` over the catalog plus `none` was measured to abstain on almost every real state, which is why the
  form changed. It has its own evaluator, cache, and cooldown, so a failed reminder request cannot pause a
  permission verdict. `decision-model/wiring-config.md`.
- **The block-sentence contract**: a verdict that takes part in a block is named in the runner's vocabulary —
  never a criterion id, action name, or config key — and a person's answer is never reattributed to the model.
  `decision-model/runner-output.md` holds those sentences and snapshot tests pin them.
- **Opt-in**: nothing consults the model until an endpoint is configured and `enabled` is set; `surfaces` and
  `fileSurfaces` choose which gates ask. `decision-model/wiring-config.md`.

## Targeted references

Load only the detail needed for the task; these nested documents are on-demand and are not listed in the memory index.

- `decision-model/strategy.md` — System One transport, and the veto instruction, criteria order, and action table.
- `decision-model/state-policy.md` — what the request state carries and deliberately omits; apply and confidence.
- `decision-model/child-consult.md` — the read-only `safe-bash` second opinion and when its verdict may proceed.
- `decision-model/script-subject.md` — script body resolution, the capability verdict, caches, failure policy.
- `decision-model/scope-suggestion.md` — the capability × rung gate, and the advisory data-vs-program question.
- `decision-model/file-access.md` — the `kind` / `purpose` / `loss` subject and its four invariants.
- `decision-model/wiring-config.md` — which file holds what, config layering and keys, `alt+a`, settings, footer.
- `decision-model/runner-output.md` — the exact runner-facing block sentences and what deliberately keeps raw ids.
- `decision-model/findings.md` — settled measurements not to re-litigate, and the open worklist.
- `decision-model/history.md` — the 76 KB measurement archive behind those findings: raw logs, per-arm numbers,
  and rejected alternatives. On-demand only, and intentionally not indexed; read it when a settled claim needs
  its evidence, never to decide how the code works.
