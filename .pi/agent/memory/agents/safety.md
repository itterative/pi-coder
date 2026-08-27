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

- All children receive cwd-confined `read`, `grep`, `find`, and `ls`; paths are checked for sensitive segments, symlink escapes, and outside traversal.
- Custom `safe-bash` and built-in scout/advisor Bash calls use the shared cwd-confinement heuristic directly and run only when the complete command is classified `SAFE_READONLY`; they do not consult the normal permission resolver, parent/session Bash rules, or approval prompts. The `command-runner` capability uses the normal permission resolver, which combines explicit config/session rules with the same heuristic: safe heuristic commands may run directly, unresolved commands prompt, and explicit denies remain authoritative. Unknown, mutating/network/interpreter commands, and unsafe flags are therefore blocked by `safe-bash` but may be approved through `command-runner`. Safe-bash-specific contextual runtime checks are not automatically applied to command-runner.
- The shared heuristic emits structured `UnsafeReason` values and `CommandTag`s. The child consumes tags rather than reparsing shell text. `CommandTag.GIT_STATUS` drives the direct-child `core.fsmonitor` preflight: external helper values are blocked.
- Ordinary safe Git inspection (`git status`, `git diff`, `git log`, `git show`, including patch/history content) is allowed under the trusted-local policy. External-program and output-file options, Git network, mutation, and credential/config exposure remain blocked.

## Command and worker permissions

- Direct edit/write authority is limited to the built-in `worker`, which receives `edit`, `write`, and permission-gated `bash`. An internal isolated-workspace setup worker is also permission-gated but is not a normal parent-model run.
- Same-checkout `edit`/`write` calls inside the checkout use the parent's existing access without a second mutation prompt. The child mutation gate evaluates these paths as write access before auto-allowing them. Outside-cwd reads and edits use the existing parent file-access prompt, while sensitive/symlink escapes are rejected before prompting. Non-isolated `command-runner` children share the parent's Bash permission state. Isolated workers and setup workers retain independent permission prompts without parent-session inheritance.
- Command-runner Bash honors configured and inherited session rules without prompting when already allowed; unresolved commands use the parent-visible, run-labelled prompt and can add a session rule. A shared abort-aware FIFO dialog queue serializes parent and child permission dialogs; queued aborts must not let later dialogs overtake the active one.
- Mutation calls serialize through settlement. Successful edit/write paths are reported; approved Bash and concurrent parent activity can make attribution incomplete, so inspect the final diff.
