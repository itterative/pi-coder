---
name: child-consult
description: "Read-only child safe-bash consult: the deterministic conditions for asking, the safe/readable classes, held unjudged bodies, and the record shape."
category: architecture
keep_updated: true
---

# The read-only child gate

Index: [../decision-model.md](../decision-model.md). This is the gate with no prompt to fall back on, so every failure or abstain here blocks. The
sentence the child is shown lives in [runner-output.md](runner-output.md); the confinement classes it leans on
are documented in `sandbox/probe.md` (index: `sandbox.md`).

## Read-only child consult (`safe-bash-decision.ts`)

A child below the `command` rung has no prompt to fall back on, so `safe-bash` was the whole policy. When
`surfaces` includes `child`, an allowlist failure now gets a model second opinion under three deterministic
conditions:

1. the assessment is `UNSAFE` and carries no confinement or authority reason (outside cwd, not in a writable
   root, sensitive path, symlink escape, dynamic cwd, parse failure, dangerous environment, command path,
   unsafe flag, unsafe mode, heuristic disabled). This is a denylist, not an allowlist: `UNKNOWN_COMMAND`,
   `COMMAND_NOT_ALLOWED`, `EMPTY_INPUT`, `UNSAFE_COMMAND`, `UNSAFE_SUBCOMMAND`, and `DYNAMIC_PATH` may reach the
   relaxed check, while a `SAFE_EDIT` write classification never does. The relaxed check is the real gate, so
   an assessment the strict pass could not explain (no reasons) is still consultable; before, it was silently
   refused even when the relaxed view called the command safe;
2. `classifyRelaxedConfinement` returns `safe` or `readable` — a known command's unmodeled subcommand still
   fails here, because the relaxed pass re-derives the same curated spec, which is why the git forensic verbs
   were curated rather than routed to the model;
3. the child surface is enabled in the decision config, and `apply` is what lets a verdict act. `safe` is the relaxed assessment — each bare executable admitted as a generic, path-checked command —
passing with literal paths confined. `readable` is a single code subject read from disk (`resolveScriptRun`
artifacts, each artifact path confined) whose only remaining failures are dynamic paths: the code/file operand
and every flag/env word are literal, and the unmodeled words are data positionals — file subjects may take
them, inline subjects may not, because `node -e CODE --require $X` still parses options after the code
(verified locally). Chains, `timeout` wrappers, and `cd` prefixes are unwrapped for the single-subject check,
and the subject is re-assessed with the code operand and dynamic data positionals replaced by placeholders so
literal paths beside them are still checked. `sandboxAvailable` is
false because this path has no bwrap execution, so `sandbox` abstains; every failure or abstain blocks. A
verdict may proceed only when policy applies `host` above `minConfidence`, and a recognized script whose body
was never judged (a `binary` run, a dynamically assembled inline operand) is held even then — an unread body
must not gain authority through the invocation answer. The consult passes the child's declared `authority`, so
a custom read-only definition is scope-checked at `inspect` rather than the `agent` name's command baseline.
The record carries `readOnlyGate: true` and no `resolution`; `npm run permission-report` lists those rows in a
READ-ONLY CHILD GATE section. A refusal that happens before any request now writes the same record shape with
`reasons` and `readOnlyGateStage` (`not-consultable`, `surface-disabled`, or `relaxed-unsafe`) and no
`classifier`, so an allowlist gap is visible in the report instead of only in a child transcript.
