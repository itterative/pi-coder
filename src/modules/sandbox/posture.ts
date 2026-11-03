/**
 * The sandbox posture: which paths a runtime may write, whether it has a network, and how strictly the
 * kernel enforces it.
 *
 * Permission rules must never branch on the backend's *name*. The container and bubblewrap bind the same
 * checkout at the same path, so "allow this because we are in a container" would grant under the container
 * what it asks for under bubblewrap while both can write exactly the same files. What a rule may branch on
 * is enforcement: a read-only mount answers `EROFS` in both backends, a path view answers nothing, and a
 * host command is unconfined. Hence one posture type, built from one mount plan.
 *
 * `writableRoots` is derived here, never declared by a caller. A rule that trusts it can only be as sound
 * as this derivation, so every entry that reaches a backend goes through {@link resolveConfiguredMounts}:
 * `~` expanded, absolute, canonical, deduplicated, parents before children, read-only when the role is
 * read-only.
 */

import fs from "node:fs";
import path from "node:path";

import { GPU_DEVICE_PATHS, mountAccessOf, type SandboxConfig } from "../../common/config";
import { resolveHomeDirectory } from "../../common/home-directory";

/** `readonly` is a scout-like runtime: it may look, and it may write its own scratchpad, nothing else. */
export type SandboxRole = "write" | "readonly";

/**
 * `none` means the kernel has no route and no resolver — DNS included, because DNS is the search channel.
 *
 * `enforcement` is what a rule may read instead of the backend's name: `kernel-ro` means a write outside
 * {@link SandboxPosture.writableRoots} fails with `EROFS`, `none` means the command is unconfined.
 */
type SandboxEnforcement = "kernel-ro" | "path-view" | "none";

export interface SandboxMountEntry {
    /** Host path, absolute and canonical where it exists. */
    source: string;
    /** Path inside the sandbox; defaults to `source`, which is what keeps `.git` pointers valid. */
    target: string;
    mode: "ro" | "rw";
}

/**
 * What a command may reach on the network.
 *
 * `publish` is the podman `--publish` list, already defaulted to loopback (`127.0.0.1:3000:3000`) so that a
 * dev server is not exposed on the LAN unless the user wrote the address out.
 */
export interface SandboxNetworkPlan {
    mode: "none" | "egress" | "host";
    publish: readonly string[];
}

/**
 * Host device nodes passed into the sandbox.
 *
 * `keepGroups` is not decoration: a rootless container cannot open `/dev/dri/renderD*` unless it keeps the
 * user's supplementary groups (`--group-add keep-groups`), so a device without it fails with `EACCES`.
 */
export interface SandboxDevicePlan {
    paths: readonly string[];
    keepGroups: boolean;
}

export interface SandboxPosture {
    role: SandboxRole;
    enforcement: SandboxEnforcement;
    network: SandboxNetworkPlan;
    devices: SandboxDevicePlan;
    entries: readonly SandboxMountEntry[];
    /** Paths a command can actually write, derived from {@link entries}. */
    writableRoots: readonly string[];
    readOnlyRoots: readonly string[];
    /** Troubles a user has to know about, already deduplicated and in reporting order. */
    warnings: readonly string[];
}

export interface PostureRequest {
    cwd: string;
    config?: SandboxConfig | null;
    role?: SandboxRole;
    env?: NodeJS.ProcessEnv;
    /** Runtime roots that must stay writable (the scratchpad), whatever the role. */
    extraWritableRoots?: readonly string[];
    /** Runtime roots that must stay read-only (the user memory directory for a read-only runtime). */
    extraReadOnlyRoots?: readonly string[];
    /** The container's per-session `$HOME`: writable, disposable, mounted at the real home path. */
    home?: { source: string; target: string };
    /** Git support mounts a checkout needs beyond its own directory. */
    gitMounts?: readonly SandboxMountEntry[];
    /** `false` describes the plan without creating a `create: true` mount; `/sandbox status` uses it. */
    create?: boolean;
}

/**
 * Host paths whose contents are credentials. Mounting one is allowed — `~/.config/gh` is mounted so `gh`
 * works, and it holds a token — but a user who did not mean to expose it should hear about it once.
 */
const CREDENTIAL_PATHS = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker/config.json",
    ".netrc",
    ".npmrc",
    ".password-store",
    ".pi/agent/auth.json",
];

