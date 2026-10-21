---
name: commands
description: Curated CommandSpec registry in src/modules/sandbox/commands/ and transparent wrapper unwrapping for timeout and the time keyword.
category: architecture
---

# Command registry and transparent wrappers

## Command registry

`src/modules/sandbox/commands/` contains curated `CommandSpec` data. Unknown or unclassifiable arguments are treated as paths and must resolve inside the cwd. Only explicitly modeled value slots and safe pattern slots bypass path checking. Commands that can execute code are excluded from the whitelist; unsafe flags and traversal modes are marked ineligible. Commands with semantics hidden in arguments may use `CommandSpec.validate` (including subcommand specs, which receive args starting at the subcommand); `sed` is limited to lexically audited print/substitute scripts, rejects script files, execution/read/write commands, and in-place mode. `git diff` is allowlisted for read-only patch, built-in short help (`-h`), checking, stat-summary metadata (including `--numstat`, `--shortstat`, `--summary`, `--compact-summary`, and `--dirstat` forms), quiet, and explicit confined-path output; external-program and output-file options remain ineligible. Long help (`--help`) remains ineligible because Git invokes an external man/help viewer. `git log` and `git show`, including historical patch content, are ordinary read-only project access under the trusted-local-environment policy; `git show --output` remains ineligible because it writes a file. Stream-only text filters include `fold`, `fmt`, `expand`, `unexpand`, `nl`, `tac`, and `rev`.

Important exclusions include unsafe `git diff` modes, `cat-file` (output-channel risk), credential-printing/network/mutating git subcommands, shell wrappers, interpreters, and exec-capable flags. Safe output flags use `OUTPUT_PATH_VALUE` and classify successful invocations as `SAFE_EDIT`. The shell builtin `command` is allowlisted only for `-v`/`-V` lookup modes (optionally with `-p`); ordinary forms that execute an operand remain ineligible. Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted.

The curation audit command from the standalone sandbox repository is intentionally not part of pi-coder. Resolver and heuristic tests are listed in `confinement.md`.

## Transparent command wrappers

`src/modules/sandbox/command-wrappers.ts` (a leaf importing only `./bash`) models prefixes that run another command and add no capability of their own, so `timeout 600 npm run test:run` is judged as `npm run test:run`. `timeout` and the shell keyword `time [-p]` are modeled (`time` takes only `-p`; `/usr/bin/time` is a different command name, and any other token after `time` is the command word). Recognition is all-or-nothing per prefix grammar and refuses: unmodeled options (`-c/--chdir` moves the confinement cwd, `--profile` writes a file, `--group`, combined short flags, `--`), non-static durations (`$T`, `$(…)`), a wrapper with no command, a wrapped directory builtin (`cd`/`pushd`/`popd` would advance modeled state that never moved), `nohup` (writes `nohup.out`), and any segment with leading environment assignments. Refusal is never a safety loss: the segment keeps the old conservative behavior of an unknown command.

One transform serves every consumer, and that is the invariant to preserve: `unwrapWrapperCommand()` (bounded nested unwrap; preserves word order and all redirections and shares the original word nodes, so substitution and quoting provenance survives) is used by the classifier (`heuristics/evaluator.ts` `transparentSubject`), by `permissions.ts` `getBashCommandPermissionMatch()` (which re-tokenizes the unwrapped node), and by `resolve.ts` `decisionTokens()`, which produces the token view recorded for _every_ segment as well as the suggestion input for uncovered ones. `unwrapWrapperTokens()` exists only for the string-argument classification entrypoint. Do not re-derive a wrapped view from a raw token list in a new consumer: nesting, word order, and the assignment rule then drift apart, which is exactly what the first review of this design found.

Decided semantics, each pinned by a test in `test/modules/sandbox/command-wrappers.test.ts`:

- `heuristics.cwdConfinement.commands` gates the **innermost** command, so a curated allowlist needs no `timeout` entry and an entry naming the wrapper is inert. A grant can never exceed the inner command's own authorized capability.
- `safeBashCommands` patterns also see the wrapped command, so an inner-naming pattern now covers wrapped forms while a custom pattern that _names_ the wrapper (`timeout 5 mytool`) no longer matches. That compat change is intentional.
- Policy matching tests the literal segment **and** the wrapped view in one ordered pass, so pattern order and last-match-wins are unchanged and a rule naming the wrapper (for example `timeout *: deny`) still covers a chained segment; matching only the wrapped view would let `&&` bypass wrapper-naming rules.
- Known limit: a redirection written _inside_ the wrapper prefix (`timeout > out 900 ls`) is confined correctly, but the wrapped token view starts with that redirection, so an inner-name rule may not match that spelling and it prompts again.

Environment assignments are excluded on purpose: keeping them would make the suggested rule differ from the token list rules are matched against, and dropping them would let a rule for `npm test` authorize `FOO=evil npm test`.
