---
name: heuristics
description: Design and safety invariants for the cwd-confinement permission heuristic in src/modules/sandbox.
category: architecture
---

# Cwd-confinement heuristic

The sandbox permission flow is implemented in `src/modules/sandbox/resolve.ts` and used by `src/tools/bash/index.ts`. Direct read/write path checks are implemented in `src/modules/sandbox/heuristics/` and used by `src/tools/file-permissions.ts`; callers still import through the public `src/modules/sandbox/heuristics/index.ts` facade (formerly a single file). path checks classify read access as `SAFE_READONLY`, write access as `SAFE_EDIT`, and rejected access as `UNSAFE`. Runtime-managed temporary scratchpads are supplied as additional cwd-confinement roots; scratchpad filenames bypass sensitive-name filtering, but canonical/symlink containment remains enforced.

## Resolution order

- `resolvePermissionDetails()` first checks the whole parsed line against explicit patterns; a whole-line match wins.
- Otherwise it resolves each chain segment independently: explicit segment pattern, then cwd-confinement heuristic only when the segment would otherwise be `ask`.
- A non-`ask` `**` default is authoritative: heuristics do not relax `deny` or downgrade `allow`.
- `deny` dominates; unresolved segments force `ask`; policy permissions combine most-restrictively; heuristic-only chains resolve to the configured heuristic permission (normally `allow:sandbox`). The heuristic classifiers return `Heuristic.SAFE_READONLY`, `Heuristic.SAFE_EDIT`, or `Heuristic.UNSAFE`; the resolver only treats the two SAFE variants as grants and maps them to the configured execution permission. `getCwdConfinementAssessment()`, `getArgsConfinementAssessment()`, and `getPathConfinementAssessment()` additionally return structured `UnsafeReason` codes and deduplicated semantic `CommandTag`s for future scout/review agents. Tags are emitted only by successfully classified command specs and let runtime policy apply contextual safeguards without reparsing shell text; `CommandTag.GIT_STATUS` currently drives the child fsmonitor check.
- Chain operators remain parser arguments and must be present in whole-command patterns.

## Module layout

`src/modules/sandbox/heuristics/index.ts` is the public facade; it re-exports classifications, assessments, state helpers, chain utilities, and command-registry types, and implements the config-resolving entrypoints. The implementation is split into internals with clear responsibilities, all kept private to callers outside the module:

- `heuristics/types.ts` — public classifications, unsafe reasons, assessment/diagnostics helpers, and cwd-state contracts.
- `heuristics/path-policy.ts` — lexical/canonical path checks, sensitive patterns, additional-root pairing, symlink containment, directory/hard-link checks, and `buildConfinementOptions`.
- `heuristics/command-access.ts` — `CommandSpec` flag/positional interpretation, shell substitution handling (via an injected evaluator callback to avoid cycles), redirections, and custom safe-Bash parsing.
- `heuristics/evaluator.ts` — shell parsing, chain splitting, modeled `cd`/`pushd`/`popd` state, leading environment checks, and command-confinement evaluation.

Existing callers import from `./heuristics`; no other module should depend on the internal split files directly. Its path, command-string, and parsed-args entrypoints (`getPathConfinement*`, `getCwdConfinement*`, and `getArgsConfinement*`) take the primary target positionally, with `cwd` plus ancillary controls in one named options object. The facade exports `PathConfinementOptions`, `CwdConfinementOptions`, and `ArgsConfinementOptions`; config, access, roots, state, and custom safe-command controls are named optional fields.

## Command registry

`src/modules/sandbox/commands/` contains curated `CommandSpec` data. Unknown or unclassifiable arguments are treated as paths and must resolve inside the cwd. Only explicitly modeled value slots and safe pattern slots bypass path checking. Commands that can execute code are excluded from the whitelist; unsafe flags and traversal modes are marked ineligible. Commands with semantics hidden in arguments may use `CommandSpec.validate` (including subcommand specs, which receive args starting at the subcommand); `sed` is limited to lexically audited print/substitute scripts, rejects script files, execution/read/write commands, and in-place mode. `git diff` is allowlisted for read-only patch, built-in short help (`-h`), checking, stat-summary metadata (including `--numstat`, `--shortstat`, `--summary`, `--compact-summary`, and `--dirstat` forms), quiet, and explicit confined-path output; external-program and output-file options remain ineligible. Long help (`--help`) remains ineligible because Git invokes an external man/help viewer. `git log` and `git show`, including historical patch content, are ordinary read-only project access under the trusted-local-environment policy; `git show --output` remains ineligible because it writes a file. Stream-only text filters include `fold`, `fmt`, `expand`, `unexpand`, `nl`, `tac`, and `rev`.

