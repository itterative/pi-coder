# Temporary scratchpad

## Status

Foundational module and agent capability implemented. Multi-root confinement
integration remains the next implementation phase. This document records the
feature shape; it is not a user-facing command reference.

## Purpose

Give every opted-in pi-coder runtime session a private, temporary filesystem
area for notes, intermediate artifacts, generated reports, and agent handoff
material without polluting the project checkout.

A scratchpad is deliberately **not**:

- a Git workspace or alternate checkout;
- a persistent memory entry;
- a user-managed storage catalog;
- a new LLM-callable read/write tool;
- a security boundary against a hostile local process.

## Terminology and lifetime

The first version has one kind of scratchpad: **ephemeral**.

- The directory is created with `fs.mkdtemp` below `os.tmpdir()` when the
  runtime's `session_start` event runs.
- `os.tmpdir()` may be a RAM-backed `tmpfs` or ordinary disk-backed storage;
  pi-coder does not promise that the contents are held in RAM. The guarantee is
  lifetime, not storage medium.
- The directory is mode `0700` and is never placed in the project checkout.
- The extension does not remove the directory during `session_shutdown` or
  process exit.
- There is no scratchpad database, persistent ID, manual release operation, or
  pi-coder garbage collector in this version. The host OS's normal `/tmp`
  cleanup policy is solely responsible for eventual removal.
- Scratchpad contents are not assumed to survive session shutdown, process
  restart, or a child-session resume. A later persistent form can be designed
  separately if that need appears.

The implementation should call this `ephemeral` or `temporary` internally and
in documentation rather than claiming it is truly "in-memory".

## User-facing behavior

At session startup, the parent receives a system-prompt appendix explaining:

- the absolute scratchpad path;
- that it is private and temporary;
- that it is intended for notes and intermediate artifacts;
- that ordinary `read`, `write`, `edit`, and `bash` tools may use it;
- that pi-coder does not remove it when the session ends and the OS owns
  eventual `/tmp` cleanup;
- that the scratchpad is confined like the current working directory.

A child session receives the same appendix from the same registration factory,
with its own scratchpad path. The child should not need a special tool or a
path-management protocol. The prompt should provide the absolute path because
an extension cannot reliably inject a new environment variable into both
sandboxed and direct Bash execution paths.

The first version creates one independent scratchpad per runtime session:

- the parent owns one scratchpad;
- each child owns a separate scratchpad;
- children do not automatically see the parent's scratchpad;
- explicit sharing can be added later if its lifecycle and concurrency rules
  justify the complexity.

## Agent capability

Add `scratchpad` as an agent capability alongside `memories`.

- The capability is represented in `AgentCapability` and included in the
  definition fingerprint.
- All built-in agents (`scout`, `reviewer`, `advisor`, and `worker`) receive
  the capability by default.
- Custom definitions may declare `scratchpad` in `capabilities`, following the
  existing memory-capability pattern. The capability must not grant edit or
  Bash authority by itself; it only makes the temporary root available to the
  tools that the agent already has.
- The child resource loader registers the scratchpad extension explicitly,
  just as it registers the memory extension. This avoids recursive loading
  while ensuring parent and child runtimes use the same registration factory.
- The capability should be described in the agent catalog/prompt so the parent
  knows that the agent has a temporary working area.

If product intent is that every custom agent receives scratchpad without
mentioning it in frontmatter, make it part of baseline capabilities in a later
small decision. The initial plan follows the existing memory convention:
explicit capability for custom agents, default inclusion for built-ins.

## Confinement model

The scratchpad is an **additional cwd-equivalent root**, not a replacement for
`ctx.cwd`.

The parent and child retain their normal project/worktree cwd so relative
repository operations continue to work. The scratchpad path is additionally
recognized as confined for direct file tools and Bash:

- paths inside the scratchpad are granted without a user prompt;
- paths outside both the normal cwd and scratchpad retain existing behavior;
- `cd` into the scratchpad remains confined, and subsequent modeled relative
  paths remain confined;
