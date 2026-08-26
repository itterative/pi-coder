---
name: heuristics
description: Design and safety invariants for the cwd-confinement permission heuristic in src/modules/sandbox.
category: architecture
---

# Cwd-confinement heuristic

The sandbox permission flow is implemented in `src/modules/sandbox/resolve.ts` and used by `src/tools/bash/index.ts`. Direct read/write path checks are also implemented in `src/modules/sandbox/heuristics.ts` and used by `src/tools/file-permissions.ts`; path checks classify read access as `SAFE_READONLY`, write access as `SAFE_EDIT`, and rejected access as `UNSAFE`.

## Resolution order

- `resolvePermissionDetails()` first checks the whole parsed line against explicit patterns; a whole-line match wins.
- Otherwise it resolves each chain segment independently: explicit segment pattern, then cwd-confinement heuristic only when the segment would otherwise be `ask`.
- A non-`ask` `**` default is authoritative: heuristics do not relax `deny` or downgrade `allow`.
- `deny` dominates; unresolved segments force `ask`; policy permissions combine most-restrictively; heuristic-only chains resolve to the configured heuristic permission (normally `allow:sandbox`). The heuristic classifiers return `Heuristic.SAFE_READONLY`, `Heuristic.SAFE_EDIT`, or `Heuristic.UNSAFE`; the resolver only treats the two SAFE variants as grants and maps them to the configured execution permission. `getCwdConfinementAssessment()`, `getArgsConfinementAssessment()`, and `getPathConfinementAssessment()` additionally return structured `UnsafeReason` codes and deduplicated semantic `CommandTag`s for future scout/review agents. Tags are emitted only by successfully classified command specs and let runtime policy apply contextual safeguards without reparsing shell text; `CommandTag.GIT_STATUS` currently drives the child fsmonitor check.
- Chain operators remain parser arguments and must be present in whole-command patterns.

## Command registry

`src/modules/sandbox/commands/` contains curated `CommandSpec` data. Unknown or unclassifiable arguments are treated as paths and must resolve inside the cwd. Only explicitly modeled value slots and safe pattern slots bypass path checking. Commands that can execute code are excluded from the whitelist; unsafe flags and traversal modes are marked ineligible. Commands with semantics hidden in arguments may use `CommandSpec.validate` (including subcommand specs, which receive args starting at the subcommand); `sed` is limited to lexically audited print/substitute scripts, rejects script files, execution/read/write commands, and in-place mode. Normal whole-repository `git diff` remains a prompt, while `git diff --check`, `git diff --stat`, `git diff --name-only`, `git diff --name-status` (including revision ranges), explicit `git diff -- <confined-path>`, and quiet diff modes are allowlisted. `git log` and `git show`, including historical patch content, are ordinary read-only project access under the trusted-local-environment policy; `git show --output` remains ineligible because it writes a file. Stream-only text filters include `fold`, `fmt`, `expand`, `unexpand`, `nl`, `tac`, and `rev`.

Important exclusions include normal `git diff`, `cat-file` (output-channel risk), credential-printing/network/mutating git subcommands, shell wrappers, interpreters, and exec-capable flags. Safe output flags use `OUTPUT_PATH_VALUE` and classify successful invocations as `SAFE_EDIT`. Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted.

## Path and environment safety

- Path arguments are checked lexically and, when enabled, through canonical realpaths.
- Outside paths containing symlink components are classified as `SYMLINK_ESCAPE` before file-access approval, so child hooks cannot turn a one-shot outside approval into a symlink escape. `resolveSymlinks: false` retains the lexical outside-path behavior.
- Nonexistent write targets use their nearest existing ancestor; dangling symlinks are rejected.
- Symlink-following traversal flags are unsafe; symlinks inside a directory argument are not recursively walked.
- Sensitive path segments include `.env*`, `.git`, credential directories/files, private-key extensions, `*.tfvars`, and `credentials`; `denyPaths` extends the list and `blockDotfiles` enables paranoid mode. Direct read/write paths use the same sensitive and symlink checks; explicit session folder approvals remain scoped to the selected operation and are restored from `pi-file-sandbox:allowed-file-folder` custom session entries.
- Subshells, process substitutions, and redirection targets recurse through confinement checks. Process-substitution capability propagates nested `SAFE_EDIT`; command substitutions in data slots may recurse safely, while path-slot command substitutions require a statically modeled `pwd`/single-literal `echo`/`printf` output whose produced path still passes confinement.
- The heuristic tracks modeled shell directory state per command line: `cd`, `pushd <path>`, `popd`, and `cd -` update the current directory, previous directory, and stack. The original cwd remains the confinement root; dynamic/unsupported directory forms and outside destinations fall back, while later modeled `cd` operations may recover state. Directory changes in pipelines/background segments do not persist to subsequent commands.
- Dangerous leading assignments (`LD_*`, `GIT_*`, `PATH`, `IFS`, `BASH_ENV`, `RIPGREP_CONFIG_PATH`, `LESSOPEN`, etc.) are rejected. Inherited environment remains an accepted risk unless `sandbox.inheritEnv` enables the clearenv allowlist.

Configuration is `heuristics.cwdConfinement` in `src/common/config.ts`: `enabled`, `permission`, `commands`, `denyPaths`, `blockDotfiles`, and `resolveSymlinks`. Cwd-confinement tests pass config explicitly and use real temporary directories for symlink cases.

Permission suggestion rules in `src/modules/sandbox/suggestions.ts` preserve wildcard semantics: a trailing `*` consumes one or more arguments, so suggestions for argument-less invocations save an exact rule and only append `*` when extra arguments are present.

Tests: `test/modules/sandbox/heuristics.test.ts`, `resolve.test.ts`, and seeded `fuzz.test.ts`. The curation audit command from the standalone sandbox repository is intentionally not part of pi-coder.
