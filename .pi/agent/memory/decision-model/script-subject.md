---
name: script-subject
description: "Script subject: resolveScriptRun body chasing and kinds, the capability verdict and SCRIPT_ACTION_TABLE, the four caches, and abstain-on-failure."
category: architecture
keep_updated: true
---

# Script bodies and the capability verdict

Index: [../decision-model.md](../decision-model.md). A script verdict is a property of the code, not the invocation; the deterministic capability gate that
folds with it is in [scope-suggestion.md](scope-suggestion.md).

## Script subject (`script.ts`, `script-classification.ts`)

- `resolveScriptRun` walks indirection rather than the first line: a package script line is parsed with the
  same `parseBashAst` + wrapper unwrap as the top-level command, nested package invocations are chased
  transitively (depth cap 5, visited-set cycle guard), and each local file an interpreter invokes is read.
  Kinds: `package` and `file` carry bodies; `inline` (`-c`/`-e`/`--eval`, heredoc) carries the literal code as
  a body too (`inline:<interpreter> <flag>` / `inline:heredoc`), while a dynamically assembled operand and
  `binary` (npx family, `uv run`/`uvx`, interpreter `-m`) contribute none. Omissions (`cycle:`/`depth:`) are
  recorded, never shortened silently.
- A script verdict is a **property of the code**, not the invocation: `scriptRequest(body)` sends `{code}`
  alone under one `script` choice with capability criteria, cached by `sha256(body)` — a rename or touch hits,
  any byte edit misses.
- `SCRIPT_ACTION_TABLE`: `read_only`/`writes_files`/`network → host`; `writes_outside`/`privileged → sandbox`;
  `destructive`/`remote_code`/`process_control → refuse`.
- The command is classified separately as an invocation whose state carries the capability summaries.
  `foldAnswers` folds command + capabilities: most severe wins, `host` only when every form answered safely,
  and capabilities withhold but never grant — so the `host` floor is the **command answer's** confidence, and
  one unsure capability cannot drag a confident command behind it. A body with no answer abstains the whole
  verdict before the command is asked.
- Caches, all in-memory and process-lifetime (`resetDecisionScriptCache`, `resetDecisionEvaluator`): a read
  cache `(path, mtimeMs, size)`; a script answer cache `(provider, model, sha256)`; a command answer cache
  `(strategy, provider, model, command, runner, isolation, profile set)`; and a size-rejection memo keyed by the
  command key plus the serialized request size. `apply`/`minConfidence` and the request/recent text are not in
  any key (the request and recent were measured nearly inert; history moved 0 of 80).
- Failure policy: an error, timeout, or rejected payload on any form abstains the whole verdict and reaches the
  prompt, never an allow — even with `apply: true` — and failures are never cached as verdicts (forms that
  answered stay cached). One flaky body also starts the global cooldown, so a command with N bodies has N
  chances to pause the model.
