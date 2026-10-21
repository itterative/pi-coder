---
name: scope-suggestion
description: "Deterministic capability × runner-rung scope gate, and the advisory suggestion subject that decides data-vs-program for session-rule wildcard width."
category: architecture
keep_updated: true
---

# Scope gate and suggestion subject

Index: [../decision-model.md](../decision-model.md). The first is a code-only gate composed as another fold form; the second is the one consult that does
not judge a permission at all. Session-rule surfaces themselves are `sandbox/session-rules.md` (index:
`sandbox.md`).

## Deterministic scope gate (`scope.ts`)

Capability × `RUNNER_AUTHORITY` rung decided in code, composed as another fold form. `read_only` = inspect;
`writes_files` = command (a reviewer's own builds); `writes_outside`, `network`, `privileged`, `remote_code`,
`destructive`, `process_control` = mutate. A capability above the rung yields
`{action: refuse, reason: out_of_scope, confidence: 0}` with no request, and confidence 0 lets a named danger
outrank the scope label on ties. Custom agents map to the `agent` baseline (command rung); a consult that knows
the child's declared rung passes it as `DecisionContext.authority`, so a custom read-only definition is still
scope-checked at `inspect`. The look-up is a mirror of `AGENT_AUTHORITY_LADDER`, kept in step by hand.

Live evidence (reviewer child, `npm run scratch`, 2026-10-18): the pre-gate record was `writes_outside @ 0.447`
folded to `sandbox`, `applied: true`, no prompt — a silent sandbox. After the gate the same cached bodies folded
to `out_of_scope @ 0.0` → refuse → abstain, `applied: false`, and the human was prompted (approved →
`allow:sandbox`).

## The suggestion subject (`suggestion.ts`)

Not a permission question and never wired into a verdict: it exists because `src/modules/sandbox/suggestions.ts` cannot tell whether a path-like argument of an *unrecognized* package runner is data (`vitest test/a.ts`) or the program that runs (`tsx script.ts`), so it returns the exact rule plus a `widened` wildcard. The model answers one `bool` (`executes_code`, the measured wording in `SUGGESTION_INSTRUCTION`) and `suggestRuleForPrompt` in `tools/decision-model.ts` picks between the two table-built patterns; the model never generates a pattern. Measured on a 30-command battery the yes/no reached 29/30, while a direct "choose the pattern" question twice picked wildcards around executed code (`npx tsx *`, `npx tsx -e *`).

- **Its own evaluator, deliberately.** `SuggestionEvaluator` is separate from `DecisionEvaluator`: it has its own bounded cache (keyed on model, segment text, and recent window) and its own 30 s cooldown, so a failed suggestion request cannot pause a verdict and the veto request stays byte-identical to the measured design. Live cost ~85 ms / ~225 input tokens; only asked when the table returned `widened`, a prompt will be shown (`ctx.hasUI`), and the veto consult did not error/timeout.
- **Same-tool history is load-bearing.** The state is `{command, cwd, recent_commands}`; `decisionSimilarCommands` (in `session-context.ts`) keeps up to 3 earlier bash commands from the branch sharing the segment's first two words, clipped like other session items. One earlier `npx zorch run test/bar.test.ts` moved the role answer for `npx zorch run test/foo.test.ts` from 0.80 (code → exact) to 0.36 (data → `npx zorch *`); a mixed recent window left it at 0.61. This is the one place command history is measured *positive* — the veto's settled "no command history" finding was not retested and its request is untouched.
- **Config:** `decisionModel.suggestions` (default true) is the off switch; `enabled: true` is required. It is not tied to `surfaces`, because a suggestion grants no authority. Both gates share `suggestRuleForPrompt`; the parent passes `consultModel: ctx.hasUI && veto did not fail`, the child passes the parent's registry and its own veto status.
- The decision log records `prompt.suggestionSource` (`"table" | "model"`).
- Tests: `test/modules/decision/suggestion.test.ts`, `test/modules/decision/session-context.test.ts`, `test/modules/sandbox/suggestions.test.ts`, the `suggestRuleForPrompt` block in `test/tools/decision-model.test.ts`, and the child-prompt case in `test/tools/agent-scout-bash.test.ts`.
