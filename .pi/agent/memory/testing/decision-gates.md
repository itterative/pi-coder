---
name: decision-gates
description: Reaching a decision-model gate from a fixture takes two keys turned - the blank-vs-set config env stub and the evaluator reset.
category: workflow
---

# Reaching a decision-model gate from a fixture

**Reaching a decision-model gate from a fixture takes two keys turned.** A suite that turns only one reports a
pass without ever consulting a model.

## 1. Un-suppress the config walk-up

`test/setup.ts` pins `DECISION_MODEL_CONFIG_PATH` blank, and a set-but-blank value suppresses the project
**walk-up** as well as the fallback. So a fixture that writes its own `.pi/decision-model-config.json` is
invisible until the suite calls `vi.stubEnv("DECISION_MODEL_CONFIG_PATH", <nonexistent path>)`; without it every
gate reports "not configured" and the test passes by never consulting.

## 2. Reset the evaluator between runs

Call `resetDecisionEvaluator()` between two runs of the same command: the answer cache is keyed on
strategy/provider/model/command/runner/isolation/profiles, **not** on `apply` or `minConfidence`, so the second
run quietly reuses the first verdict.

## Reference suite

See `test/tools/agent-child-decision-blocks.test.ts`, which turns both keys.

Related: the decision model itself is the `decision-model` memory (`../decision-model.md`); the classifier and
record doubles a gate fixture should use are in
`../test-doubles/decision-and-trace-doubles.md`.
