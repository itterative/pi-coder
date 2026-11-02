---
name: sandbox-image
description: Change what the container sandbox has installed, through its Containerfile recipe. Use when a command is "not found" in bash but exists on the host, when the user asks to add a tool or package to the sandbox, or when a project needs a sandbox Containerfile set up for the first time.
---

# Sandbox image: the Containerfile recipe

pi-coder can run `bash`, `user_bash`, and the file tools inside a rootless podman container. What that
container has installed is decided by one text file, a `Containerfile` recipe that is committed and reviewed.
The image is never a container someone mutated until it worked, so the fix for a missing tool is always an
edit to that file plus a rebuild — never a one-off `apt-get install` inside a session.

## 1. Confirm the session is containerized

Do this before diagnosing anything: outside a container the answer is simply "the host does not have it".

```bash
/sandbox status
```

- `bash runs in the sandbox container` — containerized; the recipe below applies.
- `image … is built; the container starts with the next session` — a recipe exists and is built, but this
  session is not using it yet.
- `… has no built image yet; run /sandbox build` — the recipe was never built for its current contents.
- `bash runs under bubblewrap` / `no .pi/Containerfile in this project` — **not** a container. A missing
  program is the host's, and no recipe will help.

From inside a command, `/run/.containerenv` exists in the container and not on the host.

## 2. Know where the recipe is and what the build adds

- The recipe is `<project>/.pi/Containerfile`, falling back to `~/.pi/Containerfile` for all projects. The
  project's own file wins. Its directory is the build context, so a recipe may `COPY` a file sitting next to
  it — and only that directory.
- pi-coder prepends a stage that copies a Node runtime into `/opt/pi/node` and appends
  `RUN /opt/pi/node --version`, so the recipe does not have to be Node-based. The built file is at
  `.state/container/Containerfile.<hash>` if the user wants to see exactly what podman was given.
- The image tag is a content hash: `localhost/pi-coder-sandbox:<12 hex>`. Editing the recipe produces a new
  tag, so a stale image can never be mistaken for a fresh one, and retention keeps only the 3 newest.
- Alpine and other musl bases are rejected before podman runs, because the injected runtime is glibc-linked.
  Use Debian, Ubuntu, or Fedora.

## 3. Diagnose a missing program

```bash
command -v <prog>; echo "exit=$?"
```

Then check whether the recipe intended to install it (`rg <prog> .pi/Containerfile`), and what the program
actually is: a shell builtin, a package's binary, or one alternative of several. `node:*-slim` removes
several tools, so a command the user believes is standard may be absent from the image.

Two failures look alike and are not:

- **No such file** — the package is not installed. Add it to the recipe.
- **Installed but broken** — dangling `dpkg` alternatives: in `node:24-trixie-slim`, `/usr/bin/awk` and
  `/usr/bin/which` point at `/etc/alternatives` entries with no candidates, so `awk --version` answers
  "command not found" while `/usr/bin/mawk` works. Either install a real implementation (`gawk`, `mawk`,
  `debianutils`) or repair the alternatives in the recipe; do not tell the user `awk` is missing from the
  base without checking.

If the program exists inside the container and works, the problem is not the image: stop here and debug the
command itself.

## 4. Change the recipe

Propose the smallest diff that installs what is needed, and show it to the user before anything is built.

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ripgrep \
      jq \
 && rm -rf /var/lib/apt/lists/*
```

- Prefer the distribution package over a downloaded installer. A `RUN curl … | sh` runs as the user on the
  host machine and its result is not reviewable by the person approving the build.
- One `RUN` per logical group, so a later edit reuses the layer cache: adding a package to an existing group
  rebuilds that group only.
- Always `--no-install-recommends`, and always drop `/var/lib/apt/lists/*` in the same `RUN`. No `sudo`, no
  service managers: it is an image, not a machine.
- If a tool is only needed by one project, put it in that project's recipe rather than the global one.

Then hand the build to the user:

> Run `/sandbox build` to rebuild the image for this recipe.

**You cannot build it yourself.** A build runs the recipe's `RUN` lines on the host, so it is gated behind a
confirmation dialog on `/sandbox build` (or the one-time offer at session start), deliberately not offered as
an agent tool. Do not attempt to invoke `podman build` directly either: the backend's own build path is what
writes the generated Containerfile, records the tag, and prunes old images.

After the build:

- In a session that is already containerized, `/sandbox build` replaces the container with the new image
  immediately, with no reload.
- In a session that is not, the new image is picked up by the next session.
- Delegated agents (`scout`, `worker`) run their own containers from the same image, so the fix reaches them
  too; a child that was already running saw the old image.
- Re-run the original command to verify, rather than assuming the rebuild fixed it.

## 5. Set up a recipe from nothing

When the user wants the sandbox to have tooling in a project that has no recipe, create
`<project>/.pi/Containerfile`. Start from a base that fits the work and add only what the project needs:

```dockerfile
# Sandbox image for this project; `/sandbox build` builds it, and the tag carries a hash of this text.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
```

Explain the consequences before the user agrees:

- The recipe is opt-in, and building it switches the project to the container backend
  (`sandbox.backend` in `.pi/bash-sandbox-config.json`). `/sandbox backend` switches back to bubblewrap.
- A build is host code execution: `RUN` lines run on the machine, with the user's network and filesystem.
- The `node:*` base keeps `node`, `npm`, and `npx` on `PATH` for commands; the injected `/opt/pi/node` runtime
  is separate and serves only the dispatcher. A non-Node base is fine; it just has no `node` for commands.
- `ca-certificates` is not optional for anything that fetches over https.
- If the recipe will not build, `PI_SANDBOX_IMAGE=<image>` runs the backend on an existing image without a
  recipe — an escape hatch, not a fix, because nothing inside it is reproducible.

## 6. What not to do

- **Do not `podman commit` a container** or install packages interactively "for now". It produces an opaque
  layer nobody reviews, which defeats the point of the recipe — and the next rebuild silently loses it.
- **Do not hand-prune images.** A successful build already keeps the 3 newest recipe images and never removes
  one a container references.
- **Do not edit a recipe to work around a permissions or network problem** in the sandbox. Those are the
  sandbox posture's, not the image's; a recipe change that only widens what the agent can reach needs the
  user's explicit agreement.
- **Do not run `podman build` yourself**, even to check a syntax error. Ask the user for `/sandbox build`: it
  reports the failing step, and a build that fails through the backend is recoverable where an ad-hoc one
  leaves an untagged image behind.
