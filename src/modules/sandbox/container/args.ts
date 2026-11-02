/**
 * Podman invocation for a sandbox session container.
 *
 * Kept pure so the exact command line is unit-testable without podman: `buildPodmanArgs` returns the
 * argument vector, and the client only decides when to spawn it.
 *
 * Choices that are not obvious, each learned the hard way on a rootless, SELinux-Enforcing host:
 *
 * - `--security-opt label=disable`: SELinux Enforcing refuses the mounts otherwise, and `:Z` would relabel
 *   the user's checkout.
 * - `--sig-proxy=false`: a Ctrl-C in the terminal must cancel the running command through the protocol, not
 *   tear down the session's main process.
 * - `--init`: the dispatcher is long-lived and anything a command backgrounds is reparented to PID 1, so a
 *   real reaper has to be PID 1 or backgrounded grandchildren accumulate as zombies.
 * - `--userns=keep-id`: the container runs as the host user rather than as container-root, so nothing inside
 *   holds privilege over the image or can mount/remount anything. This became affordable once provisioning
 *   moved to a `Containerfile`: the reason to keep root was `apt-get` inside the session, and there is no
 *   longer any installing inside. Rootless `--user <uid>` is *not* the same thing — it maps to a subuid, so
 *   the bind-mounted checkout becomes unwritable and files land as `590xxx`.
 * - a shared `$HOME`: with keep-id the image's `/root` is not writable by the container user, and `npm`,
 *   `git`, and anything else writing a cache would fail on the first command that needs one. One host
 *   directory, mounted at the *real* home path, serves every session on the machine, so `~` means the same
 *   thing in and out and the caches a session fills survive into the next one; the host home is never
 *   mounted, and `sandbox.mounts` is what puts specific parts of it back (read-only unless the entry asks
 *   for `readwrite`).
 * - `--network=none` for a read-only runtime: no route and no resolver, so a command that tries to fetch is
 *   refused by the kernel instead of being asked about. Egress is the default because a build needs it;
 *   `host` is the user's explicit choice and shares the host network namespace, loopback services included.
 * - `--publish` for the ports a user configured. The host side is already defaulted to loopback by the
 *   posture, so a dev server is reachable from the host browser and not from the LAN unless the user wrote
 *   the address out.
 * - `--device` plus `--group-add keep-groups` for GPUs: rootless podman maps only the user's primary group,
 *   so without `keep-groups` the container cannot open `/dev/dri/renderD*` even when the uid matches.
 */

export const CONTAINER_LABEL = "pi-coder.sandbox";
export const CONTAINER_SESSION_LABEL = "pi-coder.sandbox.session";
const CONTAINER_NAME_PREFIX = "pi-coder-sandbox";

/** Where the dispatcher is mounted read-only, and the path the container runs it from. */
const DISPATCHER_CONTAINER_PATH = "/run/pi/dispatch.mjs";

type ContainerMountMode = "ro" | "rw";

export interface ContainerMount {
    source: string;
    /** Defaults to `source`: real paths inside and out, which is what keeps `.git` pointers valid. */
    target?: string;
    mode: ContainerMountMode;
}

export interface ContainerLaunchSpec {
    image: string;
    containerName: string;
    sessionId: string;
    cwd: string;
    /**
     * The host `dispatch.mjs` to mount read-only at {@link DISPATCHER_CONTAINER_PATH}. Mounted from the
     * extension rather than copied into state: it is the counterpart of the host client, so a single file
     * that cannot drift from the running extension is the point.
     */
    dispatcherPath: string;
    mounts: readonly ContainerMount[];
    /**
     * Host directory mounted as the container user's `$HOME`. The target is the *real* home path, so `~` and
     * `~/…` mean the same thing inside the container as they do outside — which is the point of mounting the
     * checkout at its real path too. Omitted only in dispatcher-only launches that run no commands.
     */ home?: { source: string; target: string };
    /**
     * The dispatcher's Node binary inside the image. Defaults to `node` from `PATH`; a recipe-built image
     * points at the runtime its prologue installed, which the recipe's own package management cannot remove.
     */
    nodePath?: string;
    /** Overrides the dispatcher's shell detection (`PI_SANDBOX_SHELL`). */
    shell?: string;
    /** `none` adds `--network=none`; `host` adds `--network=host`; `egress` leaves podman's default. */
    network?: "none" | "egress" | "host";
    /** `--publish` specs, already `[ip:][host-port:]container-port`; refused with a network that cannot publish. */
    publish?: readonly string[];
    /** Host device nodes to pass through (`--device`). */
    devices?: readonly string[];
    /** Keep the user's supplementary groups, which is what makes a passed-through device usable rootless. */
    keepGroups?: boolean;
}

export function buildPodmanArgs(spec: ContainerLaunchSpec): string[] {
    const args = [
        "run",
        "--rm",
        "--interactive",
        "--init",
        "--userns=keep-id",
        "--sig-proxy=false",
        "--name",
        spec.containerName,
        "--label",
        `${CONTAINER_LABEL}=1`,
        "--label",
        `${CONTAINER_SESSION_LABEL}=${spec.sessionId}`,
        "--security-opt",
        "label=disable",
        "--workdir",
        spec.cwd,
        "--tmpfs",
        "/tmp",
        "--volume",
        `${spec.dispatcherPath}:${DISPATCHER_CONTAINER_PATH}:ro`,
    ];

    // The home mount comes *before* the paths mounted inside it (the read-only memory directory), because
    // podman applies volumes in order: a later parent mount would shadow the deeper one.
    if (spec.home !== undefined) {
        args.push("--volume", `${spec.home.source}:${spec.home.target}:rw`);
        args.push("--env", `HOME=${spec.home.target}`);
    }

    for (const mount of spec.mounts) {
        const target = mount.target ?? mount.source;
        args.push("--volume", `${mount.source}:${target}:${mount.mode}`);
    }

    const publish = spec.publish ?? [];

    if (publish.length > 0 && (spec.network === "none" || spec.network === "host")) {
        // The posture drops this pair before it gets here; the builder refuses rather than emitting a podman
        // error that arrives as a container start failure.
        throw new Error(`cannot publish ports with network "${spec.network}"`);
    }

    if (spec.network === "none") {
        args.push("--network=none");
    }

    if (spec.network === "host") {
        args.push("--network=host");
    }

    for (const port of publish) {
        args.push("--publish", port);
    }

    for (const device of spec.devices ?? []) {
        args.push("--device", device);
    }

    if (spec.keepGroups === true) {
        args.push("--group-add", "keep-groups");
    }

    if (spec.shell !== undefined) {
        args.push("--env", `PI_SANDBOX_SHELL=${spec.shell}`);
    }

    args.push(spec.image, spec.nodePath ?? "node", DISPATCHER_CONTAINER_PATH);

    return args;
}

/**
 * Container name for a session. Derived from the session id so `podman ps` reads like a list of sessions,
 * and sanitized because a container name may only carry a narrow character set.
 */
export function containerNameFor(sessionId: string): string {
    const sanitized = sessionId.replace(/[^A-Za-z0-9_.-]/g, "-");

    return `${CONTAINER_NAME_PREFIX}-${sanitized}`;
}