export function resolveSandboxPosture(request: PostureRequest): SandboxPosture {
    const role = request.role ?? "write";
    const warnings: string[] = [];
    const entries: SandboxMountEntry[] = [];

    entries.push({ source: request.cwd, target: request.cwd, mode: mountModeFor(role, "rw") });

    if (request.home !== undefined) {
        entries.push({ ...request.home, mode: "rw" });
    }

    for (const source of request.extraWritableRoots ?? []) {
        entries.push({ source, target: source, mode: "rw" });
    }

    for (const source of request.extraReadOnlyRoots ?? []) {
        entries.push({ source, target: source, mode: "ro" });
    }

    for (const mount of request.gitMounts ?? []) {
        entries.push({ ...mount, mode: mountModeFor(role, mount.mode) });
    }

    const configured = resolveConfiguredMounts(request.config, {
        role,
        env: request.env,
        warnings,
        create: request.create,
    });
    entries.push(...configured);

    const deduped = dedupeMounts(entries, warnings);
    const ordered = orderParentsFirst(deduped);

    return {
        role,
        // Both backends bind read-only targets with a real `MS_RDONLY` mount, so a write outside the
        // writable set fails with `EROFS` either way. What is not shared is the fix-up cost: the container
        // owns its whole rootfs, bubblewrap borrows the host's paths one bind at a time.
        enforcement: "kernel-ro",
        network: resolveNetworkPlan(request.config, role, warnings),
        devices: resolveDevicePlan(request.config, role, warnings),
        entries: ordered,
        writableRoots: ordered.filter((entry) => entry.mode === "rw").map((entry) => entry.target),
        readOnlyRoots: ordered.filter((entry) => entry.mode === "ro").map((entry) => entry.target),
        warnings,
    };
}

/**
 * Where the runtime's own roots land, by role.
 *
 * A read-only runtime still writes its scratchpad — that is where its notes go — but not the user's memory
 * directory, because writing a memory it cannot edit would be the same divergence in the other direction.
 *
 * The sessions directory is read-only for **every** role: pi writes transcripts on the host, so a runtime that
 * reads one to review it (session review, `/stats`, "what did we decide yesterday") has no business rewriting
 * it. That makes it the one root a write role also receives as `extraReadOnlyRoots`.
 */
export function runtimeRootsFor(
    role: SandboxRole,
    roots: {
        scratchpadPath?: string;
        memoryDir?: string;
        sessionsDir?: string;
        /**
         * Resources the prompt advertises: skills, skill scripts, and pi's own docs. Read-only for every
         * role because nothing in the runtime needs to write them, and a command that can would be able to
         * change the instructions a later turn is told to follow.
         */
        resourceRoots?: readonly string[];
    },
): { extraWritableRoots: string[]; extraReadOnlyRoots: string[] } {
    const memory = roots.memoryDir === undefined ? [] : [roots.memoryDir];
    const scratchpad = roots.scratchpadPath === undefined ? [] : [roots.scratchpadPath];
    const sessions = roots.sessionsDir === undefined ? [] : [roots.sessionsDir];
    const resources = roots.resourceRoots === undefined ? [] : [...roots.resourceRoots];

    if (role === "readonly") {
        return {
            extraWritableRoots: scratchpad,
            extraReadOnlyRoots: [...memory, ...sessions, ...resources],
        };
    }

    return {
        extraWritableRoots: [...scratchpad, ...memory],
        extraReadOnlyRoots: [...sessions, ...resources],
    };
}

/** A posture with no sandbox behind it: every path is writable because nothing stops a write. */
export function unconfinedPosture(cwd: string): SandboxPosture {
    return {
        role: "write",
        enforcement: "none",
        network: { mode: "egress", publish: [] },
        devices: { paths: [], keepGroups: false },
        entries: [],
        writableRoots: [cwd],
        readOnlyRoots: [],
        warnings: [],
    };
}

/**
 * The user's `sandbox.mounts`, normalised into the entries both backends bind.
 *
 * Everything a user can get wrong is reported rather than guessed at: a path that does not exist, a relative
 * path, or one that expands to nothing is dropped with a warning, because the alternative is a `--volume`
 * that podman silently satisfies by creating an empty directory — a mount that looks configured and hides
 * the real files.
 *
 * `create: false` is for callers that describe the plan without carrying it out (`/sandbox status`): a
 * mount that would be created is then reported as missing instead of appearing on disk as a side effect.
 */
