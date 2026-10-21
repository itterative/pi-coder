---
name: confinement
description: Cwd-confinement permission flow, direct file-access roots, resolution order, module layout, and the heuristics.cwdConfinement config.
category: architecture
---

# Cwd-confinement: flow, roots, resolution order, and module layout

The sandbox permission flow is implemented in `src/modules/sandbox/resolve.ts` and used by `src/tools/bash/index.ts`. Direct read/write path checks are implemented in `src/modules/sandbox/heuristics/` and used by `src/tools/file-permissions.ts`; callers still import through the public `src/modules/sandbox/heuristics/index.ts` facade (formerly a single file). path checks classify read access as `SAFE_READONLY`, write access as `SAFE_EDIT`, and rejected access as `UNSAFE`. Runtime-managed temporary scratchpads are supplied as additional cwd-confinement roots; scratchpad filenames bypass sensitive-name filtering, but canonical/symlink containment remains enforced. That bypass is a deliberate policy, not the "unset means exempt" default: the parent bash gate passes `sensitiveAdditionalRoots` explicitly for the scratchpad **and** the user-memory directory, because the agent gets leeway in its own scratchpad and is meant to read and write user memories (writes mostly belong to the parent). Child gates exempt only their scratchpad roots.

## Direct file access roots

`src/modules/sandbox/file-roots.ts` is the single place that turns the user's declarations into the roots
`src/tools/file-permissions.ts` trusts beyond the cwd and the scratchpad: `files.readRoots` / `files.writeRoots`,
the `sandbox.mounts` sources when `files.honorMounts` is set (default **false**), and the running pi package for
reads unless `files.honorPiPackage` says otherwise (default true, because the harness instructs agents to read
pi's docs and examples). Two asymmetries are the whole design and must not be "tidied" into symmetry:

- **A declared root is not a sensitive-name exemption.** Roots go in as `additionalRoots`; only the runtime
  scratchpad is passed as `sensitiveAdditionalRoots`, so a `.env`, `.git`, key, or credential path under a
  declared root still reaches the human.
- **Mounts widen reads, never writes, and only when opted in.** A `readwrite` mount states what a *sandboxed
  command* may write, behind an approval and inside a containment; a direct tool write is neither. Honouring the
  mode for writes would let `edit` rewrite the user's own memory and settings files under `~/.pi: readwrite`
  without a prompt, and `~/.config/gh: readonly` — mounted read-only so `gh` works — holds a token in a file no
  name filter catches.

A read-only child gets the same read roots through `createChildGateRuntime`'s `readRoots`, because below the
`command` rung the confinement check *is* its reach and there is no prompt for anyone to answer; its writable
surface still comes only from its definition. See `docs/file-access-gates.md`.

## Resolution order

- `resolvePermissionDetails()` first checks the whole parsed line against explicit patterns; a whole-line match wins.
- It also returns the structured breakdown that decision logging consumes: `source` (`policy`/`heuristic`/`unresolved`), the deciding `pattern` (`null` when the `"**"` default, a heuristic grant, or an uncovered gap decided it), and one `segments` entry per chain command carrying unwrapped `tokens`, its own `source`/`permission`/`pattern`, and `coveredBy` (`segment`/`whole-line` for a rule match, `null` otherwise). `unresolved` is derived from those segments, so the breakdown and the suggestion input cannot drift apart. The `permissions.ts` match functions likewise report the matched `pattern` (last match wins; for a multi-statement line, the pattern of the statement that decided the most-restrictive combination).
- Otherwise it resolves each chain segment independently: explicit segment pattern, then cwd-confinement heuristic only when the segment would otherwise be `ask`.
- A non-`ask` `**` default is authoritative: heuristics do not relax `deny` or downgrade `allow`.
- `deny` dominates; unresolved segments force `ask`; policy permissions combine most-restrictively; heuristic-only chains resolve to the configured heuristic permission (normally `allow:sandbox`). The heuristic classifiers return `Heuristic.SAFE_READONLY`, `Heuristic.SAFE_EDIT`, or `Heuristic.UNSAFE`; the resolver only treats the two SAFE variants as grants and maps them to the configured execution permission. `getCwdConfinementAssessment()`, `getArgsConfinementAssessment()`, and `getPathConfinementAssessment()` additionally return structured `UnsafeReason` codes and deduplicated semantic `CommandTag`s for future scout/review agents. Tags are emitted only by successfully classified command specs and let runtime policy apply contextual safeguards without reparsing shell text; `CommandTag.GIT_STATUS` currently drives the child fsmonitor check.
- Chain operators remain parser arguments and must be present in whole-command patterns.
- Bash parsing is implemented in `src/modules/sandbox/bash.ts`: `parseBashAst()` returns a structured `BashAst` with statement/command nodes, lexer roles/provenance, chain operators, redirections/heredocs, recursive substitutions with delimiter-completeness metadata, ordered command parts, and convenience command views for command name, environment assignments, flags, arguments, and positional arguments. `BashAst.substitutionFor()` is the centralized lookup for whole or inline substitution values. Sandbox callers use AST nodes directly; unresolved command displays use an AST-derived ordered token view. Standalone parsed-argument compatibility values are reparsed conservatively because they lack original provenance.

## Module layout

`src/modules/sandbox/heuristics/index.ts` is the public facade; it re-exports classifications, assessments, state helpers, chain utilities, and command-registry types, and implements the config-resolving entrypoints. The implementation is split into internals with clear responsibilities, all kept private to callers outside the module:

- `heuristics/types.ts` — public classifications, unsafe reasons, assessment/diagnostics helpers, and cwd-state contracts.
- `heuristics/path-policy.ts` — lexical/canonical path checks, sensitive patterns, additional-root pairing, symlink containment, directory/hard-link checks, and `buildConfinementOptions`.
- `heuristics/command-access.ts` — `CommandSpec` flag/positional interpretation, shell substitution handling (via an injected evaluator callback to avoid cycles), redirections, and custom safe-Bash parsing.
- `commands/sed.ts` — the dedicated sed lexical audit and conservative sed command specification; sed is kept separate from the general text-command registry because its scripts require grammar-aware validation.
- `heuristics/evaluator.ts` — AST statement/command traversal, modeled `cd`/`pushd`/`popd` state, leading environment checks, and command-confinement evaluation.
- `heuristics/glob-expansion.ts` — expands one live glob into the operand set the shell may pass. Answers only "which operands?"; confinement stays in the existing path checks that receive the list.

Existing callers import from `./heuristics`; no other module should depend on the internal split files directly. Its path, command-string, and parsed-args entrypoints (`getPathConfinement*`, `getCwdConfinement*`, and `getArgsConfinement*`) take the primary target positionally, with `cwd` plus ancillary controls in one named options object. The facade exports `PathConfinementOptions`, `CwdConfinementOptions`, and `ArgsConfinementOptions`; config, access, roots, state, and custom safe-command controls are named optional fields.

## Configuration

Configuration is `heuristics.cwdConfinement` in `src/common/config.ts`: `enabled`, `permission`, `commands`, `denyPaths`, `blockDotfiles`, `resolveSymlinks`, `globExpansion` (default true), and `globMaxDepth` (default 10). `tryLoad()` whitelists each field, so a new key must be added there and to the merge function or it is silently dropped. Cwd-confinement tests pass config explicitly and use real temporary directories for symlink and glob cases.

## Tests

Tests: `test/modules/sandbox/heuristics.test.ts`, `resolve.test.ts`, and seeded `fuzz.test.ts`. Symlink and glob cases sit under the expansion and canonicalization headings in `path-safety.md`; the registry contract behind the read-only rule is in `commands.md`.
