---
name: path-safety
description: Path, symlink, sensitive-name, shell-expansion, modeled directory state, and environment invariants of the cwd-confinement checks.
category: architecture
---

# Path and environment safety

The config keys named below (`resolveSymlinks`, `denyPaths`, `blockDotfiles`, `globExpansion`, `globMaxDepth`) belong to the `heuristics.cwdConfinement` block documented in `confinement.md`.

## Path checks and symlink escapes

- **Two-stage path checking.** Path arguments are checked lexically and, when enabled, through canonical realpaths.
- **Approval cannot become a symlink escape.** Outside paths containing symlink components are classified as `SYMLINK_ESCAPE` before file-access approval, so child hooks cannot turn a one-shot outside approval into a symlink escape. `resolveSymlinks: false` retains the lexical outside-path behavior.
- **No symlink-following traversal.** Symlink-following traversal flags are unsafe; symlinks inside a directory argument are not recursively walked.

## Canonicalization and scratch-local mutators

- **Kernel-order canonicalization.** Canonicalization walks components in kernel order, resolving symlinks before a following `..`. Nonexistent trailing write targets are allowed, dangling symlinks and additional-root inputs containing explicit `.`/`..` components are rejected, and the most-specific lexical additional root is paired with its own canonical root. Scratchpad-local `rm`, `mkdir`, `rmdir`, `touch`, `truncate`, `tee`, constrained `cp`/`mv`/`chmod`, and audited `sed -i` may return `SAFE_EDIT`; unknown/dynamic forms fall back. `cp` permits one confined read source and one explicit scratch destination but rejects recursive copies and directory destinations; `mv` remains wholly scratch-local; chmod is nonrecursive; sed rejects abbreviations, backups, follow-symlinks, script files, and unsafe scripts. Existing hard-linked regular-file mutation targets are rejected.

## Sensitive paths and folder approvals

- **Sensitive segments and the user memory directory.** Sensitive path segments include `.env*`, `.git`, credential directories/files, private-key extensions, `*.tfvars`, and `credentials`; `denyPaths` extends the list and `blockDotfiles` enables paranoid mode. Direct read/write paths use the same sensitive and symlink checks; the parent read hook additionally permits the user memory directory (`~/.pi/agent/memory`) as a read root, while the parent write/edit hook does not. Parent Bash also receives that directory as a read-only additional root and mounts it read-only when sandboxed. Explicit session folder approvals remain scoped to the selected operation and are restored from `pi-file-sandbox:allowed-file-folder` custom session entries.

## Shell expansion in filesystem path slots

### Substitution and redirection recursion

- Subshells, process substitutions, and redirection targets recurse through confinement checks.
- Process-substitution capability propagates nested `SAFE_EDIT`; command substitutions in data slots may recurse safely, while path-slot command substitutions require a statically modeled `pwd`/single-literal `echo`/`printf` output whose produced path still passes confinement.

### The two permitted expansion exceptions

- Unmodeled shell expansion in filesystem path slots falls back, with two exceptions decided from `BashWordNode.expansions` (`tilde`/`glob`/`brace`/`variable`): an unquoted leading `~`/`~/…` is resolved against the home root and confined, and an unquoted live glob in a **read** slot is expanded to its operand set and every operand must pass the normal checks.
- Both require `!word.quoted`, because the flags say only whether a word has live expansion characters, not which characters were quoted, and a quoted bracket (`'[a]'*.ts`) translates *narrower* than the literal it stands for — checking a set smaller than the shell's is the one unsound direction.

### What keeps falling back

- `**`, class/extglob syntax (`[`, `]`, `(`, `)`), `..`, `.`, trailing `/`, `$name`, brace forms, mixed quoting, and any writing slot (including `>` redirection targets, which are marked as writes before their operand is inspected) keep falling back.
- Class and extglob syntax are refused rather than translated: POSIX classes and locale-collated ranges disagree with a JavaScript character class, `[z-a]` throws at compile time, and `!(*.env)` is live under `shopt -s extglob` or zsh's default `EXTENDED_GLOB` where it matches *more* than a literal reading — the narrower-than-the-shell direction.
- The supported alphabet is `*`, `?`, and escaped literals, which also keeps an invalid RegExp unrepresentable and a throw from escaping `resolvePermissionDetails` (both gates catch it, but the segment breakdown, dialog detail, and log record would be lost).

### Gating is per slot, never per command

- Expansion is gated **per slot**, never per command: `slotWrites` comes from `flagSpec.writes` for a flag value, `positionalsAreDestinations(spec)` for a positional, and the computed write-target for a redirection, so `sort -o out.txt src/*.ts` and `sort src/*.ts -o out.txt` both grant while a glob never reaches a destination slot in either order.
- `commands-registry.test.ts` pins the registry contract that keeps a future writer spec from slipping through (it is load-bearing; `positionalsAreDestinations()` itself is redundant with the additional-root blanket check for today's specs — see the OPEN note in that helper for the keep-versus-remove trade-off).
- `commands-registry.test.ts` pins the registry contract behind the read-only rule: every spec whose last positional is a destination must already reject dynamic operands, so an expanded operand set can never become one.
- `resolveSlotOperands()` is the single decision point shared by the AST extractor and the short-cluster handler; expansion never enters the token view used for rules, suggestions, and logging.
- `hasDynamicShellExpansion()` remains the conservative fallback only where no provenance exists (parsed-args entrypoints, custom safe-bash strings, permission-pattern parsing).

### Home directory, scratchpad-only mutators, and heredocs

- Every `~` expansion uses `resolveHomeDirectory()` (`$HOME` verbatim when non-blank, `os.homedir()` fallback) from `src/common/home-directory.ts`, including `bubblewrap.ts` and `src/tools/file-permissions.ts`, so classifier and sandbox read the same value; a configured `sandbox.env.HOME` is applied only when the sandbox is built and can still diverge, which is documented at the helper rather than assumed away.
- Scratchpad-only mutators reject expansion in consumed path and data values.
- Heredocs always fall back because the parser does not retain enough body/delimiter metadata to prove expansion safety.

## Modeled directory state

- **Per-line modeled directory state.** The heuristic tracks modeled shell directory state per command line: `cd`, `pushd <path>`, `popd`, and `cd -` update the current directory, previous directory, and stack. The original cwd remains the confinement root; dynamic/unsupported directory forms and outside destinations fall back, while later modeled `cd` operations may recover state. Directory changes in pipelines/background segments do not persist to subsequent commands.

## Environment

- **Leading environment assignments.** Dangerous leading assignments (`LD_*`, `GIT_*`, `PATH`, `IFS`, `BASH_ENV`, `RIPGREP_CONFIG_PATH`, `LESSOPEN`, etc.) are rejected. Inherited environment remains an accepted risk unless `sandbox.inheritEnv` enables the clearenv allowlist.

## Design history and open gaps

Design history and remaining gaps for path expansion live in `src/modules/sandbox/PLAN.md`; read it before touching `hasDynamicShellExpansion()` / `hasUnmodeledPathExpansion()` / `resolveSlotOperands()`. Still open there: mutator scope, `find -name`/`-path` pattern slots treated as paths, tilde-plus-glob words, and `cd ~/x` in the directory-state model.