export function resolveConfiguredMounts(
    config: SandboxConfig | null | undefined,
    options: { role: SandboxRole; env?: NodeJS.ProcessEnv; warnings: string[]; create?: boolean },
): SandboxMountEntry[] {
    const env = options.env ?? process.env;
    const homeDir = resolveHomeDirectory(env);
    const { warnings } = options;
    const configured: SandboxMountEntry[] = [];

    if (config?.sandbox?.homeMounts !== undefined) {
        warnings.push(
            "sandbox.homeMounts is no longer used; add the paths to sandbox.mounts instead " +
                '(for example "~/.config": "readonly")',
        );
    }

    for (const [declared, value] of Object.entries(config?.sandbox?.mounts ?? {})) {
        const entry = typeof value === "object" && value !== null ? value : undefined;
        const source = resolveDeclaredPath(declared, {
            homeDir,
            warnings,
            create: options.create !== false && entry?.create === true,
            what: "sandbox.mounts",
        });

        if (source === undefined) {
            continue;
        }

        warnWhenCredentials(source, homeDir, warnings);

        const target = resolveMountTarget(entry?.target, source, homeDir, warnings);

        if (target === undefined) {
            continue;
        }

        if (target !== source) {
            warnings.push(
                `sandbox.mounts: ${source} is mounted at ${target}; the two sides no longer name the same path`,
            );
        }

        configured.push({ source, target, mode: mountModeFor(options.role, mountAccessOf(value)) });
    }

    return configured;
}

/**
 * What a command may reach on the network, with the read-only role pinned.
 *
 * A read-only runtime gets no route and no resolver whatever the config says: it holds no capability that
 * needs one, and a child must not be able to reach the network by config. Ports only mean something on a
 * network that can publish, so a contradictory pair is reported and dropped rather than handed to podman,
 * where the failure appears at container start and reads like a pi-coder bug.
 */
export function resolveNetworkPlan(
    config: SandboxConfig | null | undefined,
    role: SandboxRole,
    warnings: string[],
): SandboxNetworkPlan {
    if (role === "readonly") {
        return { mode: "none", publish: [] };
    }

    const declared = config?.sandbox?.network;
    const mode = (typeof declared === "string" ? declared : declared?.mode) ?? ("egress" as const);
    const ports = typeof declared === "object" && declared !== null ? (declared.ports ?? []) : [];

    if (ports.length > 0 && mode !== "egress") {
        warnings.push(
            `sandbox.network: ports are not published with network "${mode}"; ignoring them`,
        );

        return { mode, publish: [] };
    }

    return { mode, publish: resolvePublishSpecs(ports, warnings) };
}

/**
 * Host device nodes for the sandbox.
 *
 * A read-only runtime gets none: passing a GPU to a scout buys it nothing, and hardware reach is not a
 * capability a read-only role should acquire by configuration. A missing node is dropped with a warning
 * rather than failing the session — most machines have no `/dev/kfd`, including the one this was written on.
 */
export function resolveDevicePlan(
    config: SandboxConfig | null | undefined,
    role: SandboxRole,
    warnings: string[],
): SandboxDevicePlan {
    if (role === "readonly") {
        return { paths: [], keepGroups: false };
    }

    const declared = config?.sandbox?.devices;

    if (declared === undefined) {
        return { paths: [], keepGroups: false };
    }

    if (declared === "gpu") {
        const present = GPU_DEVICE_PATHS.filter((candidate) => exists(candidate));

        if (present.length === 0) {
            warnings.push(
                `sandbox.devices: no GPU device nodes on this host (${GPU_DEVICE_PATHS.join(", ")}); ` +
                    "the sandbox gets no GPU",
            );
        }

        return { paths: present, keepGroups: present.length > 0 };
    }

    const paths: string[] = [];

    for (const candidate of declared) {
        if (!path.isAbsolute(candidate)) {
            warnings.push(`sandbox.devices: "${candidate}" is not an absolute path; ignoring it`);

            continue;
        }

        if (!exists(candidate)) {
            warnings.push(`sandbox.devices: "${candidate}" does not exist; ignoring it`);

            continue;
        }

        paths.push(candidate);
    }

    return { paths, keepGroups: paths.length > 0 };
}

function exists(candidate: string): boolean {
    try {
        fs.statSync(candidate);

        return true;
    } catch {
        return false;
    }
}

/** A read-only runtime cannot write through a mount the user declared writable. */
function mountModeFor(
    role: SandboxRole,
    declared: "ro" | "rw" | "readonly" | "readwrite",
): "ro" | "rw" {
    if (role === "readonly") {
        return "ro";
    }

    return declared === "rw" || declared === "readwrite" ? "rw" : "ro";
}

