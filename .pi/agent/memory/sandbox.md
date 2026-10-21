---
name: sandbox
description: Index for the cwd-confinement bash permission model in src/modules/sandbox — resolution order, config, core invariants, and detail docs.
category: architecture
priority: 6
keep_updated: true
---

# Bash sandbox and cwd confinement

The model here is **cwd confinement**: a Bash command may be granted without a prompt only when every filesystem
operand it can reach stays inside the cwd (plus configured roots and the runtime scratchpad) and the command cannot
execute code or escape through a flag. Code lives in `src/modules/sandbox/` — `resolve.ts` (the flow), `bash.ts`
(the AST), `heuristics/` (the checks), `commands/` (the curated specs), `suggestions.ts`, `command-wrappers.ts`,
`file-roots.ts`, `probe.ts`, `decision-log.ts`, `bubblewrap.ts` — and is driven by `src/tools/bash/index.ts`; direct
read/write path checks reuse the same heuristics through `src/tools/file-permissions.ts`. Configuration is
project-local `.pi/bash-sandbox-config.json` or global `~/.pi/bash-sandbox-config.json` (overridable with
`SANDBOX_CONFIG_PATH` / `SANDBOX_CONFIG_PATH_GLOBAL`; `/bash-sandbox-config` shows what loaded).

**Resolution order, in brief:** a whole-line rule match wins; otherwise each chain segment resolves on its own —
explicit segment rule first, then the cwd-confinement heuristic, and only for a segment that would otherwise `ask`.

**Invariants most often broken:**

- A non-`ask` `**` default is authoritative: heuristics do not relax `deny` or downgrade `allow`; `deny` dominates
  and unresolved segments force `ask` (`sandbox/confinement.md`).
- One unwrap transform serves classifier, matcher, and logging (`unwrapWrapperCommand()`); never re-derive a wrapped
  view from a raw token list in a new consumer, and never offer a `timeout *` rule (`sandbox/commands.md`).
- A declared root is not a sensitive-name exemption, and mounts widen reads, never writes. The scratchpad and user
  memory bypass of name filtering is explicit policy, not the "unset means exempt" default (`sandbox/confinement.md`).
- Shell expansion is gated **per slot**, never per command, and only for unquoted words: checking a set smaller
  than the shell's is the one unsound direction (`sandbox/path-safety.md`).
- `tryLoad()` whitelists every `heuristics.cwdConfinement` field — a new key missing there and in the merge
  function is silently dropped (`sandbox/confinement.md`).
- Session rules are runtime state only: never written to config, never shown by `/bash-sandbox-config`, merged
  after config rules so they win on identical patterns (`sandbox/session-rules.md`).

**`safe-bash` is** the curated read-only command set judged by this same heuristic (`Heuristic.SAFE_READONLY`, with
`safeBashCommands` extending it conservatively); it is **not** a security sandbox, and `probe.ts` is a sensor that
reports what a command would change — it decides nothing.

## Targeted references

Load only the detail needed for the task:

- `sandbox/confinement.md` — permission flow, file-access roots, resolution order, module layout, config keys.
- `sandbox/commands.md` — the `CommandSpec` registry and transparent wrapper unwrapping.
- `sandbox/path-safety.md` — path, symlink, sensitive-name, shell-expansion, directory-state, and environment rules.
- `sandbox/session-rules.md` — how a rule is proposed, built, stored, matched, and shown in the prompt.
- `sandbox/probe.md` — the overlay copy-on-write probe, its invariants, limits, and concluded classifier findings.
- `sandbox/decision-log.md` — the JSONL decision log: recorded fields, location, rotation, and mining.

These nested documents are on-demand references and are intentionally not included in the memory list
automatically. Keep this index and the detail files concise; update them when behavior or ownership changes.
