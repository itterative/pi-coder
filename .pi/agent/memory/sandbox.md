---
name: sandbox
description: Index for the cwd-confinement bash permission model in src/modules/sandbox — resolution order, config, core invariants, and detail docs.
category: architecture
priority: 6
keep_updated: true
---

# Bash sandbox and cwd confinement

The model here is **cwd confinement**: a Bash command may be granted without a prompt only when every filesystem
operand it can reach stays inside the cwd (plus configured roots and the runtime scratchpad) and the command cannot
execute code or escape through a flag. Code lives in `src/modules/sandbox/` — `resolve.ts` (the flow), `bash.ts`
(the AST), `heuristics/` (the checks), `commands/` (the curated specs), `suggestions.ts`, `command-wrappers.ts`,
`file-roots.ts`, `probe.ts`, `decision-log.ts`, `bubblewrap.ts` — and is driven by `src/tools/bash/index.ts`; direct
read/write path checks reuse the same heuristics through `src/tools/file-permissions.ts`. Configuration is
project-local `.pi/bash-sandbox-config.json` or global `~/.pi/bash-sandbox-config.json` (overridable with
`SANDBOX_CONFIG_PATH` / `SANDBOX_CONFIG_PATH_GLOBAL`; `/bash-sandbox-config` shows what loaded).

**Resolution order, in brief:** a whole-line rule match wins; otherwise each chain segment resolves on its own —
explicit segment rule first, then the cwd-confinement heuristic, and only for a segment that would otherwise `ask`.

**Invariants most often broken:**

- A non-`ask` `**` default is authoritative: heuristics do not relax `deny` or downgrade `allow`; `deny` dominates
  and unresolved segments force `ask` (`sandbox/confinement.md`).
- One unwrap transform serves classifier, matcher, and logging (`unwrapWrapperCommand()`); never re-derive a wrapped
  view from a raw token list in a new consumer, and never offer a `timeout *` rule (`sandbox/commands.md`).
- A declared root is not a sensitive-name exemption, and mounts widen reads, never writes. The scratchpad and user
  memory bypass of name filtering is explicit policy, not the "unset means exempt" default (`sandbox/confinement.md`).
- Shell expansion is gated **per slot**, never per command, and only for unquoted words: checking a set smaller
  than the shell's is the one unsound direction (`sandbox/path-safety.md`).
- `tryLoad()` whitelists every `heuristics.cwdConfinement` field — a new key missing there and in the merge
  function is silently dropped (`sandbox/confinement.md`).
- Session rules are runtime state only: never written to config, never shown by `/bash-sandbox-config`, merged
  after config rules so they win on identical patterns (`sandbox/session-rules.md`).

**Posture, not backend.** `src/modules/sandbox/posture.ts` turns one mount plan into one `SandboxPosture`
(`role`, `enforcement`, `network` = `{mode, publish}`, `devices` = `{paths, keepGroups}`, `entries`,
`writableRoots`, `readOnlyRoots`, `warnings`), because the two backends bind the same checkout at the same
path: a rule keyed on the backend's *name* would grant under the container what it asks under bubblewrap.
`writableRoots` is derived from the entries, never declared. Both backends resolve configurable mounts through
`resolveConfiguredMounts` — `~` expanded, relative and missing paths dropped with a warning instead of becoming
a podman-created empty directory, duplicates collapsed to the most permissive mode, parents ordered before
children. Config surface (`sandbox.mounts` long form with `target`/`create`, `sandbox.network` with ports,
`sandbox.devices`, and the removal of `homeMounts`) is in `sandbox/configuration.md`. The container's `$HOME`
is one shared directory at the real home path (`.state/container/home`), so package caches survive a session;
`sandbox.mounts` is what puts specific host parts back. Both backends also mount the runtime
**resource roots** read-only — this extension and the pi package, pi's managed package stores, user-level skill
directories, and the exact package roots pi resolved — from `src/modules/sandbox/resource-roots.ts`, so a skill
advertised by the prompt can be read and its scripts run inside the sandbox. A
child below the `command` rung is `readonly`: checkout, worktree git data, and memory mounted read-only, no
network (`--network=none` / `--unshare-net`), and no devices. Details in `sandbox/session-sandbox.md`.

**`safe-bash` is** the curated read-only command set judged by this same heuristic (`Heuristic.SAFE_READONLY`, with
`safeBashCommands` extending it conservatively); it is **not** a security sandbox, and `probe.ts` is a sensor that
reports what a command would change — it decides nothing.

**Session sandbox (container backend, selected by `sandbox.backend`; `auto` prompts once for a missing image).** Posture is **Shape A**: a
rootless container per session with the real checkout bind-mounted at its real absolute path, so `bash` and
pi's file tools share one filesystem view with no change-transfer contract. The file tools were rebuilt over
the container's `fs` protocol rather than left host-side: the checkout is shared, but `$HOME`, `/tmp`, and the
OS rootfs are deliberately shadowed, so a host-side `read` or `write` there would describe a place no command
can see. Child runtimes load the same backend as a hidden extension and run their own container, so a child's
bash *and* its file tools share one view there too (see `sandbox/session-sandbox.md`). Measured on
this machine, one-shot `podman exec` costs +125 ms per command over `bwrap`, so the backend rides one
long-lived attached `podman run -i` whose main process is a JSON-RPC dispatcher (~2 ms per command, versus
24.8 ms for a full-profile `bwrap` call). The session's image is a **`Containerfile` recipe**
(`.pi/Containerfile`, global fallback) that a host-side `podman build` turns into
`pi-coder-sandbox:<hash>` — a generated prologue copies `node` into the user's base, so a recipe need not
be `FROM node:*`. The container runs as the host user (`--userns=keep-id`) with a mounted `$HOME`, since
provisioning is a build rather than `apt-get` inside. Landmines and measured numbers are in
`sandbox/session-sandbox.md`: keep-id makes `apt-get` inside fail, SELinux needs `label=disable`, rootless
podman cannot start inside `bwrap` (it corrupts the pause process until `podman system migrate`), and
`podman` is unreachable inside the container by design. The profile remains a path view, not a security boundary for the *bwrap* mode (no `--unshare-*`,
shared net/pid); in container mode the boundary is the mount set plus the approval gates.

## Targeted references

Load only the detail needed for the task:

- `sandbox/confinement.md` — permission flow, file-access roots, resolution order, module layout, config keys.
- `sandbox/configuration.md` — `sandbox.mounts`/`network`/`devices` schema, resolver rules, warnings, `/sandbox` editing.
- `sandbox/commands.md` — the `CommandSpec` registry and transparent wrapper unwrapping.
- `sandbox/path-safety.md` — path, symlink, sensitive-name, shell-expansion, directory-state, and environment rules.
- `sandbox/session-rules.md` — how a rule is proposed, built, stored, matched, and shown in the prompt.
- `sandbox/probe.md` — the overlay copy-on-write probe, its invariants, limits, and concluded classifier findings.
- `sandbox/decision-log.md` — the JSONL decision log: recorded fields, location, rotation, and mining.
- `sandbox/session-sandbox.md` — session container: Shape A, the dispatcher, the image recipe and its prologue, the mount/posture plan and read-only roles, measured costs, and the podman/bwrap landmines.

These nested documents are on-demand references and are intentionally not included in the memory list
automatically. Keep this index and the detail files concise; update them when behavior or ownership changes.
