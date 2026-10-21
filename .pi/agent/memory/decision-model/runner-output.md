---
name: runner-output
description: "Runner-facing sentences when a decision-model verdict takes part in a block, the attribution guards, and what keeps raw ids. Snapshot-bearing."
category: architecture
keep_updated: true
---

# Runner-facing block sentences

Index: [../decision-model.md](../decision-model.md). This wording is load-bearing for snapshot tests — change a sentence here only with the snapshots.
The ids and config keys these sentences deliberately never name live in
[state-policy.md](state-policy.md) and [wiring-config.md](wiring-config.md).

## What a blocked runner is told

A verdict that participates in a block says so in the block reason, in the runner's vocabulary — never a
criterion id, never an action name, never a config key. The bridge (`src/tools/decision-model.ts`) owns the
sentences: `VERDICT_PLAIN` maps criteria and capabilities to phrases built from the same wording the
classifier is asked with, `VERDICT_CONSEQUENCE` maps the policy's reason strings to why the verdict went
unacted, and `isDryRunVerdict` (a verdict that cleared the command while `apply` is off) keeps a
record-only config from being reported as the model's own refusal.

- `attributedBashBlockReason({ subject, record, humanAsked })` serves both Bash gates. It returns
  `undefined` — the gate's own wording is true — when no model spoke or a person answered, because a human's
  "no" must not be reattributed to the model. A `record.applied` deny reads
  `Agent bash blocked by the decision model, which judged it able to destroy data irreversibly (0.90).`; an
  unapplied one with no interface adds `There was no user to ask.`
- `readOnlyGateSentence(record, "withheld" | "held")` is the read-only child's tail, ending
  `This agent has no prompt to ask through.` The deterministic allowlist reasons stay first — they are why the
  command needed judging — and `createSafeBashConsult` now returns `SafeBashConsultResult` so the guard can
  append the sentence only when a verdict actually spoke.
- `permissionAllowsCall(permission)` replaced `permission !== "ask"` in the child command gate. The old form
  read a `deny` the verdict brought as "allowed" and would have run a denied command **unsandboxed**; it was
  unreachable only because policy abstains every `refuse` today, and it is the first thing a fully automatic
  mode would have hit. The gate still cannot produce that deny — `APPLIED_PERMISSIONS.refuse` is never
  consulted — so the branch is pinned by mocking `consultForGate`, not by a config.
- The `ui.notify` line (`decision model resolved <label>: sandbox (privileged) - allow:sandbox`) deliberately
  keeps the raw ids, because it is the operator reading their own configuration, not a runner deciding what to
  try next. Do not "make it consistent" with the runner-facing sentences.
