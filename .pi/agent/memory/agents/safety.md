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

- All children receive cwd-confined `read`, `grep`, `find`, and `ls`, plus definition-configured additional read roots. The `memories` capability automatically adds `~/.pi/agent/memory`; children with Bash access may additionally read exact runtime-created full-output files reported in their own truncated Bash result details. These paths are validated as stable regular files under the temp directory and are not general `/tmp` roots. Scratchpad-capable children additionally receive a private temporary root whose symlink escapes remain blocked and whose filenames are not subject to the sensitive-name filter.
- Command and mutation authority is one ordered ladder — `read` < `inspect` (`safe-bash`) < `command` (`command-runner`) < `mutate` (`edit`) — and it decides _which gates apply_, whether tool calls serialize, and which extension label a child carries. It deliberately does not decide which tools exist: `edit` does not grant `bash`, so a mutation-only definition has no shell. Gates are installed in a fixed order (bash-output, file-access, interaction, commands, confinement) and pi runs `tool_call` handlers in registration order, so an approval recorded by one gate is visible to the gates installed after it; keep that sequence intact when changing gates.
- Custom `safe-bash` and built-in scout/advisor Bash calls use the shared cwd-confinement heuristic directly and run only when the complete command is classified `SAFE_READONLY`; definitions may add exact `safeBashCommands` patterns (with an optional trailing `*` for arguments); the definition author must ensure the executable is read-only, while matched invocations retain path, shell, sensitive-path, and symlink checks. They do not consult the normal permission resolver, parent/session Bash rules, or approval prompts. The `command-runner` capability uses the normal permission resolver, which combines explicit config/session rules with the same heuristic: safe heuristic commands may run directly, unresolved commands prompt, and explicit denies remain authoritative. Unknown, mutating/network/interpreter commands, and unsafe flags are therefore blocked by `safe-bash` but may be approved through `command-runner`. Safe-bash-specific contextual runtime checks are not automatically applied to command-runner.
- The shared heuristic emits structured `UnsafeReason` values and `CommandTag`s. The child consumes tags rather than reparsing shell text. `CommandTag.GIT_STATUS` drives the direct-child `core.fsmonitor` preflight: external helper values are blocked.
- Ordinary safe Git inspection (`git status`, `git diff`, `git log`, `git show`, including patch/history content) is allowed under the trusted-local policy. External-program and output-file options, Git network, mutation, and credential/config exposure remain blocked.

## Command and worker permissions

- Direct edit/write authority is limited to the built-in `worker`, which receives `edit`, `write`, and permission-gated `bash`. An internal isolated-workspace setup worker is also permission-gated but is not a normal parent-model run.
- Same-checkout `edit`/`write` calls inside the checkout use the parent's existing access without a second mutation prompt. Isolated workers' `edit`/`write` calls inside their dedicated worktree are likewise auto-allowed by the child mutation gate; sensitive project/symlink escapes remain rejected before prompting. Scratchpad reads/edits/writes are prompt-free, while definition additional paths are read-only roots; writes there use the existing parent file-access prompt for same-checkout workers. Non-isolated `command-runner` children share the parent's Bash permission state. Isolated workers and setup workers retain independent Bash permission state without inheriting parent-session rules. When the end user explicitly remembers a Bash rule in an isolated child, it is also recorded in the parent session for later parent or non-isolated child calls — which is why the parent's state handle is resolved without regard to isolation while the state the child reads back is not; do not collapse those two into one value.
- Outside-cwd mutation is fail-closed by redundancy rather than by a single check: for a same-checkout worker, both the shared file-access hooks and the command gate must let an out-of-root `edit`/`write` through, so one gate's approval cannot smuggle a path past the other. A worker whose parent session is unavailable gets no file-access gate at all and therefore behaves like an isolated child for path prompts.
- All child guards read one shared confinement policy (`child/policy.ts`); only the `access` mode differs per call site. Do not re-establish a per-gate copy of that object, since a disagreement between them is a privilege gap rather than a style problem.
- Command-runner Bash honors configured and inherited session rules without prompting when already allowed; unresolved commands use the parent-visible, run-labelled prompt and can add a session rule. A shared abort-aware FIFO dialog queue serializes parent and child permission dialogs; queued aborts must not let later dialogs overtake the active one.
- Mutation calls serialize through settlement. Successful edit/write paths are reported; approved Bash and concurrent parent activity can make attribution incomplete, so inspect the final diff.

## Scratchpad-local mutator hardening

`rm`, `mkdir`, `rmdir`, `touch`, `truncate`, `tee`, constrained `cp`/`mv`/
`chmod`, and audited `sed -i` may be classified as `SAFE_EDIT` for scratchpad
workflows. The implementation uses root-policy and strict-flag fields on
`CommandSpec`/`FlagSpec`, the registry in
`src/modules/sandbox/commands/mutators.ts`, sed validation in `commands/text.ts`,
and confinement checks behind the public `src/modules/sandbox/heuristics/index.ts` facade.

The hardening invariants are:

- Filesystem path slots reject parameter, brace, glob, tilde, and unmodeled
  shell expansion instead of predicting Bash. Scratchpad-only mutators reject
  expansion syntax in both path and consumed data values, preventing word
  splitting from injecting additional operands. For example,
  `touch /tmp/scratch/{ok,../outside/owned}`, `touch $TARGET`, and
  `truncate -s "$SIZE" /tmp/scratch/out` fall back to permission handling.
- Every heredoc falls back from the heuristic. The AST does not model enough
  body expansion semantics to prove safety, so even an apparently safe outer
  `cat`/`tee` cannot hide `$(...)` execution in a skipped body.
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
- `cp` accepts exactly one confined cwd/scratch source and one explicit
  scratchpad destination. Recursive copies, multiple sources, existing
  directory destinations, hard-linked operands, redirections, and risky flags
  fall back. `mv` accepts exactly one source/destination pair in the same
  scratchpad and rejects existing directory or hard-linked destinations.
- `chmod` accepts audited numeric/symbolic modes and nonrecursive scratchpad
  targets. `sed -i` reuses the safe-script audit, allows only plain `-i` or
  `--in-place`, requires scratchpad input files, strictly rejects unknown/long
  abbreviated options, backup suffixes, `--follow-symlinks`, script files, and
  scripts containing `e`/`r`/`w` effects.
- Write-through operations reject existing hard-linked regular files so a
  scratchpad alias cannot mutate a project inode. This applies to copy
  operands, move destinations, chmod/sed targets, and the existing
  touch/truncate/tee targets.
- Explicit permission rules remain authoritative. Read-only `safe-bash`
  continues to reject `SAFE_EDIT`, while permission-gated command runners may
  auto-run eligible scratchpad edits under the configured sandbox permission.

Regression coverage includes brace/parameter/glob expansion, substitutions,
heredocs, redirects and chains crossing roots, symlink-plus-`..`, dangling
symlinks, cross-root symlinks, reference options, unknown and abbreviated
flags, copy/move destination semantics, recursive-copy rejection, hard links,
chmod modes, audited sed in-place forms, and resolver fallback.

Residual limitations are deliberately fail-closed: parsed-argument entrypoints
without AST provenance may prompt for a literal filename containing expansion
metacharacters even when the original shell text quoted it. Filesystem checks
also retain an unavoidable time-of-check/time-of-use race; bubblewrap is defense
in depth and currently mounts broader writable locations than the scratchpad.
Do not broaden the mutator list without dedicated argument/side-effect models
and equivalent negative tests. Keep `find -delete`, recursive/multi-source
copy, archive extraction, `ln`, `install`, and similar complex commands behind
normal permission handling.
