---
name: heuristics
description: Design and safety invariants for the cwd-confinement permission heuristic in src/modules/sandbox.
category: architecture
---

# Cwd-confinement heuristic

The sandbox permission flow is implemented in `src/modules/sandbox/resolve.ts` and used by `src/tools/bash/index.ts`.

## Resolution order

- `resolvePermissionDetails()` first checks the whole parsed line against explicit patterns; a whole-line match wins.
- Otherwise it resolves each chain segment independently: explicit segment pattern, then cwd-confinement heuristic only when the segment would otherwise be `ask`.
- A non-`ask` `**` default is authoritative: heuristics do not relax `deny` or downgrade `allow`.
- `deny` dominates; unresolved segments force `ask`; policy permissions combine most-restrictively; heuristic-only chains resolve to the configured heuristic permission (normally `allow:sandbox`).
- Chain operators remain parser arguments and must be present in whole-command patterns.

## Command registry

`src/modules/sandbox/commands/` contains curated `CommandSpec` data. Unknown or unclassifiable arguments are treated as paths and must resolve inside the cwd. Only explicitly modeled value slots and safe pattern slots bypass path checking. Commands that can execute code are excluded from the whitelist; unsafe flags and traversal modes are marked ineligible.

Important exclusions include `git diff`/`show`/`cat-file` (output-channel risk), credential-printing/network/mutating git subcommands, shell wrappers, interpreters, and exec-capable flags. Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted.

## Path and environment safety

- Path arguments are checked lexically and, when enabled, through canonical realpaths.
- Nonexistent write targets use their nearest existing ancestor; dangling symlinks are rejected.
- Symlink-following traversal flags are unsafe; symlinks inside a directory argument are not recursively walked.
- Sensitive path segments include `.env*`, `.git`, credential directories/files, private-key extensions, `*.tfvars`, and `credentials`; `denyPaths` extends the list and `blockDotfiles` enables paranoid mode.
- Subshells, process substitutions, and redirection targets recurse through confinement checks.
- Dangerous leading assignments (`LD_*`, `GIT_*`, `PATH`, `IFS`, `BASH_ENV`, `RIPGREP_CONFIG_PATH`, `LESSOPEN`, etc.) are rejected. Inherited environment remains an accepted risk unless `sandbox.inheritEnv` enables the clearenv allowlist.

Configuration is `heuristics.cwdConfinement` in `src/common/config.ts`: `enabled`, `permission`, `commands`, `denyPaths`, `blockDotfiles`, and `resolveSymlinks`. Cwd-confinement tests pass config explicitly and use real temporary directories for symlink cases.

Tests: `test/modules/sandbox/heuristics.test.ts`, `resolve.test.ts`, and seeded `fuzz.test.ts`. The curation audit command from the standalone sandbox repository is intentionally not part of pi-coder.
