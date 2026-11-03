---
name: session-sandbox
description: Chosen session-level sandbox direction (rootless container, Shape A live checkout), measured costs, and the podman/bwrap landmines.
category: architecture
---

# Session sandbox: chosen direction, measurements, landmines

**Status:** direction and posture decided; the container backend is implemented and selected by
`sandbox.backend` (`auto` by default, which prompts once for a missing image — see *Selection* below).
`PI_SANDBOX_BACKEND` survives as an override for tests and CI. `docs/bash-execution-redesign.md` holds the
full argument, the decision table, and the measured numbers. Runnable probes live in `.pi/local/`
(gitignored) and must run **unsandboxed**: `probe-podman-sandbox.ts` for the maybes, and
`probe-container-backend.ts` for the implementation.

## The decision

- **Posture (decision 11): Shape A — live checkout.** The real checkout is bind-mounted at its real
  absolute path, so host `read`/`edit`/`grep` and in-container `bash` see the same bytes, `.git`
  worktree pointers (`gitdir`/`commondir`) stay valid, and no change-transfer contract is needed.
  "Protect the checkout" (a host-side `fuse-overlayfs` upper layer, Shape B) was considered and set
  aside: it is additive later, not a prerequisite.
- **Backend (decision 10): rootless container per session.** It is the only backend that serves the
  installable-toolchain goal and an egress boundary; a persistent `bwrap` cannot.
- **File tools stay host-side.** Do not route `read`/`write`/`edit`/`grep`/`find`/`ls` through the
  container: the extension only *gates* pi's built-ins (`src/tools/read/index.ts` is a hook), and
  reimplementing their semantics risks the core loop. It also breaks the per-child capability split:
  a container is one world per `exec`, so children would see the union of all mounted roots.
- **Per session, not per cwd.** Worker worktrees live under the state root (`<agent-dir>/pi-coder/workspaces/<slug>`,
  outside both the repo and the extension checkout), so a worker's container mounts that worktree as its own
  workspace; separate terminal sessions sharing one container would share `/tmp`, ports, and the process table.

## Measured (2026-10-28, rootless podman 5.8.7, SELinux Enforcing, `node:22-bookworm-slim`)

| What | Value |
| --- | --- |
| host `sh -c true` | 2.8 ms |
| full-profile `bwrap`, per command | 24.8 ms |
| `podman exec` one-shot | 148 ms (**+125 ms** over `bwrap`) |
| persistent `podman exec -i`, frame per command | 0.6 ms |
| container create + start, image local | ~135 ms |
| image pull, first ever session | 4.5 s |
| `apt-get install git` into the writable layer | 4.6 s |
| teardown `rm -f` | 10 s, or 240 ms with `-t 0` |

Consequence: a per-command container backend is a latency regression, so the session rides one attached
process instead. What that dispatcher has to be was settled later (see below): a Node program speaking
request-id multiplexing, not a framed `sh` loop — per-command `sh -c` removes the cwd-leak and
`exit`-kills-the-session problems, and multiplexing removes the pool.

## Landmines (all verified, all cost hours if rediscovered)

- **`--userns=keep-id` is now the mode, and it costs `apt-get`.** It runs the container as the host user,
  so nothing inside is privileged over the image — but it cannot write root-owned image directories, and
  `apt-get` fails with `EACCES` on `/var/lib/apt/lists`. That trade only became acceptable once the
  `Containerfile` recipe became the provisioning path: nothing installs inside a session anymore. Files
  arrive host-owned (`1241:1241`) either way, because rootless podman maps container-root onto the user;
  a plain `--user <uid>` is *not* equivalent (subuid mapping, unwritable mounts).