Important exclusions include unsafe `git diff` modes, `cat-file` (output-channel risk), credential-printing/network/mutating git subcommands, shell wrappers, interpreters, and exec-capable flags. Safe output flags use `OUTPUT_PATH_VALUE` and classify successful invocations as `SAFE_EDIT`. The shell builtin `command` is allowlisted only for `-v`/`-V` lookup modes (optionally with `-p`); ordinary forms that execute an operand remain ineligible. Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted.

## Path and environment safety

- Path arguments are checked lexically and, when enabled, through canonical realpaths.
- Outside paths containing symlink components are classified as `SYMLINK_ESCAPE` before file-access approval, so child hooks cannot turn a one-shot outside approval into a symlink escape. `resolveSymlinks: false` retains the lexical outside-path behavior.
- Canonicalization walks components in kernel order, resolving symlinks before a following `..`. Nonexistent trailing write targets are allowed, dangling symlinks and additional-root inputs containing explicit `.`/`..` components are rejected, and the most-specific lexical additional root is paired with its own canonical root. Scratchpad-local `rm`, `mkdir`, `rmdir`, `touch`, `truncate`, `tee`, constrained `cp`/`mv`/`chmod`, and audited `sed -i` may return `SAFE_EDIT`; unknown/dynamic forms fall back. `cp` permits one confined read source and one explicit scratch destination but rejects recursive copies and directory destinations; `mv` remains wholly scratch-local; chmod is nonrecursive; sed rejects abbreviations, backups, follow-symlinks, script files, and unsafe scripts. Existing hard-linked regular-file mutation targets are rejected.
- Symlink-following traversal flags are unsafe; symlinks inside a directory argument are not recursively walked.
- Sensitive path segments include `.env*`, `.git`, credential directories/files, private-key extensions, `*.tfvars`, and `credentials`; `denyPaths` extends the list and `blockDotfiles` enables paranoid mode. Direct read/write paths use the same sensitive and symlink checks; the parent read hook additionally permits the user memory directory (`~/.pi/agent/memory`) as a read root, while the parent write/edit hook does not. Parent Bash also receives that directory as a read-only additional root and mounts it read-only when sandboxed. Explicit session folder approvals remain scoped to the selected operation and are restored from `pi-file-sandbox:allowed-file-folder` custom session entries.
- Subshells, process substitutions, and redirection targets recurse through confinement checks. Process-substitution capability propagates nested `SAFE_EDIT`; command substitutions in data slots may recurse safely, while path-slot command substitutions require a statically modeled `pwd`/single-literal `echo`/`printf` output whose produced path still passes confinement. Unmodeled shell expansion in filesystem path slots falls back; scratchpad-only mutators reject expansion in consumed path and data values. Heredocs always fall back because the parser does not retain enough body/delimiter metadata to prove expansion safety.
- The heuristic tracks modeled shell directory state per command line: `cd`, `pushd <path>`, `popd`, and `cd -` update the current directory, previous directory, and stack. The original cwd remains the confinement root; dynamic/unsupported directory forms and outside destinations fall back, while later modeled `cd` operations may recover state. Directory changes in pipelines/background segments do not persist to subsequent commands.
- Dangerous leading assignments (`LD_*`, `GIT_*`, `PATH`, `IFS`, `BASH_ENV`, `RIPGREP_CONFIG_PATH`, `LESSOPEN`, etc.) are rejected. Inherited environment remains an accepted risk unless `sandbox.inheritEnv` enables the clearenv allowlist.

Configuration is `heuristics.cwdConfinement` in `src/common/config.ts`: `enabled`, `permission`, `commands`, `denyPaths`, `blockDotfiles`, and `resolveSymlinks`. Cwd-confinement tests pass config explicitly and use real temporary directories for symlink cases.

Permission suggestion rules in `src/modules/sandbox/suggestions.ts` preserve wildcard semantics: a trailing `*` consumes one or more arguments, so suggestions for argument-less invocations save an exact rule and only append `*` when extra arguments are present.

Tests: `test/modules/sandbox/heuristics.test.ts`, `resolve.test.ts`, and seeded `fuzz.test.ts`. The curation audit command from the standalone sandbox repository is intentionally not part of pi-coder.
