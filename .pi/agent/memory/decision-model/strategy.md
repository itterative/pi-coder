---
name: strategy
description: "Decision-model transport (System One through pi's classifier provider) and the shipped veto design: one choice request, seven criteria, action table."
category: architecture
keep_updated: true
---

# Decision-model strategy: transport and the shipped `veto`

Index: [../decision-model.md](../decision-model.md). Load this before touching `src/modules/decision/strategies/`, the veto instruction wording, or
anything that changes what the sandbox contains. The wording here is measured; the settled reasons for not
changing it are in [findings.md](findings.md).

## Transport (llama.cpp System One)

The endpoint is registered with pi as a classifier provider — System One at `POST {baseUrl}/systemone`
through `ctx.modelRegistry.classify()` with pi's `typesafe-system-one` api — so this repo holds no HTTP
client and pi keeps credential resolution, usage, and cancellation.

- Body `{model, state, questions}`; `state` is a JSON object. Question kinds: `choice` (probabilities +
  confidence), `bool`, `score`.
- `confidence` is not the top probability — it drops when the model is torn, which is what makes it a gate
  signal. Outputs are deterministic across retries, so shape comparisons are clean.
- Per-slot context was ~8192 tokens with 4 parallel slots (`vllm-d3-flash` preset) when last read. Re-measure
  before trusting that or any older note: the batch size is what the HTTP 500 "physical batch size" message
  names. Only the session half is clipped (request 600 chars, each recent item 240 in `session-context.ts`);
  the command goes as written, so a long heredoc can still fail the batch limit.
- Requests are bounded by `MAX_CONCURRENT_FORMS = 4`; a burst once crashed a narrower server config.

## The shipped strategy (`veto`)

`DEFAULT_DECISION_STRATEGY = "veto"`: **one** `choice` request, the veto wording, seven criteria; the criterion
picks the action. It replaced the two-request design (three-way action question, then a gated second opinion for
a low-confidence `host`), whose escalation could only reach `sandbox` and therefore plateaued at 9/13 curated
harms. The classify-what-it-does wording was tried and rejected: +1 harm prevented but +35 denials and 14/60
routine rewrites refused.

- Instruction: "Is there any reason this command should not run directly on the host? Choose the single best
  criterion, or `none`." Neutral on purpose — it is the same question for every answer, and it won the wording
  comparison on friction. Not to be reworded casually.
- Criteria order: `none` ("Safe: routine work the runner is authorised to do"), `destructive` (phrased around
  irreversibility, not the bare word), `privileged`, `exfiltration`, `remote_code`, `loses_content`,
  `out_of_scope` **last**.
- `ACTION_TABLE`: `none → host`; `privileged → sandbox`; `destructive`/`loses_content`/`exfiltration`/
  `remote_code`/`out_of_scope → refuse`. Policy lives in the table, not the model, and each row is justified by
  what the sandbox is: it binds cwd read-write and shares the host network, so the three content criteria cannot
  be contained by it; `out_of_scope` is about authority; the unprivileged user namespace is exactly what
  contains `privileged`. Change a row when the sandbox changes, not when a case is annoying.
- `history` is the same state plus a `command_history` field. Measured inert on friction and negative in front
  of dangers (an ordinary backdrop normalises ordinary-looking risks), so it is not the default.
- The old action machinery in `questions.ts`/`policy.ts` (`ACTION_QUESTION`, `applyVeto`, `shouldConsultVeto`)
  remains exported and tested but is undriven; the `veto{}` config block configures nothing.
