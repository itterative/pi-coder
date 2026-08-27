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

## Scratchpad-local mutator hardening

`rm`, `mkdir`, `rmdir`, `touch`, `truncate`, and `tee` may be classified as
`SAFE_EDIT` only when every modeled access remains in one managed additional
root. The implementation uses `writes`, `additionalRootOnly`, and
`rejectUnknownFlags` on `CommandSpec`, the registry in
`src/modules/sandbox/commands/mutators.ts`, and confinement checks in
`src/modules/sandbox/heuristics.ts`.

The hardening invariants are:

- Filesystem path slots reject parameter, brace, glob, tilde, and unmodeled
  shell expansion instead of predicting Bash. Scratchpad-only mutators reject
  expansion syntax in both path and consumed data values, preventing word
  splitting from injecting additional operands. For example,
  `touch /tmp/scratch/{ok,../outside/owned}`, `touch $TARGET`, and
  `truncate -s "$SIZE" /tmp/scratch/out` fall back to permission handling.
- Every heredoc falls back from the heuristic. `parseBash()` does not preserve
  body expansion or quoted-delimiter metadata, so even an apparently safe
  outer `cat`/`tee` cannot hide `$(...)` execution in a skipped body.
- Canonicalization processes components left to right, resolving a symlink
  before a following `..`, matching kernel lookup order. Existing dangling
  symlinks are rejected; nonexistent trailing write components remain usable.
- Lexical and canonical additional roots are paired. Root inputs containing
  explicit `.` or `..` components are rejected before registration. The
  most-specific lexical root authorizes the path, and its own canonical root
  must contain the result; a symlink from root A into separately managed root B
  does not pass.
- Scratchpad mutator specs reject unknown flags. `touch -r`/`--reference` and
  `truncate -r`/`--reference` are explicit path-valued options, so references
  outside the same scratchpad fall back while scratchpad-local references may
  pass.
- Explicit permission rules remain authoritative. Read-only `safe-bash`
  continues to reject `SAFE_EDIT`, while permission-gated command runners may
  auto-run eligible scratchpad edits under the configured sandbox permission.

Regression coverage includes brace/parameter/glob expansion, substitutions,
heredocs, redirects and chains crossing roots, symlink-plus-`..`, dangling
symlinks for all six mutators, cross-root symlinks, reference options, unknown
flags, and resolver fallback.

Residual limitations are deliberately fail-closed: because `parseBash()` strips
quote and escape provenance, a literal filename containing expansion
metacharacters may prompt even when quoted. Filesystem checks also retain an
unavoidable time-of-check/time-of-use race; bubblewrap is defense in depth and
currently mounts broader writable locations than the scratchpad. Do not broaden
the mutator list without dedicated argument/side-effect models and equivalent
negative tests. Keep `cp`, `mv`, `find -delete`, `sed -i`, archive extraction,
`ln`, `install`, and similar commands behind normal permission handling.