- redirects, command substitutions, process substitutions, and other modeled
  path slots use the same additional-root rule;
- canonical/symlink checks continue to reject paths that escape either root;
- the scratchpad itself does not grant command execution or mutation to an
  otherwise read-only agent.

The implementation should extend the shared confinement model rather than add
scratchpad-specific path checks in each tool. Conceptually, confinement changes
from:

```text
one cwd root
```

to:

```text
cwd root + zero or more explicitly registered additional roots
```

The managed scratchpad root may contain any filenames, including names such
as `.env`, without prompting. Canonical/symlink containment remains mandatory:
a scratchpad symlink into a sensitive project path must still be rejected. The
normal sensitive-path policy remains authoritative for the project cwd and for
canonical targets outside the scratchpad.

### Parent tools

The parent file-permission hooks and Bash hook must consult the current
scratchpad root. Access within that root is automatically accepted for both
read and write operations, without changing the parent session's `ctx.cwd`.

For sandboxed Bash, the scratchpad is explicitly bind-mounted read-write by
default. The current sandbox already exposes `/tmp`; the explicit bind is still
important documentation and protects the design if the broad `/tmp` mount is
restricted later.

### Child tools

The child read-only and command/worker permission hooks must receive the
scratchpad root through the same runtime registration state. A scout can read
its own scratchpad, while only an agent that already has edit/write or approved
Bash authority can mutate it. Scratchpad access must not be treated as an
outside-cwd approval request.

For this first version, child execution cwd remains the project/worktree cwd.
An optional future mode could make the scratchpad the actual child cwd and
mount the project read-only, but that is not required for the initial feature.

## Runtime ownership and registration

Create a `src/modules/scratchpad/` module with a registration factory similar
to the memory module. It should own:

- temporary directory creation and runtime registry lifecycle;
- per-runtime scratchpad state;
- prompt appendix generation;
- registration of the runtime root for confinement consumers.

Because the existing parent sandbox/file hooks and explicit child extension
hooks are registered separately, use a small runtime registry keyed by the
session/runtime identity (for example the `SessionManager` object) rather than
module-global mutable "current path" state. This prevents a parent and several
children from accidentally sharing or overwriting one another's scratchpad.

The registry should expose only bounded state needed by consumers, such as:

```ts
interface ScratchpadRuntime {
    path: string;
    status: "starting" | "ready" | "closed";
}
```

The registry must remove runtime entries when the runtime ends, while leaving
filesystem deletion entirely to the host OS. Registry teardown must not attempt
to delete the scratchpad directory.
No arbitrary caller-supplied path should be accepted in this version.

Integrate the parent registration before or alongside the existing sandbox and
file hooks so those hooks can query the runtime root. Integrate the child
registration in `createAgentChild`'s explicit `extensionFactories` list when
the definition has the `scratchpad` capability.

## Sandbox changes

Thread additional allowed roots through the shared sandbox APIs:

- `getPathConfinementPermission` and assessment helpers;
- cwd-confinement shell state and directory-change modeling;
- `resolvePermissionDetails` and its options;
- direct file-permission hooks;
- child command permission hooks;
- bubblewrap command construction.

The root algorithm must:

1. resolve and canonicalize each managed root;
2. accept a path only when it is lexically inside one root;
3. apply the existing symlink escape checks against the matching root;
4. preserve existing behavior when no additional roots are supplied;
5. never allow an additional root to authorize a path outside itself through a
   symlink.

The Bash hook should obtain the scratchpad path for the current runtime,
provide it to permission resolution, and pass it as an explicit bind path when
constructing sandboxed commands. The command heuristic must classify a command
that only reads or writes within the scratchpad according to its existing
read/write classification.

A future strict-scratchpad sandbox mode may mount only the scratchpad and allow
more unknown local commands, with network-capable commands separately denied.
That is explicitly out of scope for this plan; the existing curated command
heuristic and permission policy remain authoritative.