/**
 * `3000` → `127.0.0.1:3000:3000`; a long entry keeps its address and ports after validation.
 *
 * The loopback default is the point: a dev server the agent starts is reachable from the host browser, but
 * not from the LAN, unless the user wrote the address out themselves.
 */
function resolvePublishSpecs(ports: readonly (string | number)[], warnings: string[]): string[] {
    const publish: string[] = [];

    for (const entry of ports) {
        const spec = normalizePublishSpec(entry);

        if (spec === undefined) {
            warnings.push(
                `sandbox.network: "${String(entry)}" is not a valid port ` +
                    '(use 3000, "8080:80", or "127.0.0.1:8080:80")',
            );

            continue;
        }

        publish.push(spec);
    }

    return publish;
}

/** One `--publish` spec from a configured port; the editor uses it too, so a bad entry is refused at write time. */
export function normalizePublishSpec(entry: string | number): string | undefined {
    const parts = String(entry).trim().split(":");

    if (parts.length === 1) {
        const port = parsePort(parts[0]);

        return port === undefined ? undefined : `127.0.0.1:${port}:${port}`;
    }

    if (parts.length === 2) {
        const hostPort = parsePort(parts[0]);
        const containerPort = parsePort(parts[1]);

        return hostPort === undefined || containerPort === undefined
            ? undefined
            : `127.0.0.1:${hostPort}:${containerPort}`;
    }

    if (parts.length === 3) {
        const hostPort = parsePort(parts[1]);
        const containerPort = parsePort(parts[2]);

        return parseIpv4(parts[0]) && hostPort !== undefined && containerPort !== undefined
            ? `${parts[0]}:${hostPort}:${containerPort}`
            : undefined;
    }

    return undefined;
}

function parsePort(value: string): string | undefined {
    if (!/^\d{1,5}$/.test(value)) {
        return undefined;
    }

    const port = Number(value);

    return port >= 1 && port <= 65535 ? String(port) : undefined;
}

