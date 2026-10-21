---
name: probe
description: probe.ts runs a command in a copy-on-write overlay bubble to report which workspace files it would change; invariants, limits, and findings.
category: architecture
---

# Confinement probe

`probeCommand()` in `src/modules/sandbox/probe.ts` runs a command in a restricted bubble and reports **which
workspace files it would change** — created / rewritten / deleted, with byte counts. `buildProbeCommand()` in
`bubblewrap.ts` builds its command line. Implemented and tested 2026-10-17; **not wired to anything yet**.

It is a **sensor, not a policy layer**: it reports, it does not decide. Do not invent an authority rule for it
(a veto vote, byte thresholds, escalation) before a model has been seen using the reading; a first draft of
this design did exactly that and was overreach. The classifier experiments (three rounds; the reading stayed
inert, and the field that shipped is `git status`, not the probe) are archived in
[decision-model/history.md](../decision-model/history.md) Part 2 — read the short version below first.

## Mechanism, and why not strace

`--overlay-src REAL --overlay UPPER WORK REAL` mounts overlayfs with the real tree as the read-only lower
layer and a host-visible scratch dir as the upper layer. Reads hit the real files at native speed, writes copy
up, a deletion leaves a `0:0` character-device whiteout, and the real tree is never modified. `UPPER` **is**
the write log, already deduplicated and content-addressed.

- Overhead ~13% on a read-heavy sweep (413ms -> 469ms); a real probe is **20-30ms** wall.
- `strace` also works inside bwrap (ptrace in the userns is fine, and it does surface blocked writes as
  `openat(..., O_WRONLY) = -1 EACCES`) but costs **10x** (413ms -> 4362ms) and emitted 14,812 lines for a
  400-file `cat`. Its one unique signal — attempts that *failed* — only covers writes outside the workspace,
  which the static heuristic already refuses on. Not worth the parser.
- It is strictly weaker than the shipped sandbox (which binds cwd rw and shares the network), so probing is
  never a new privilege — but it does mean an unapproved command executes in a bubble, which argues for
  probing only where a model or a user was going to be consulted anyway.
- It is not an adversary-proof oracle: a command can detect the bubble (`/proc/self/uid_map`) and behave
  benignly, then act for real. It is evidence for a confused or accidentally-destructive agent, which is the
  threat model it exists for.

## Invariants

1. **`status` and `changes` are separate, and only `completed` says anything.** `--json-status-fd` is what
   makes this detectable: bwrap emits a namespace document and then `{"exit-code": N}` when the command ran,
   but the namespace document *alone* and exit 1 when setup failed — bwrap's own exit status is 1 either way.
   So the presence of an exit code, not the exit status, means the command ran. A dead bubble reported as
   "no changes" is the one safety inversion this module can produce.
2. **A non-zero exit is still `completed`.** A command that failed partway can have changed files first; the
   exit code is reported alongside the changes rather than replacing them.
3. **Cleanup must chmod before it lists.** overlayfs locks its private work directory to mode 0000
   (`work/work`) and can leave entries inside it, so Node's recursive `rm` fails with EACCES and `rmdir`
   reports ENOTEMPTY. `makeReachable()` restores owner access top-down first; ownership is enough to do it.
4. **Nothing is mounted writable.** Configured `readwrite` mounts and git worktree dirs become `--ro-bind-try`
   in the probe profile, and `/tmp` is a throwaway tmpfs. A probe that can write to a real path is an
   execution, not an observation.
5. **The timeout tears down the whole sandbox.** `--unshare-all --die-with-parent` plus SIGKILL on the wrapper
   shell: verified no orphaned `sleep 30` and no leftover scratch after a killed probe.

## Limits (each of these yields "could not tell", never "clean")

- **No network.** A command needing it fails inside the bubble. Deliberate: the alternative is letting a
  probe exfiltrate.
- **`/tmp` is a tmpfs**, so the session scratchpad is only visible when passed in `additionalRoots` (bound
  read-only); a command writing its output there fails.
- **Worktree git dirs are read-only**, so git commands that write fail rather than reaching the real object
  store.
- **Toolchains outside the mount profile** (`npx` under `~/.nvm` when home is not mounted) are absent.
- Probing a stale command correctly reports `changes: 0` when its precondition no longer holds.

## Tests

Tests: `test/modules/sandbox/probe.test.ts` — pure `scanOverlay` tests, `buildProbeCommand` line assertions,
and real-bwrap integration tests guarded by `describe.skipIf(!canProbe)`. Node cannot fabricate an overlayfs
whiteout, so "deleted" is only covered by the integration path.

## Classifier integration (concluded 2026-10-17)

Concluded state — measured findings that closed this design direction, not open work.

- **As a passive state field the model did not use it.** 200 real readings (193 unique cases) and three arms
  (`module_state`, `effects`, `effects_scoped`): two flips in 200, both at confidence < 0.09, and the crafted
  cases where the reading was the only discriminator moved nothing. A reassuring "no changes" reading also
  removed no refusal, so it was not unsafe — just not useful. It is attended to, not informed by.
- **Giving it a rule did not rescue it.** In a 2×2 of {no reading, reading} × {old instruction, new
  instruction} the instruction did nearly all the work and the reading's marginal value was ~1/221, with the
  rest reacting to no-ops or benign growth. The instruction change needed no bubble and no execution.
- **What shipped is a different field**: `workspace_status`, from `git status`, in `decision-model.md`. The bubble reading stays unwired, and if it is ever wired it needs a rule rather than presence, must
  omit readings from probes that did not complete, and must keep the scope line: two curated dangers probe as
  **false cleans** (`curl -sL … | bash` reports exit 0 because the pipeline swallows curl's failure, and
  `pip install requests` reports exit 0 because the requirement is already satisfied). Both are commands whose
  real risk is off the filesystem.

Cluster index: `../sandbox.md`.