## No explicit sharing in v1

Do not add `scratchpadId`, scratchpad arguments to `agent`, sharing tools, or
parent/child lease management in the first implementation.

The automatic per-runtime behavior keeps lifecycle simple and avoids these
unresolved problems:

- whether a parent can delete a pad while a child is using it;
- whether multiple workers may write concurrently;
- how a temporary pad is restored after a crash;
- whether shared contents should be read-only for scouts;
- how paths should appear in persisted child metadata.

If sharing becomes important, add it as a separate design: likely an explicit
parent-owned attachment with read/write access modes and run-lifetime leases.

## Implementation phases

### Phase 1: module and prompt — implemented

- Add `src/modules/scratchpad/index.ts` and focused types/helpers.
- Create the `0700` temporary directory per runtime; never delete it from
  pi-coder.
- Add the prompt appendix and registration lifecycle.
- Register the parent extension from `src/index.ts`.

### Phase 2: capability and child registration — implemented

- Add the `scratchpad` capability and validation/fingerprinting support.
- Add it to all built-in definitions.
- Register the same scratchpad factory in capable child resource loaders.
- Update prompt/catalog expectations and focused capability tests.

### Phase 3: multi-root confinement — implemented

- Generalize path and command confinement to additional roots.
- Integrate parent file and Bash hooks.
- Integrate child read/write/command hooks.
- Add explicit scratchpad bind handling to bubblewrap.

### Phase 4: lifecycle hardening and documentation — in progress

- Verify runtime registry teardown during parent shutdown, child abort, and
  child disposal without deleting scratchpad directories.
- Ensure separate parent/child runtimes cannot share registry state accidentally.
- Document that `/tmp` storage medium is platform-dependent and that eventual
  deletion is controlled only by the host OS.
- Update relevant project memories after behavior is implemented.

## Tests

Add focused tests for:

- temporary directory creation, `0700` permissions, prompt text, and
  non-deletion during runtime teardown;
- parent and child registration isolation;
- capability discovery, custom-definition validation, and fingerprints;
- paths inside the scratchpad being allowed for read/write without prompts;
- paths outside the cwd and scratchpad retaining existing prompt/block behavior;
- relative paths after `cd` into the scratchpad;
- redirects, command substitutions, and shell chains crossing root boundaries;
- symlink and dangling-symlink escapes from the scratchpad;
- sandboxed Bash including the scratchpad bind mount;
- read-only children being unable to mutate through scratchpad access alone;
- worker writes to the scratchpad being reported correctly;
- runtime registry teardown on normal shutdown without filesystem deletion.

Use the existing sandbox, file-permission, agent child, lifecycle, and prompt
snapshot conventions. Run:

```bash
npm run test:run
npx tsc --noEmit
```

## Manual validation checklist

1. Start a parent session and confirm the prompt describes a temporary
   scratchpad path.
2. Have the parent read, write, edit, and run a sandboxed Bash command against
   that path without a permission dialog.
3. Confirm ordinary outside-cwd paths retain the existing permission behavior.
4. Start a scout and verify it gets a distinct scratchpad and can read it but
   cannot mutate it.
5. Start a worker and verify it can write its own scratchpad without a prompt.
6. Exercise symlink escapes from the scratchpad and confirm they remain
   blocked.
7. Shut down normally and verify pi-coder does not attempt to delete the
   parent or child temporary directories; the OS owns their eventual cleanup.
8. Repeat in print/non-TUI mode and verify no UI-only behavior is required.

## Non-goals and future refinements

- persistent or user-named scratchpads;
- manual scratchpad management tools;
- explicit parent/child scratchpad sharing;
- replacing the current cwd or project checkout;
- a scratchpad-only OS sandbox profile;
- allowing arbitrary unknown commands;
- network policy design;
- guaranteed RAM-only storage;
- crash-time garbage collection managed by pi-coder.