function parseIpv4(value: string): boolean {
    const octets = value.split(".");

    return (
        octets.length === 4 &&
        octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
}

/** `~` in a target means the container's home too, which is mounted at the real host home path. */
function resolveMountTarget(
    declared: string | undefined,
    source: string,
    homeDir: string | undefined,
    warnings: string[],
): string | undefined {
    if (declared === undefined) {
        return source;
    }

    const expanded = expandHome(declared, { homeDir });

    if (expanded === undefined) {
        warnings.push(
            `sandbox.mounts: target "${declared}" is not an absolute path (use ~/… or $HOME/…); ` +
                `not mounting ${source}`,
        );

        return undefined;
    }

    return path.normalize(expanded);
}

interface DeclaredPathOptions {
    homeDir: string | undefined;
    warnings: string[];
    /** Create the path when it does not exist, instead of dropping it. */
    create: boolean;
    /** Prefix for warnings; `sandbox.mounts` or `sandbox.mounts target`. */
    what: string;
}

/**
 * Resolve one declared mount to a real absolute path, or drop it and say why.
 *
 * `realpath` rather than `resolve`, so a symlinked mount and the path it points at dedupe to one entry and the
 * read-only/writable split is decided on the path the kernel will see rather than the one that was typed.
 *
 * `create` runs `mkdir -p` on the host as the user, so it is refused for a credential path: creating `~/.ssh`
 * so it can be mounted read-only is never what a user meant.
 */
function resolveDeclaredPath(declared: string, options: DeclaredPathOptions): string | undefined {
    const expanded = expandHome(declared, options);

    if (expanded === undefined) {
        options.warnings.push(
            `${options.what}: "${declared}" is not an absolute path (use ~/… or $HOME/…); ignoring it`,
        );

        return undefined;
    }

    try {
        return fs.realpathSync(expanded);
    } catch {
        // Falls through to create-or-drop below.
    }

    if (!options.create) {
        options.warnings.push(`${options.what}: "${declared}" does not exist; ignoring it`);

        return undefined;
    }

    const credential = credentialMatch(createTargetPath(expanded), options.homeDir);

    if (credential !== undefined) {
        options.warnings.push(
            `${options.what}: refusing to create "${declared}" because it holds credentials (${credential})`,
        );

        return undefined;
    }

    try {
        fs.mkdirSync(expanded, { recursive: true });

        return fs.realpathSync(expanded);
    } catch (error) {
        options.warnings.push(
            `${options.what}: could not create "${declared}" (${describeError(error)}); ignoring it`,
        );

        return undefined;
    }
}

/**
 * The path a `create` would make, with every existing ancestor resolved.
 *
 * `realpath`ing only what exists is what makes the credential guard sound against a symlinked parent: without
 * it, `~/link/sub` with `link -> ~/.ssh` passes a lexical check and creates a directory inside `.ssh`.
 */
function createTargetPath(declared: string): string {
    let existing = declared;
    const tail: string[] = [];

    while (true) {
        try {
            return path.join(fs.realpathSync(existing), ...tail);
        } catch {
            const parent = path.dirname(existing);

            if (parent === existing) {
                return declared;
            }

            tail.unshift(path.basename(existing));
            existing = parent;
        }
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One place for `~`, so a `~` means the same thing in a source and in a target, and a target never becomes
 * `$HOME/~/foo`.
 */
function expandHome(
    declared: string,
    options: { homeDir: string | undefined },
): string | undefined {
    const { homeDir } = options;

    if (declared === "~") {
        return homeDir;
    }

    if (declared.startsWith("~/")) {
        if (homeDir === undefined) {
            return undefined;
        }

        return path.join(homeDir, declared.slice(2));
    }

    if (path.isAbsolute(declared)) {
        return declared;
    }

    return undefined;
}

function warnWhenCredentials(
    source: string,
    homeDir: string | undefined,
    warnings: string[],
): void {
    const matched = credentialMatch(source, homeDir);

    if (matched === undefined) {
        return;
    }

    const relative = homeDir === undefined ? source : path.relative(homeDir, source);
    const normalised = relative.split(path.sep).join("/");

    warnings.push(
        normalised === matched
            ? `sandbox.mounts: ${source} holds credentials (${matched}); the sandbox can read them`
            : `sandbox.mounts: ${source} exposes a credential path (${matched}) underneath it`,
    );
}

/** The credential entry a path is, or contains; also the guard for `create`. */
function credentialMatch(source: string, homeDir: string | undefined): string | undefined {
    const relative = homeDir === undefined ? source : path.relative(homeDir, source);
    const normalised = relative.split(path.sep).join("/");

    return CREDENTIAL_PATHS.find(
        (candidate) =>
            normalised === candidate ||
            normalised.startsWith(`${candidate}/`) ||
            // A parent mount reaches everything below it: `~/.pi` hands over the settings and auth that decide
            // whether the sandbox is on at all, and `$HOME` hands over `.ssh`.
            normalised.length === 0 ||
            candidate.startsWith(`${normalised}/`),
    );
}

/**
 * Same target twice: the more permissive mode wins, the first source to claim the target keeps it.
 *
 * A collision between two different sources is named, because with `target` supported this is now a config
 * mistake rather than two spellings of one path.
 */
function dedupeMounts(
    entries: readonly SandboxMountEntry[],
    warnings: string[],
): SandboxMountEntry[] {
    const byTarget = new Map<string, SandboxMountEntry>();

    for (const entry of entries) {
        const existing = byTarget.get(entry.target);

        if (existing === undefined) {
            byTarget.set(entry.target, entry);

            continue;
        }

        if (existing.source !== entry.source) {
            warnings.push(
                `sandbox.mounts: ${entry.source} and ${existing.source} both mount at ${entry.target}; ` +
                    `keeping ${existing.source}`,
            );
        }

        if (existing.mode === "ro" && entry.mode === "rw") {
            byTarget.set(entry.target, entry);
        }
    }

    return [...byTarget.values()];
}

/**
 * Shallower targets first, so a later parent mount never shadows a child one.
 *
 * Podman applies `--volume` in order; bubblewrap fails on a bind whose target parent does not exist yet.
 * Both want the same ordering, and neither should depend on the order keys happen to appear in a JSON file.
 */
function orderParentsFirst(entries: readonly SandboxMountEntry[]): SandboxMountEntry[] {
    const depth = (entry: SandboxMountEntry): number =>
        entry.target.split(path.sep).filter((part) => part.length > 0).length;

    return entries
        .map((entry, index) => ({ entry, index }))
        .toSorted(
            (left, right) => depth(left.entry) - depth(right.entry) || left.index - right.index,
        )
        .map(({ entry }) => entry);
}
