---
name: safety
description: Detailed delegated-agent capability limits, confinement heuristics, approvals, and trust assumptions.
category: convention
keep_updated: true
---

# Agent safety

## Trust boundary

Delegated-agent restrictions are local permission and accident-prevention controls, not a security sandbox. Pi-coder trusts the Pi process environment (`PATH`/`GIT_*`), installed executables, Git configuration, and selected checkout; it defends against model-initiated authority escalation, not a hostile local runtime. `SAFE_READONLY` means heuristically non-project-mutating, not side-effect-free.

## Read-only children

The built-in `advisor` has the same read-only capability boundary as `scout`; it is an explicit consultation agent, cannot mutate files, and does not receive the direct end-user `ask_user` tool. It uses `ask_parent` for guidance. The built-in `reviewer` additionally has the permission-gated `command-runner` capability, so it can run user-approved project commands while retaining no direct edit/write tools.

- All children receive cwd-confined `read`, `grep`, `find`, and `ls`; scratchpad-capable children additionally receive a private temporary root whose symlink escapes remain blocked and whose filenames are not subject to the sensitive-name filter.
- Custom `safe-bash` and built-in scout/advisor Bash calls use the shared cwd-confinement heuristic directly and run only when the complete command is classified `SAFE_READONLY`; they do not consult the normal permission resolver, parent/session Bash rules, or approval prompts. The `command-runner` capability uses the normal permission resolver, which combines explicit config/session rules with the same heuristic: safe heuristic commands may run directly, unresolved commands prompt, and explicit denies remain authoritative. Unknown, mutating/network/interpreter commands, and unsafe flags are therefore blocked by `safe-bash` but may be approved through `command-runner`. Safe-bash-specific contextual runtime checks are not automatically applied to command-runner.
- The shared heuristic emits structured `UnsafeReason` values and `CommandTag`s. The child consumes tags rather than reparsing shell text. `CommandTag.GIT_STATUS` drives the direct-child `core.fsmonitor` preflight: external helper values are blocked.
- Ordinary safe Git inspection (`git status`, `git diff`, `git log`, `git show`, including patch/history content) is allowed under the trusted-local policy. External-program and output-file options, Git network, mutation, and credential/config exposure remain blocked.

## Command and worker permissions

- Direct edit/write authority is limited to the built-in `worker`, which receives `edit`, `write`, and permission-gated `bash`. An internal isolated-workspace setup worker is also permission-gated but is not a normal parent-model run.
- Same-checkout `edit`/`write` calls inside the checkout use the parent's existing access without a second mutation prompt. The child mutation gate evaluates these paths as write access before auto-allowing them. Scratchpad reads/edits/writes are prompt-free, while outside-cwd reads and edits use the existing parent file-access prompt and sensitive project/symlink escapes are rejected before prompting. Non-isolated `command-runner` children share the parent's Bash permission state. Isolated workers and setup workers retain independent permission prompts without parent-session inheritance.
- Command-runner Bash honors configured and inherited session rules without prompting when already allowed; unresolved commands use the parent-visible, run-labelled prompt and can add a session rule. A shared abort-aware FIFO dialog queue serializes parent and child permission dialogs; queued aborts must not let later dialogs overtake the active one.
- Mutation calls serialize through settlement. Successful edit/write paths are reported; approved Bash and concurrent parent activity can make attribution incomplete, so inspect the final diff.

## Scratchpad-local mutator audit (unresolved)

The current WIP adds `rm`, `mkdir`, `rmdir`, `touch`, `truncate`, and `tee` as
`SAFE_EDIT` commands only when every extracted path is inside a managed
additional root. This behavior is implemented through `additionalRootOnly` and
`writes` fields on `CommandSpec`, the registry in
`src/modules/sandbox/commands/mutators.ts`, and the path checks in
`src/modules/sandbox/heuristics.ts`. It must not be considered safe to broaden
this list until the following issues are fixed:

- **Shell expansion can change the effective path after validation.**
  `extractCommandPaths()` checks parser tokens, but does not model all Bash
  brace, parameter, glob, or similar expansions. For example,
  `touch /tmp/scratch/{ok,../outside/owned}` can look like one lexical path
  under the scratchpad while Bash expands it to an outside sibling. A variable
  such as `$TARGET` can likewise expand to an outside path unless it is rejected
  or resolved conservatively. This affects every scratchpad-only mutator.
- **Heredoc bodies are not included in confinement analysis.**
  `src/modules/sandbox/bash.ts`/the parser represents the heredoc operator and
  delimiter but does not validate the body as part of the command access. An
  unquoted heredoc can perform command substitution, for example:
  `tee /tmp/scratch/output <<EOF\n$(touch /tmp/outside/owned)\nEOF`.
  The outer `tee` may be auto-approved while the body executes the outside
  mutation. Auto-approved mutators should reject heredocs or the parser must
  expose and recursively validate their bodies.
- **A symlink followed by `..` can escape before canonical checks.**
  `resolvePath()`/`canonicalizePath()` normalize with `path.resolve()` before
  inspecting components. With `scratch/link -> /tmp/target`, a path such as
  `scratch/link/../outside/file` can be normalized to a scratch-looking path,
  even though the kernel follows `link` first and then resolves `..` under
  `/tmp`. Preserve symlink components or use a component-aware resolution
  algorithm; the broad writable `/tmp` sandbox mount does not contain this.
- **Multiple additional roots are not paired with their canonical roots.**
  `isRealPathConfined()` and `isPathWithinAdditionalRoot()` currently accept a
  target under any canonical additional root. A path lexically selected under
  root A can therefore resolve through a symlink into root B and pass. Runtime
  scratchpads currently supply one root, but the public APIs accept arrays and
  must preserve same-root isolation before more roots are used.
- **Reference-file options are not modeled.** `touch -r/etc/passwd
  /tmp/scratch/out` and equivalent `truncate -r...` forms are currently parsed
  as an unknown short-option cluster; the external reference path is not
  checked, while the scratch output makes the command eligible. Model `-r` /
  `--reference` as a path-valued option or reject these options for the
  scratchpad-only specs.

Required follow-up includes negative tests for brace/parameter/glob expansion,
heredocs, symlink-plus-`..`, cross-root symlinks, dangling targets, and
reference flags. Until then, keep complex mutators (`cp`, `mv`, `find -delete`,
`sed -i`, archive extraction, `ln`, `install`, and similar commands) behind the
normal permission gate and do not treat the current six-command relaxation as a
complete confinement boundary.
