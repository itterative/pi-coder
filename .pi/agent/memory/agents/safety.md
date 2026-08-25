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

The built-in `advisor` has the same read-only capability boundary as `scout` and `reviewer`; it is an explicit consultation agent, cannot mutate files, and does not receive the direct end-user `ask_user` tool. It uses `ask_parent` for guidance.

- All children receive cwd-confined `read`, `grep`, `find`, and `ls`; paths are checked for sensitive segments, symlink escapes, and outside traversal.
- Custom `safe-bash` and built-in scout/reviewer/advisor Bash calls run only when the complete command is classified `SAFE_READONLY`. Unknown commands, mutating/network/interpreter commands, unsafe flags, and `SAFE_EDIT` classifications are blocked without an approval bypass.
- The shared heuristic emits structured `UnsafeReason` values and `CommandTag`s. The child consumes tags rather than reparsing shell text. `CommandTag.GIT_STATUS` drives the direct-child `core.fsmonitor` preflight: external helper values are blocked.
- Ordinary safe Git history inspection (`git log`, `git show`, including historical patch content) is allowed under the trusted-local policy. Git network, mutation, credential/config exposure, and unsafe output modes remain blocked.

## Worker permissions

- User-selectable mutation authority is limited to the built-in `worker`, which receives `edit`, `write`, and `bash`. An internal isolated-workspace setup worker is also permission-gated but is not a normal parent-model run.
- Each worker mutation opens a parent-visible, run-labelled, one-shot prompt. Approval never becomes a parent/session rule. File paths remain confined and sensitive/symlink escapes are rejected before prompting.
- Worker Bash honors configured denial and sandbox/direct mode, propagates user notes, and defaults unresolved commands to sandbox when available. A shared abort-aware FIFO dialog queue serializes parent and child permission dialogs; queued aborts must not let later dialogs overtake the active one.
- Mutation calls serialize through settlement. Successful edit/write paths are reported; approved Bash and concurrent parent activity can make attribution incomplete, so inspect the final diff.