- **Keep-id needs a mounted `$HOME`.** The image's `/root` is unwritable for the container user, and the
  first `npm` cache or `git config --global` write fails, so the session mounts the shared
  `<state>/container/home` at the *real* home path and exports `HOME`, so `~` resolves the same
  inside and outside. `dispatch.mjs` layers per-request
  env over the container's own, so the value survives into every command.
  **Podman creates a missing mountpoint as container-root, and that is a bug, not a scaffold.** Every mount
  inside the home (the checkout at `~/Repos/…`, `~/.pi/agent/memory`, `~/.config/gh`, …) must exist before
  `podman run`: podman creates the missing destination inside the home *bind source*, as container-root — on
  the host a subuid (`589824` on one machine), mode `1755` (sticky, podman's shared-parent mode). The session
  then cannot write below `~/.config`, `~/.pi`, `~/Repos`, `~/.local` (verified: `touch ~/.config/x` →
  `EACCES`), and the host user cannot delete the state root without `sudo` (removing a child needs write on the
  subuid-owned parent). `container/home-mountpoints.ts` pre-creates every home-relative target as the host user
  at `0755` (ancestors included; parents only for a file source; a target another mount covers is skipped), so
  podman finds them and creates nothing. A home written by an older version keeps its root-owned scaffold; it
  must be removed once with `sudo rm -rf <state>/container/home` (it holds only the scaffold, the npm cache, and
  the seeded `.gitconfig`).
- **The sessions directory is mounted read-only, for every role.** `getUserSessionsDirectory()` mirrors pi's
  own resolver (`<agent dir>/sessions`, i.e. `~/.pi/agent/sessions`), passed through
  `runtimeRootsFor(role, { ..., sessionsDir })` as `extraReadOnlyRoots` — the one root a *write* role also gets
  read-only, because pi writes transcripts on the host and a runtime only reads one to review it (session
  review, `/stats`). Read-only rather than absent: it is not a credential the posture hides, it is the runtime's
  own data, and a scout that cannot read it cannot review a session. `.pi/agent/sessions` is deliberately not in
  `CREDENTIAL_PATHS`; `.pi/agent/auth.json` is, so mounting `~/.pi` still warns. `CREDENTIAL_PATHS` only feeds
  the warning for user-configured `sandbox.mounts`.
- **SELinux hosts need `--security-opt label=disable`** (or `:Z`, which relabels the user's checkout).
  Without one of them, reads inside the container fail with `Permission denied` despite matching uids.
- **Rootless podman cannot run inside the `bwrap` sandbox.** `newuidmap` fails with
  `write to uid_map failed: Operation not permitted`, and the attempt leaves a pause process that
  breaks *later host* `podman` until `podman system migrate` runs. So the backend must be invoked from
  the extension's own unsandboxed process, and a sandboxed bash call must never reach `podman`.
- **Teardown needs `-t 0`.** Without it, a container whose init ignores SIGTERM stalls `rm -f` for the
  full 10 s stop timeout, which shows up as a 10 s "recreate after widening".
- **The mount set is frozen at create.** `exec -w <unmounted path>` exits 127 loudly (podman does not
  silently create an empty world), but any widened root means recreate: stop + start ≈ 375 ms plus any
  install replay. Declare a superset up front (`$HOME` read-only at its real path covers most read
  roots).
- **Lifetime needs no watchdog, just a blocking reader.** Start the container *attached* with
  `podman run -i … sh -c 'cat >/dev/null'` and never write its stdin: pi's death (even SIGKILL) closes the
  write end, PID 1 gets EOF and exits, the pid namespace dies, and the orphaned podman client exits on its
  own. PID 1 exiting also reaps stray processes, so a `nohup`'d dev server survives across `exec` calls
  but not past pi. A bind-mounted FIFO is the detached-start equivalent. Set `--sig-proxy=false`; keep the
  fd process-global so an extension reload does not kill live sessions; let no other child inherit the
  write end; the agent can still kill PID 1, so the label + reap pass stays as a backstop.
- **Stop without `--rm` and resume — verified.** A stopped container keeps its writable layer and frozen
  mount set; `podman start -ai` re-attaches a fresh stdin pipe, so the lifetime trick survives the cycle
  (`Exited` → `Up` → EOF → `Exited`) with installed tools intact. Costs it moves elsewhere: crash-consistent
  state persists (`--tmpfs /tmp` for stale sockets/pids; `dpkg --configure -a` after a killed `apt-get`),
  profile drift is invisible (hash image digest + mounts + env into a label; mismatch forces recreate —
  same mechanism as widened mounts), stopped containers grow disk (label+age prune
  `podman container prune --filter label=pi.session --force`, never global), and `Running` on resume is
  ambiguous, so a session-keyed name makes it a checked assertion. Cross-session warmth needs a committed
  image (`podman commit` on graceful exit) or named volumes for `/usr/local` + caches, not a shared
  container (that would re-break per-session `/tmp`, pid, and port isolation).
- **NAT is the exfiltration path.** Default networking resolves DNS and reaches host services via
  `host.containers.internal`; the container's `127.0.0.1` is its own loopback. `--network=none` has no
  DNS, so the session default is a decision, not an inherited default.

## Implemented (first slice)

`src/modules/sandbox/container/` — `dispatch.mjs` (in-container PID 1, plain JS by necessity),
`client.ts` (session lifecycle), `operations.ts` (`BashOperations` adapter), `args.ts` (pure podman
argv), `protocol.ts`, `config.ts` (env switch + host guards), `index.ts` (wiring).

- **Seam (decision 15): pi's `BashOperations`**, via `createBashToolDefinition(cwd, { operations })` and
  `pi.on("user_bash") => { operations }`. No client shim: a session cannot be expressed as a rewritten
  command string, and a per-command socket client would pay a ~28 ms Node start. Registering `bash`
  works because extension tools land in the registry after the built-ins (pi's Gondolin precedent).
- **Permissions unchanged, execution moved.** The `tool_call` hook still resolves and records; when the
  backend is active it skips `sandbox(bwrap, …)` and `allow:sandbox` no longer requires the `bwrap`
  binary. All bash runs in the container whatever the verdict.
- **Protocol:** NDJSON JSON-RPC 2.0 over the session's stdin/stdout, base64 output, request-id
  multiplexing (no pool). Mirrors pi's `createLocalShellOperations` semantics, including the
  exit-then-drain-until-idle rule that keeps `cmd &` from hanging or truncating.
- **Flags that are not optional:** `--init` (reaps reparented background grandchildren), `--sig-proxy=false`,
  `--security-opt label=disable`, `--userns=keep-id`, `--tmpfs /tmp`, label
  `pi-coder.sandbox.session=<id>`.
- **Env is now a two-policy module** (`src/modules/sandbox/env.ts`): `resolveSandboxEnv` is the old
  bwrap ordering, unchanged; `resolveContainerEnv` drops host path/host-service keys (the image owns
  `PATH`/`HOME`), passes terminal/locale/`PI_*`, and excludes credential-shaped names unless
  `inheritEnv` names them explicitly. Provisional answer to decision 13.
- **Refuses to start inside `bwrap`** by checking `/proc/self/uid_map` for the full identity map before
  the first spawn, because a sandboxed podman corrupts the rootless pause process.
- **Measured end to end** (rootless podman, `node:22-bookworm-slim` warm): start ~175 ms, warm command
  **1.9–2.3 ms** vs 24.8 ms for full-profile `bwrap`, `cmd &` round trip ~104 ms (drain grace), cancel →
  exit 143/`cancelled` in 300 ms **with 0 surviving processes**, timeout honoured at 201 ms for 200 ms,
  stop 45 ms for an idle session (the 250 ms kill grace is only paid when commands were still running),
  PID 1 is `podman-init` with `zombies=0` after a backgrounded grandchild, same inode inside and out,
  `node` resolving to `/usr/local/bin/node` (the image's PATH).
- 67 unit tests run the real dispatcher and client over pipes (no podman, no image); container-level
  behaviour needs the probe script.
- **Image gotcha:** `node:22-bookworm-slim` has no `procps`, so in-container checks must read `/proc`
  (a `node -e` scan); `ps`/`pgrep` are absent and their failure looks like a product failure.
- **Bundling gotcha:** a bundler rewrites `import.meta.url`, and `scripts/scratch.ts` does exactly that,
  so the sibling `dispatch.mjs` lookup needs `ContainerSessionOptions.dispatcherPath`. Under pi's own
  loader (per-module, no bundling) the default resolves correctly.

### Live session, verified inside the container

`sandbox.backend: "container"` (then `PI_SANDBOX_BACKEND=container`), checked from a real `bash` tool call rather than the probe:

- `pid1=podman-init`, `uid_map` = `0 1241 1`, `containerenv` present; cwd is the real checkout and a file
  written inside is the same inode the host-side file tools read (bind mount, not a copy).
- **Resource roots are read-only mounts in both backends.** `src/modules/sandbox/resource-roots.ts` derives
  the files the prompt advertises: `PI_CODER_EXTENSION_DIR`, `getPiPackageDirectory()`, `<agentDir>/skills`,
  `<agentDir>/git`, `<agentDir>/npm`, `<agentDir>/tmp/extensions`, `~/.agents/skills`, plus the exact package
  roots `DefaultPackageManager.resolve()` reports, so a local package or an explicit skill path outside the
  managed stores is covered too. The container receives them through `runtimeRootsFor`'s `resourceRoots`; the
  bwrap profile receives the same list as `additionalRoots` + `readOnlyAdditionalRoots`. Without them a skill's
  `SKILL.md` and the scripts it names are advertised by the system prompt but invisible to a sandboxed command.
  The resolved set is pruned to roots not already inside a standard one, and it is memoized per
  cwd/agent-dir/trust because the bash hook, container start, and file gates all ask.
- The mount set is exactly: repo rw, `/run/pi/dispatch.mjs` ro, scratchpad rw mounted into the container's own
  `/tmp` tmpfs, and `~/.pi/agent/memory` ro (a write is refused with `Read-only file system`). The scratchpad
  moved out of `/tmp` because a tmpfs `/tmp` is wiped by a host or dev-environment restart while the transcript-backed
  `TODO.md` comes back, which silently lost every other scratchpad file; pi-coder now prunes the store by age and size itself.
  `~/.ssh`, `~/.gitconfig`, `/run/user/<uid>` are absent. `/home/sd/.pi` existing is *not* a leak: podman creates
  the parent directories of a bind-mounted path, so it is an empty scaffold — but until `home-mountpoints.ts`
  pre-created them they were owned by a subuid, which is the permission bug described under `$HOME` above.
- **`$HOME` is a host directory mounted at the real home path** (`<state>/container/home` →
  `/home/<user>`, `--env HOME=…`), because with keep-id the image's `/root` is not writable and the first
  `npm` cache or `git config --global` write would fail. Mounting it at the *real* path matters: an earlier
  `/home/pi` target made `~` expand differently inside than outside (a footer rendered
  `/home/sd/Repos/pi-coder` instead of `~/Repos/pi-coder`), which contradicts the whole Shape A premise that
  paths mean the same thing on both sides. The home volume is also pushed *before* the mounts nested inside
  it, since podman applies volumes in order and a later parent mount would shadow the read-only memory one.
- **The read-only memory mount still holds under keep-id**, which is the one place uid equality could have
  mattered: `touch ~/.pi/agent/memory/x` fails with `Read-only file system` even though the uid matches.
- **Mounting a *fresh* procfs is denied in a nested namespace, but only with a pid namespace.** Measured in the
  pi-coder container: `unshare --pid --mount-proc` fails with EPERM even though `unshare -Ur` and tmpfs mounts
  succeed, while bwrap's `--proc /proc` *does* work for the sandbox profile — bwrap does not unshare a pid
  namespace by default (the pidns inode is identical inside and out). So the two profiles differ on purpose:
  the sandbox keeps `--proc` (a mounted procfs also keeps `/proc/self/mountinfo` inside), and the probe, which
  passes `--unshare-all` and therefore has a pid namespace, binds `/proc` instead. Cost of the bind: the probe
  sees the parent's process table, which matters for nothing it measures.
- **`--dev-bind` on a missing device kills the whole sandbox, which is why devices are opt-in now.** The bwrap
  profile used to bind `/dev/kfd` and `/dev/dri` unconditionally with `--dev-bind-try`; that meant bubblewrap
  gave every write runtime a GPU while the container gave none, and a plain bind made commands fail with
  "Can't find source path" on hosts without them. `sandbox.devices` now drives both backends, `--dev-bind-try`
  is kept for the optional nodes, and the container adds `--device` plus `--group-add keep-groups` (rootless
  cannot open `/dev/dri/renderD*` without the user's supplementary groups).
- **`bubblewrap` is baked into `.pi/Containerfile`** so this repository's bwrap-executing tests run inside the
  sandbox too: the full suite passes there (163 files, 3171 tests, nothing skipped). pi-coder itself never
  wraps commands in bwrap when the container backend is the sandbox.
- **The verdict decides permission; the backend decides location.** `decision: allow`, `sandboxed: false`
  in `<state>/bash-log.jsonl` does NOT mean the command ran on the host in a container session: the parent's bash
  tool *is* the container-backed tool (`container/bash-tool.ts`), so a model `host` action or a remembered
  rule runs in the container with no extra wrapper. Verified: a parent row recorded `allow`/`sandboxed=False`/
  `model=host` whose output was Debian with `pid1=podman-init`. `test/modules/sandbox/container/bash-tool.test.ts`
  pins it, so a refactor cannot quietly reintroduce local operations for "host" commands.
- **Selection is config, not environment; the prompt is the only interruption.** `sandbox.backend`
  (`auto` | `container` | `bwrap`) is resolved per session (`container/selection.ts`,
  `planSessionBackend`), with `PI_SANDBOX_BACKEND` overriding it so tests stay hermetic. `auto` =
  ready image → container; recipe with no image → one prompt (`Build the image now` /
  `Keep using bubblewrap`, remembered in the project config; dismissal records only the declined tag so a
  recipe edit asks again); otherwise bubblewrap, silently. `container/readiness.ts`-style states
  (`ready`/`needs-build`/`unavailable`/`unsupported`/`no-recipe`) say *why*, and only an explicit
  `container` request gets a warning when it cannot be honoured.
- **Mounts go through one resolver, and the posture is derived from it.** `sandbox.mounts`
  reaches both backends through `resolveConfiguredMounts` (`src/modules/sandbox/posture.ts`):
  `~` expanded, relative or missing paths dropped with a warning instead of becoming a podman-created empty
  directory, duplicate targets collapsed to the most permissive mode, parents ordered before children so a
  later mount cannot shadow a deeper one, and a credential path (`.ssh`, `.aws`, `.gnupg`, …) reported once but
  still allowed — `~/.config/gh` is a legitimate opt-in that holds a token. `SandboxPosture.writableRoots` is
  computed from those entries; never hand-add a root to it. The schema and its warnings are in
  `sandbox/configuration.md`.
- **`writableRoots` is a lower bound on what is writable, not an upper bound on what is read-only.** The
  container's `--tmpfs /tmp`, its session `$HOME` and the writable image rootfs are outside the posture plan,
  and bubblewrap binds host `/tmp` `--bind`, not a `ro` bind, so "this operand is not in `writableRoots`" does
  **not** imply `EROFS`. That is why a rule may not _spend_ `writableRoots` to allow a write-capable command:
  the posture object is also dropped once the container starts (`container/index.ts` keeps only
  mounts/network/devices), and the heuristics expose one aggregated `writes` boolean, not per-operand
  read/write kinds. `docs/bash-execution-redesign.md` reaches the same conclusion ("Deliberately not done
  yet"). A `readonly` role therefore means read-only over the checkout, git data and memory — a scout can still
  write to `/tmp`, to its `$HOME` (the session's own scratch home, next bullet — not the user's), and to the
  image rootfs.
- **The container's `$HOME` is one shared directory at the real home path**, with `.gitconfig` seeded from the
  host identity (rewritten only when the identity differs). It was per session until 2026-11-02, which meant
  every session threw its caches away and left a directory nothing removed — 25 of them in `.state/container`
  on one machine (the path was in the extension checkout before the 2026-11 state-root relocation). Sharing makes `~/.npm`, `~/.cache`, `~/.local` and anything else an agent writes persist,
  and makes the home *not* a boundary between sessions: a scout running alongside another session can read
  what that session wrote there. That is acceptable because it is the same user and the same checkout, but it
  is the reason the real host home is still never mounted. `sandbox.mounts`
  is what puts specific parts back — read-only unless the entry asks for `readwrite` — and `homeMounts` was
  removed because its implicit default list (`.bashrc`, `.local`, `.config`) leaked dotfiles into the sandbox.
- **`stateDir/container` is machine-wide, not per session.** Its layout comes from `containerStatePaths()`
  (`container/state.ts`): `home/` (the shared `$HOME`) and `Containerfile` (the effective recipe of the last
  build). The home used to be per session and the Containerfile per recipe hash, so both accumulated. The
  Containerfile is written only when a build will read it: the path is stable, so writing on a cache hit would
  describe text that was never built. **The dispatcher is not stored there at all**: the container mounts
  `dispatch.mjs` from the running extension, so no copy can drift from the host client (a per-session copy used
  to exist; mounting the source is what made it redundant). The protocol-version handshake stays as the check
  for a partition between an old container and a new extension.
- **`sandbox.mounts` now reaches the container, which it never did before.** Configs written while the
  container ignored them (every one, until the posture layer) can therefore start injecting host paths into an
  image that was built to contain its own. The one that bit: `/etc: readonly`, which is *redundant* for
  bubblewrap (its profile already `--ro-bind`s a fixed list including `/etc`) and wrong for the container,
  because it substitutes a Fedora `/etc` under a Debian image — `/etc/apt`, `/etc/nsswitch.conf`,
  `/etc/ld.so.cache`, and `/etc/pki`. It stays "working" only by accident: Fedora ships
  `/etc/ssl/certs/ca-certificates.crt` as a compat symlink, so https survived. Consequence for probes:
  `/etc/os-release` is a symlink to `../usr/lib/os-release`, which resolves through the *image's* `/usr`, so a
  container with a host `/etc` reports the image's distro while `/etc/fedora-release` exists. Do not use
  `os-release` alone to decide "am I in the container" — check `pid1`.
- **A mount is resolved, so a symlinked source appears at its real path.** `resolveConfiguredMounts` runs
  `realpathSync` and binds the result at the result: a declared `~/x` that is a symlink to `/data/x` shows up in
  the sandbox as `/data/x`, and `~/x` itself is not there. Safe, and `writableRoots` therefore names the path a
  command can really write, but surprising if you configured the symlink. Verified 2026-10-28: the second
  reload after narrowing the global config mounts `~/.pi/agent/memory` rw only (no `~/.pi`, no sessions), and
  `/etc` is the image's own Debian again.
- **Verified live (2026-10-28): the container's `$HOME` is the session home, not the host home.**
  `stat /home/sd` and `stat <state>/container/<id>/home` report the same inode; `touch ~/.bashrc` and
  `touch ~/.config/x` answer `Read-only file system` (they are `sandbox.mounts` binds);
  `touch ~/.probe` in `$HOME` succeeds, because that directory is disposable. `sandbox.mounts` is honoured by
  the container, so a global `~/.pi: readwrite` mount really is writable inside — including
  `~/.pi/agent/sessions` and the settings that decide whether the sandbox is on, which the posture warns about.
  The check was made while the home was per session; since 2026-11-02 the same path is `<state>/container/home`
  (then `<checkout>/.state/container/home`), shared, and the rest of the observation is unchanged.
- **A child below the `command` rung is `readonly`** (`src/tools/agent/child/sandbox-role.ts`): checkout,
  worktree git data, and the memory dir mount read-only, and the runtime gets no network. `command` and
  `mutate` stay `write`, because a reviewer's test suite writes `coverage/` and `node_modules/.cache`.
- **`node:*-trixie-slim` ships `awk`, `nawk`, `which`, and `pager` as dangling alternatives**
  (`/var/lib/dpkg/alternatives/awk` lists no candidates, so `/usr/bin/awk -> /etc/alternatives/awk` resolves
  to nothing while `/usr/bin/mawk` works). The fix belongs in the recipe, not in a session: `update-alternatives
  --install` for each. A missing `awk` or `which` reads as a broken sandbox rather than an image gap, and this
  repository's `.pi/Containerfile` now repairs all three.
- **Containerization is sticky within a process.** pi runs extension factories once and offers no way to
  unregister a tool, so once this runtime installs the container's `bash` it stays containerized until pi
  restarts: `session_shutdown` (which also fires on a session *switch*) reaps the containers but keeps the
  tools, and `/sandbox backend` says "restart pi" rather than "next session" when talks would otherwise be
  false. The other direction — bubblewrap first, container later — works in-session, because installing a tool
  late is allowed.
- **Known gap, knowingly left (2026-10-28): `COPY`/`ADD` sources are not in the tag.** The tag hashes the
  base image name and the effective Containerfile, so a recipe that copies a sibling file (`.pi/foo.conf`)
  keeps its tag when only that file changes, and the stale image is reused silently. Podman cannot be asked
  to answer this: buildah keys the `COPY` layer cache on the copied content, so "is it stale?" means "run a
  build and compare the image ID" — exact, but it costs a build on every start and after a `podman system
  prune` a supposedly instant no-op becomes a full rebuild, unprompted. The chosen fix if it is ever wanted:
  add the resolved `COPY` sources to `recipeHash` (content for small files, `size+mtime` above ~1 MB, skip
  anything a glob/`--from`/remote URL makes uncertain). Do not hash the whole context: the context dir is
  `.pi/`, 1.6 GB in this checkout.
- **A rebuild replaces the container; it is never reused.** The tag is a content hash, so a rebuilt recipe is
  a different image and the running container is stale by construction. `adoptImage` marks the session stale
  and `sessionFor` closes the old container and starts the new one at the next command boundary — the
  reload that used to be required was a pi-coder limitation, not a property of podman.
- **Both runtimes are containerized; the verdict never decides *where*.** The parent hook
  (`src/tools/bash/index.ts`) keys off `containerBackendRequested()` instead of a binary probe. A child loads
  the same backend as a hidden `pi-coder-container` extension (`childExtensionEntries`) with
  `{ notify: false, eagerStart: false }`, so a model `host` action or a remembered rule in a scout still runs
  in a container, and the run reaps it on `dispose`; `close()` makes a late command fail instead of leaking a
  container. The switch is process-wide, so the child gate never reads it: it asks `options.containerBash()`,
  a per-run predicate the backend sets on install. With it the gate skips the `lookpath` probe, the wrapper, and
  the sandbox/direct toggle; without it (switch off) it wraps with bwrap exactly as before. Do not restore an
  env read there — that was the bug that left a sandboxed child command unconfined on the host.
  **Do not diagnose this with `ps` alone.** Two scout probes looked like proof (host `pid 1`, Fedora,
  readable `~/.ssh`, no bwrap) and were not: the decision log showed every command was `action: host` from
  the decision model (confidence 0.71–0.87, `criterion: none`) and therefore `decision: allow`,
  `sandboxed: false` by design. A sandbox claim needs `<state>/bash-log.jsonl` (900+ parent rows and 240 child
  rows there, including wrapped child runs), not a process listing. Same log shows the model downgrading
  `python3 -c` that reads `/proc` and `~/.ssh` to host — a classifier-threshold question, not a gate bug.
- **File tools run in the container too** (`container/file-operations.ts`, `container/file-tools.ts`,
  `container/grep-tool.ts`). pi exports `create{Read,Write,Edit,Ls,Find,Grep}ToolDefinition(cwd, {operations})`,
  and a same-named registration shadows the built-in, so only the storage seam changes: truncation, image
  resizing, diff preview, mutation queue, renderers, and prompt metadata stay pi's. `grep` needed its own
  execute because pi spawns `rg` inside its implementation; `grep-tool.test.ts` compares both implementations
  over the same checkout, which is a valid oracle because the roots are shared. Registration is gated on
  `pi.getActiveTools()` (do not resurrect a disabled `ls`/`find`/`grep`) and on
  `ToolInfo.sourceInfo.path === "builtin:<name>"` (do not clobber another extension's tool).
  Consequences: user memory is mounted **rw** (a read-only mount would break `edit` on both paths), and the
  host's `user.name`/`user.email` are seeded into the sandbox home as `.gitconfig` — the host file's
  credential helper, `hooksPath`, and LFS filters name paths the image lacks, so only the identity crosses.
- **Protocol (`dispatch.mjs`) has `exec`, `spawn`, and `fs`.** `spawn` is argv without a shell (stdout/stderr
  kept apart for `rg`); `fs` is one op per request (readFile with optional byte prefix, writeFile, mkdir,
  access, stat, readdir, exists, glob). `glob` shells out to `rg --files` (the image has no `fd`), and a kill at
  the limit reports a null exit code, which is not an error. `knip.json` allows the `rg`/`bwrap` binaries: both
  are provided by the image/host rather than by npm.
- **podman is deliberately unreachable inside** (`podman: command not found`), which is the guard
  working. Consequence: image pull/build/setup must be done from a plain host terminal, not by the agent.
- **The container runs as the host user** (`--userns=keep-id`, verified): `id -u` inside is `1241`, the
  same uid that owns the checkout, so `.git/index`, `package.json`, and everything else agree inside and
  out. `sudo` is not installed and is not needed. This replaced the earlier container-root model, which was
  only kept for `apt-get` inside; provisioning is a build now. Rootless `--user 1241` would map to a
  subuid instead and make the mounts unwritable.
- **Image provisioning is not part of the image:** `node:22-bookworm-slim` has no `git`, `rg`, or
  `procps`, and no apt index (`E: Unable to locate package git`) until `apt-get update`. Installing at
  session start costs ~5 s, needs network, and is **lost on restart** because the container runs with
  `--rm`. `PI_SANDBOX_IMAGE` is the knob to point at a prepared image; the dispatcher only needs Node 20+.

Deferred: TUI footer, `sandbox.backend` in the config file and its UI, mount widening on permissions,
per-worker containers, `podman commit` warmth, file tools (stay host-side).

## Running this repository's suite inside the sandbox

The focused `container/` suite runs green inside the container (104 tests). The *full* suite does not, and
the three causes are all environment, not sandbox logic:

- **glibc age.** `vendor/sqlite3` needs `GLIBC_2.38`+; Debian 12 (bookworm, 2.36) fails to load it, which
  takes out `test/common/sqlite.test.ts` and every suite that pulls in the session store. Fixed by basing the
  image on Debian 13 (trixie, glibc 2.41). The default image is `node:24-trixie-slim` for the same reason,
  and Node 24 matches the host toolchain.
- **Tests that assume a developer machine.** `test/modules/sandbox/bubblewrap.test.ts` ("should NOT include
  --clearenv when inheritEnv is not defined") only holds when a *global* config file exists, because
  `defaultConfig()` sets `inheritEnv: {}` — a fresh `$HOME` therefore emits `--clearenv`. The same shape
  affects `test/tools/file-permissions.test.ts` (user-memory path under `$HOME`) and
  `test/tools/agent-child-decisions.test.ts`.
- **Tests that need host tooling.** `test/tools/agent-scout-bash.test.ts` drives `bwrap`, which by design
  does not exist inside the container.

So "does the suite pass in the sandbox" is not a reasonable gate until those tests stop depending on the
developer's `$HOME` and on `bwrap`. The sandbox's own suites are the ones to run in there.

## The image is a recipe

A session's image is built from a `Containerfile` — `.pi/Containerfile` (project) or
`~/.pi/Containerfile` (global); none means the default image, unchanged. Text in the repo rather
than a live `apt-get` + `podman commit`, for three reasons worth keeping straight: a committed layer is
unreviewable, unreproducible elsewhere, and it makes root's writes *persistent* (which is the argument
that decides it — `--rm` currently keeps every write transient).

The generated prologue is the part that matters:

```dockerfile
FROM node:22-bookworm-slim AS pi-dispatcher-node
<recipe verbatim>
COPY --from=pi-dispatcher-node /usr/local/bin/node /opt/pi/node
RUN /opt/pi/node --version
```

- **Appended after the recipe**, so a recipe's own package management cannot remove the dispatcher, and
  in the recipe's final stage, which is the image podman produces.
- **Verified at build time**, because a glibc Node in a musl base dies with `Exec format error` at
  *session* start, which reads like a pi-coder bug. Alpine/musl `FROM` lines are rejected before podman
  runs; the `RUN --version` catches everything else. The dispatcher then runs from `/opt/pi/node`, not
  `PATH`.
- **Tagged** `localhost/pi-coder-sandbox:<12-hex>` over the effective text plus the base image.
  `PI_SANDBOX_IMAGE` beats a recipe (escape hatch); `PI_SANDBOX_BASE_IMAGE` changes the runtime source.
  Because the hash covers the *effective* file, changing the prologue's base (e.g. bumping
  `DEFAULT_CONTAINER_IMAGE`) also changes the tag — a rebuilt image from before that change is stale and the
  next session asks for a build again. That surprised a hand test; it is not a bug.
- **Pruned automatically after a build**, because every rebuild of a changed recipe adds a tag and nothing
  else ever removed one. `image-retention.ts` holds the policy: keep 3 (`KEEP_SANDBOX_IMAGES`; constant, not
  config), newest first by `podman image inspect {{.Created}}` — Go's `time.Time` string, so `Date.parse`
  fails and only the leading `YYYY-MM-DD HH:MM:SS` is parsed, ID as the tie-break. Images any container
  references (`podman ps --all --quiet` then `inspect {{.Image}}`) are pinned regardless of age and **consume a
  slot**, so a stale stopped container cannot grow the set past the budget; the tag just built is pinned by name
  (`protect`), not by being newest. Removal is one `podman image rm` of IDs, and every image is filtered in code
  against `SANDBOX_IMAGE_PREFIX` first, so the pass can never name an unrelated image. `ImageStore` is a separate
  interface from `ImageRunner` on purpose (a build double must not answer list questions). The pass runs only on
  `built`, never on `present`, and its failure comes back as `pruneError`, warned about by `/sandbox build` and
  never fatal to the build. `podman image prune` is *not* the equivalent: it removes untagged images, and these
  are tagged by recipe hash.
- **Built only on request.** `/sandbox status` / `/sandbox build` (registered even when the backend is
  off), with the recipe shown in a confirmation dialog. A missing recipe image at session start **refuses to
  start** with the tag, recipe path, and the command to run. An earlier warn-and-fall-back to the default
  image was removed on evidence: it ran the session in a bare image and produced 56 failures that looked
  like product bugs (`spawn git ENOENT`) instead of one message.
- **The agent cannot ask for a build.** Only the human's `/sandbox build` builds; there is no tool for
  "the recipe needs this package, build it", and none was built when the recipe work landed. The shape
  discussed and rejected-for-now: a tool that shows the recipe diff in an approval prompt and, on accept,
  runs the same host-side build the command runs. It belongs to the same class as writing `.git/config`,
  so it must never build unasked (see `docs/bash-execution-redesign.md`, "A build is host code execution").

Measured (`debian:bookworm-slim` + `git`, rootless podman): first build 9.6–10.1 s, cache hit 66–73 ms,
image holds the injected node v22.23.4 alongside the recipe's git 2.39.5, session start on it 163 ms with
the dispatcher running from `/opt/pi/node`, and `git` working through the session at the real checkout
path.

**A build is host code execution** (`RUN curl … | sh` runs as the user, with network) — the same class as
writing `.git/config`. The confirmation dialog is the boundary, and a mode without dialogs refuses to
build. Do not add auto-build on session start.

## Isolated workers: own container, shared clone

A worker gets its own container (mount sets are fixed and narrow, so no widening) and, verified
2026-10-28, a **shared clone** rather than a linked worktree: `git clone --shared` borrows objects via
`objects/info/alternates`, so the mount set is

```
$CLONE               rw   # own repo; .git/objects ~4 KB for 406 borrowed commits
$REPO/.git/objects   ro   # alternates target
$REPO/.git/refs      ro   # optional, + packed-refs: lets it fetch upstream, still no write reach
```

Verified: history readable through alternates, commit lands in the clone's store, parent objects not
writable, parent repo otherwise unreachable, `git fetch origin` works with `refs` ro, `git push` fails
without creating a ref, and `git diff --binary base..workerHead` + `git apply --check` still applies in
the parent. This *removes* the `.git` authority surface rather than narrowing it — no path to
`.git/config` (`core.fsmonitor`/`hooksPath`/`filter.*` are host code execution on the next git run),
`.git/hooks`, `.git/worktrees/<other>` (cross-worker), `.git/HEAD`, or the parent checkout.

Do **not** overlay the worktree: it works (rootless overlayfs via `podman volume create --opt
type=overlay --opt o=lowerdir=…`), but git's index then records the overlay's stat data, so the host sees
every file as modified, and an upper-dir whiteout can disagree with a committed delete in `.git`. Overlay
is right for `probe.ts` (never applied back), not for a tree that produces commits.

Costs: the workspace model changes from linked worktree to shared clone (allocation, recycling, run
persistence/resume, `buildGitWorktreeMountCmd`, prompt wording), so use one layout for both backends;
alternates couple the worker to the parent store (git warns about source pruning; failures are loud);
`git remote set-url --push origin no_push` avoids the misleading "access rights" retry; submodules are
not shared.

- **Verified live (2026-10-28): a child's bash is in its own container even on a model `host` verdict.** A
  delegated scout's command was recorded in `.state/bash-log.jsonl` as `decision: allow`, `sandboxed: false`,
  `model=host` (confidence 0.81) while its own process reported `pid 1 = podman-init`, `/run/.containerenv`,
  `/run/pi/dispatch.mjs`, an overlay root, zero bwrap mounts, Debian `os-release`, and no `~/.ssh` — so the
  verdict's "host" now consistently means *inside the backend, no extra sandbox* in both runtimes. Reaping is
  not observable from inside (podman is unreachable by design): check leftover containers from a plain host
  terminal with `podman ps -a --filter label=pi-coder.sandbox`. Match a row to a probe through
  `socket.gethostname()`, which podman sets to the short container id — a 25 s `time.sleep` inside a child is
  the cheapest way to hold its container open long enough to watch it appear and vanish.
- **A child's container mounts what its git needs** (`container/git-mounts.ts`): a linked worktree's
  git directory plus its `commondir` target read-write, and a shared clone's `objects/info/alternates` target
  read-only. Missing pieces are skipped, not fatal. The same helper covers the parent when pi itself runs inside
  a worktree, which used to leave `HEAD` unreadable.

## Still open

TUI footer states, `sandbox.backend` in the config file plus `/config` UI, mount widening when a
permission grants a root (recreate ≈ 375 ms + install replay, or declare a superset up front), and per-worker
containers. The config surface itself (long-form mount entries with `target`/`create`,
`network: none|egress|host` with published ports, `devices` for GPU/other host nodes, and the removal of
`homeMounts`) is implemented — see `sandbox/configuration.md` and `docs/sandbox-config-redesign.md`; retiring
the bwrap backend is the remaining decision there. The rw host binds beyond the checkout are now enumerated: the scratchpad, the user memory
directory (rw since the file tools moved inside), and the checkout itself; everything else is ro or the
sandbox's own — including the resource roots for skills and the extension/pi packages. Cross-session warmth is largely answered by the recipe: preparation is a cached build, so a
session either finds `pi-coder-sandbox:<hash>` or asks to build it; warmth would only still matter for
*runtime* installs, which the recipe makes unnecessary. Profile strengthening (decision 13) remains open,
as does the default session network (NAT is the exfiltration path; `network: "none"` and port publishing are
now expressible, an egress allowlist is not).
