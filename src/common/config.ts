import fs from "node:fs";
import path from "node:path";

import { SANDBOX_CONFIG_PATH, SANDBOX_CONFIG_PATH_GLOBAL } from "./constants";

function getGlobalConfigPath(): string | undefined {
    return process.env.SANDBOX_CONFIG_PATH_GLOBAL ?? SANDBOX_CONFIG_PATH_GLOBAL;
}

export type SandboxConfigMountAccess = "readonly" | "readwrite";

/**
 * One mount, long form. `target` remaps the path inside the sandbox (a deliberate exception to Shape A's
 * "paths mean the same thing in and out"), and `create` makes the host source with `mkdir -p` when missing,
 * which is what a cache directory needs.
 */
export interface SandboxConfigMountOptions {
    mode?: SandboxConfigMountAccess | SandboxConfigMountShorthand;
    target?: string;
    create?: boolean;
}

/** `ro`/`rw` are accepted aliases so a hand-written config may stay short. */
export type SandboxConfigMountShorthand = "ro" | "rw";

/** `readonly`/`readwrite` are the canonical spellings; `ro`/`rw` and the object form are accepted too. */
export type SandboxConfigMountValue =
    SandboxConfigMountAccess | SandboxConfigMountShorthand | SandboxConfigMountOptions;

export type SandboxConfigMounts = Record<string, SandboxConfigMountValue>;
export type SandboxConfigPermissions = Record<string, "deny" | "ask" | "allow" | "allow:sandbox">;
export type SandboxConfigEnvFilter = Record<string, "allow" | "deny">;
/**
 * Legacy only: `sandbox.homeMounts` is no longer applied.
 *
 * The default read-only set of home dotfiles was a leak surface (`.config` routinely holds tokens) and mostly
 * useful to bubblewrap, where host binaries wanted host config. The key is still parsed so a config that sets
 * it is told it does nothing; the posture resolver names the replacement (`sandbox.mounts`).
 */
export type SandboxConfigHomeMounts = boolean | string[];

/**
 * `egress` is the container's NAT (installs and pushes work, and it is the exfiltration path); `none` has no
 * route and no resolver; `host` shares the user's network namespace, so the container reaches host services
 * and the LAN and its own loopback stops being private.
 *
 * `ports` publishes container ports to the host, loopback by default: `3000` means `127.0.0.1:3000:3000`,
 * and a long entry is `[ip:][host-port:]container-port`, passed through after validation.
 */
export type SandboxConfigNetworkMode = "egress" | "none" | "host";
export type SandboxConfigNetworkPort = string | number;
export interface SandboxConfigNetworkSettings {
    mode?: SandboxConfigNetworkMode;
    ports?: SandboxConfigNetworkPort[];
}
export type SandboxConfigNetwork = SandboxConfigNetworkMode | SandboxConfigNetworkSettings;

/** `gpu` is shorthand for the Linux GPU nodes; anything else is a host device path to pass through. */
export type SandboxConfigDevices = "gpu" | string[];

/** The host device nodes `devices: "gpu"` asks for; each one is optional and reported when missing. */
export const GPU_DEVICE_PATHS = ["/dev/kfd", "/dev/dri"] as const;

/**
 * Which backend confines a command: bubblewrap on the host, or the sandbox container.
 *
 * `auto` is the default and the only value that asks the user anything: it uses the container when this
 * project's image is ready, offers to build it when a recipe exists but the image is not, and stays on
 * bubblewrap otherwise. `container` and `bwrap` are settled answers — the prompt never appears again.
 * `PI_SANDBOX_BACKEND` overrides all three, which is what keeps tests and CI hermetic.
 */
export type SandboxBackendChoice = "auto" | "container" | "bwrap";

export interface SandboxConfigAudit {
    provider?: string;
    model?: string;
}

/**
 * Development diagnostics: an append-only JSONL log of every bash permission
 * decision (see `src/modules/sandbox/decision-log.ts`). Enabled by default; the
 * log is pi-coder runtime state under its state root, and can be disabled here,
 * through `SANDBOX_DECISION_LOG`, or relocated with `SANDBOX_DECISION_LOG_PATH`.
 */
export interface SandboxConfigDecisionLog {
    enabled?: boolean; // default: true
    path?: string; // default: <agent-dir>/pi-coder/bash-log.jsonl
    maxBytes?: number; // rotate once the live file passes this size (default: 8 MiB)
    generations?: number; // rotated copies kept, live file excluded: `.1` ... `.N` (default: 10)
}

export interface SandboxConfigCwdConfinement {
    enabled?: boolean; // default: true
    /** Execution permission used when a heuristic classification succeeds. */
    permission?: "allow" | "allow:sandbox"; // default: "allow:sandbox"
    commands?: string[]; // restrict heuristic to these known commands (default: all known)
    denyPaths?: string[]; // additional sensitive path segment patterns (glob, e.g. "*.secret")
    blockDotfiles?: boolean; // treat any dotfile/dotdir segment as sensitive (default: false)
    resolveSymlinks?: boolean; // verify paths stay within cwd after symlink resolution (default: true)
    /** Expand unquoted globs in read path slots before confinement (default: true). */
    globExpansion?: boolean;
    /**
     * Maximum `/`-separated components a glob pattern may span when expanded (default: 10). A
     * non-integer or non-positive value falls back to the default, so a typo can only tighten the
     * bound, never remove it.
     */
    globMaxDepth?: number;
}

export interface SandboxConfigHeuristics {
    cwdConfinement?: SandboxConfigCwdConfinement;
}

/**
 * Roots for the direct file tools (`read`/`grep`/`find`/`ls` and `write`/`edit`).
 *
 * These paths may be touched without a prompt, beyond the working directory and the runtime-owned scratchpad.
 * They are *not* sensitive-name exemptions: `.env`, `.git`, key, and credential paths under a declared root
 * still reach the human, because a root says "this tree is the agent's working material" and not "nothing
 * here is private". See `src/modules/sandbox/file-roots.ts`.
 */
export interface SandboxConfigFiles {
    /** Extra readable roots. `~/…` is expanded by the confinement checks, like `sandbox.mounts`. */
    readRoots?: string[];
    /**
     * Extra writable roots. The only way to widen a write beyond the working directory and the scratchpad: a
     * mount never does it, because a mount describes what a *sandboxed command* may write, and a direct tool
     * write has neither the sandbox nor the approval of that command behind it.
     */
    writeRoots?: string[];
    /**
     * Treat every `sandbox.mounts` entry as a readable root (default false).
     *
     * Opt-in because a mount list is a bubblewrap view, not a statement about what may be read into a model's
     * context: `~/.config/gh: readonly` exists so `gh` works in a sandbox, and it holds a token in a file no
     * name filter catches. When enabled, a `readwrite` mount additionally becomes a writable root.
     */
    honorMounts?: boolean;
    /** The running pi package's own directory is readable without a prompt (default true). */
    honorPiPackage?: boolean;
}

/** Both lists concatenate rather than replace, so a project file can add roots the global one declares. */
function mergeStringLists(
    base: string[] | undefined,
    override: string[] | undefined,
): string[] | undefined {
    if (base === undefined) {
        return override;
    }

    if (override === undefined) {
        return base;
    }

    return [...base, ...override];
}

function mergeFiles(
    base: SandboxConfigFiles | undefined,
    override: SandboxConfigFiles | undefined,
): SandboxConfigFiles | undefined {
    if (!base) {
        return override;
    }

    if (!override) {
        return base;
    }

    return {
        readRoots: mergeStringLists(base.readRoots, override.readRoots),
        writeRoots: mergeStringLists(base.writeRoots, override.writeRoots),
        honorMounts: override.honorMounts ?? base.honorMounts,
        honorPiPackage: override.honorPiPackage ?? base.honorPiPackage,
    };
}

export interface SandboxConfig {
    sandbox: {
        enabled?: boolean; // master switch for bubblewrap sandboxing (default: true)
        backend?: SandboxBackendChoice; // auto (default), container, or bwrap
        containerDeclinedTag?: string; // recipe tag the user said no to, so the prompt stays quiet until it changes
        mounts: SandboxConfigMounts;
        env?: Record<string, string>; // custom env vars
        inheritEnv?: SandboxConfigEnvFilter; // filter for existing env vars
        homeMounts?: SandboxConfigHomeMounts; // true (default), false (none), or a deprecated array of home-relative paths
        network?: SandboxConfigNetwork; // egress (default), none, host, or { mode, ports }
        devices?: SandboxConfigDevices; // "gpu", or host device paths to pass through
        gitWorktreeSupport?: boolean; // auto-mount git worktree dependencies (default: true)
    };
    permissions: SandboxConfigPermissions;
    audit?: SandboxConfigAudit;
    decisionLog?: SandboxConfigDecisionLog;
    heuristics?: SandboxConfigHeuristics;
    files?: SandboxConfigFiles;
}

function parseBackendChoice(value: unknown): SandboxBackendChoice | undefined {
    return value === "auto" || value === "container" || value === "bwrap" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keep only entries whose shape is one this version understands.
 *
 * Validation is lenient on purpose: a malformed entry is dropped rather than made to look loadable, and the
 * posture resolver reports the ones that survive but cannot be used (missing path, relative path, credential
 * exposure). Keeping the raw shape here is what lets `updateSandboxConfigField` edit one key without
 * rewriting the file into the merged view.
 */
function parseMounts(value: unknown): SandboxConfigMounts {
    if (!isRecord(value)) {
        return {};
    }

    const mounts: SandboxConfigMounts = {};

    for (const [source, entry] of Object.entries(value)) {
        const parsed = parseMountEntry(entry);

        if (parsed !== undefined) {
            mounts[source] = parsed;
        }
    }

    return mounts;
}

function parseMountEntry(value: unknown): SandboxConfigMountValue | undefined {
    if (value === "readonly" || value === "readwrite" || value === "ro" || value === "rw") {
        return value;
    }

    if (!isRecord(value)) {
        return undefined;
    }

    const mode =
        value.mode === "readonly" ||
        value.mode === "readwrite" ||
        value.mode === "ro" ||
        value.mode === "rw"
            ? value.mode
            : undefined;
    const target =
        typeof value.target === "string" && value.target.trim().length > 0
            ? value.target
            : undefined;
    const create = value.create === true ? true : undefined;

    if (mode === undefined && target === undefined && create === undefined) {
        return undefined;
    }

    return {
        ...(mode === undefined ? {} : { mode }),
        ...(target === undefined ? {} : { target }),
        ...(create === undefined ? {} : { create }),
    };
}

function parseHomeMounts(value: unknown): SandboxConfigHomeMounts | undefined {
    if (value === true || value === false) {
        return value;
    }

    if (!Array.isArray(value)) {
        return undefined;
    }

    const entries = value.filter((entry): entry is string => typeof entry === "string");

    // An empty list means "no home mounts", which is not the same as the key being absent (defaults apply).
    return entries;
}

function parseNetwork(value: unknown): SandboxConfigNetwork | undefined {
    if (value === "egress" || value === "none" || value === "host") {
        return value;
    }

    if (!isRecord(value)) {
        return undefined;
    }

    const mode =
        value.mode === "egress" || value.mode === "none" || value.mode === "host"
            ? value.mode
            : undefined;
    const ports = Array.isArray(value.ports)
        ? value.ports.filter(
              (port): port is SandboxConfigNetworkPort =>
                  typeof port === "number" || typeof port === "string",
          )
        : undefined;

    if (mode === undefined && ports === undefined) {
        return undefined;
    }

    return {
        ...(mode === undefined ? {} : { mode }),
        ...(ports === undefined ? {} : { ports }),
    };
}

function parseDevices(value: unknown): SandboxConfigDevices | undefined {
    if (value === "gpu") {
        return value;
    }

    if (!Array.isArray(value)) {
        return undefined;
    }

    const paths = value.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );

    return paths.length === 0 ? undefined : paths;
}

/** The canonical access for any accepted mount value; anything unrecognised is the conservative `readonly`. */
export function mountAccessOf(
    value: SandboxConfigMountValue | undefined,
): SandboxConfigMountAccess {
    const mode = typeof value === "string" ? value : value?.mode;

    return mode === "readwrite" || mode === "rw" ? "readwrite" : "readonly";
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function tryLoad(path: string): SandboxConfig | null {
    if (!fs.existsSync(path)) {
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(path, "utf-8"));

        if (!data || typeof data !== "object") {
            return null;
        }

        return {
            sandbox: {
                enabled: data.sandbox?.enabled,
                backend: parseBackendChoice(data.sandbox?.backend),
                containerDeclinedTag: nonEmptyString(data.sandbox?.containerDeclinedTag),
                mounts: parseMounts(data.sandbox?.mounts),
                env: data.sandbox?.env,
                inheritEnv: data.sandbox?.inheritEnv,
                homeMounts: parseHomeMounts(data.sandbox?.homeMounts),
                network: parseNetwork(data.sandbox?.network),
                devices: parseDevices(data.sandbox?.devices),
                gitWorktreeSupport: data.sandbox?.gitWorktreeSupport,
            },
            permissions: data.permissions ?? {},
            files: data.files
                ? {
                      readRoots: data.files.readRoots,
                      writeRoots: data.files.writeRoots,
                      honorMounts: data.files.honorMounts,
                      honorPiPackage: data.files.honorPiPackage,
                  }
                : undefined,
            audit: data.audit
                ? {
                      provider: data.audit.provider,
                      model: data.audit.model,
                  }
                : undefined,
            decisionLog: data.decisionLog
                ? {
                      enabled: data.decisionLog.enabled,
                      path: data.decisionLog.path,
                      maxBytes: data.decisionLog.maxBytes,
                      generations: data.decisionLog.generations,
                  }
                : undefined,
            heuristics: data.heuristics
                ? {
                      cwdConfinement: data.heuristics.cwdConfinement
                          ? {
                                enabled: data.heuristics.cwdConfinement.enabled,
                                permission: data.heuristics.cwdConfinement.permission,
                                commands: data.heuristics.cwdConfinement.commands,
                                denyPaths: data.heuristics.cwdConfinement.denyPaths,
                                blockDotfiles: data.heuristics.cwdConfinement.blockDotfiles,
                                resolveSymlinks: data.heuristics.cwdConfinement.resolveSymlinks,
                                globExpansion: data.heuristics.cwdConfinement.globExpansion,
                                globMaxDepth: data.heuristics.cwdConfinement.globMaxDepth,
                            }
                          : undefined,
                  }
                : undefined,
        } as SandboxConfig;
    } catch {
        return null;
    }
}

function mergeRecords<K extends string, V>(
    base: Record<K, V> | undefined,
    override: Record<K, V> | undefined,
): Record<K, V> | undefined {
    let hasRecords = false;
    const map = new Map<K, V>();

    // Add base entries first
    if (base !== undefined) {
        hasRecords = true;

        for (const [key, value] of Object.entries(base) as [K, V][]) {
            map.set(key, value);
        }
    }

    // Add override entries - delete first if exists to ensure it moves to end
    if (override !== undefined) {
        hasRecords = true;

        for (const [key, value] of Object.entries(override) as [K, V][]) {
            map.delete(key); // Remove if exists so re-insert places it at end
            map.set(key, value);
        }
    }

    if (!hasRecords) {
        return undefined;
    }

    return Object.fromEntries(map) as Record<K, V>;
}

function mergeRecordsOrDefault<K extends string, V>(
    base: Record<K, V> | undefined,
    override: Record<K, V> | undefined,
    _default: Record<K, V>,
): Record<K, V> {
    const merged = mergeRecords(base, override);

    if (merged === undefined) {
        return _default;
    }

    return merged;
}

/** A project may add devices; a shorthand (`gpu`) on either side replaces the other, since it is a whole answer. */
function mergeDevices(
    base: SandboxConfigDevices | undefined,
    override: SandboxConfigDevices | undefined,
): SandboxConfigDevices | undefined {
    if (override === undefined) {
        return base;
    }

    if (base === undefined || typeof base === "string" || typeof override === "string") {
        return override;
    }

    return [...new Set([...base, ...override])];
}

function mergeHomeMounts(
    base: SandboxConfigHomeMounts | undefined,
    override: SandboxConfigHomeMounts | undefined,
): SandboxConfigHomeMounts | undefined {
    // If override is false, disable home mounts entirely
    if (override === false) {
        return false;
    }

    // If override is true or undefined, use base (which may be defaults)
    if (override === true || override === undefined) {
        return base;
    }

    // If base is false or undefined, use override array
    if (base === false || base === undefined) {
        return override;
    }

    // If both are arrays, merge them (base first, then override additions)
    const baseArr = Array.isArray(base) ? base : [];
    const overrideArr = Array.isArray(override) ? override : [];

    const merged = [...baseArr];
    for (const item of overrideArr) {
        if (!merged.includes(item)) {
            merged.push(item);
        }
    }

    return merged;
}

function mergeCwdConfinement(
    base: SandboxConfigCwdConfinement | undefined,
    override: SandboxConfigCwdConfinement | undefined,
): SandboxConfigCwdConfinement | undefined {
    if (!base) {
        return override;
    }

    if (!override) {
        return base;
    }

    const denyPaths = [...new Set([...(base.denyPaths ?? []), ...(override.denyPaths ?? [])])];

    return {
        enabled: override.enabled ?? base.enabled,
        permission: override.permission ?? base.permission,
        commands: override.commands ?? base.commands,
        denyPaths: denyPaths.length > 0 ? denyPaths : undefined,
        blockDotfiles: override.blockDotfiles ?? base.blockDotfiles,
        resolveSymlinks: override.resolveSymlinks ?? base.resolveSymlinks,
        globExpansion: override.globExpansion ?? base.globExpansion,
        globMaxDepth: override.globMaxDepth ?? base.globMaxDepth,
    };
}

function mergeHeuristics(
    base: SandboxConfigHeuristics | undefined,
    override: SandboxConfigHeuristics | undefined,
): SandboxConfigHeuristics | undefined {
    if (!base) {
        return override;
    }

    if (!override) {
        return base;
    }

    return {
        cwdConfinement: mergeCwdConfinement(base.cwdConfinement, override.cwdConfinement),
    };
}

function mergeConfigs(global: SandboxConfig | null, project: SandboxConfig | null): SandboxConfig {
    const base = global ?? defaultConfig();

    if (!project) {
        return base;
    }

    return {
        sandbox: {
            enabled: project.sandbox.enabled ?? base.sandbox.enabled,
            backend: project.sandbox.backend ?? base.sandbox.backend,
            containerDeclinedTag:
                project.sandbox.containerDeclinedTag ?? base.sandbox.containerDeclinedTag,
            mounts: mergeRecordsOrDefault(base.sandbox.mounts, project.sandbox.mounts, {}),
            env: mergeRecords(base.sandbox.env, project.sandbox.env),
            inheritEnv: mergeRecords(base.sandbox.inheritEnv, project.sandbox.inheritEnv),
            homeMounts: mergeHomeMounts(base.sandbox.homeMounts, project.sandbox.homeMounts),
            network: project.sandbox.network ?? base.sandbox.network,
            devices: mergeDevices(base.sandbox.devices, project.sandbox.devices),
            gitWorktreeSupport:
                project.sandbox.gitWorktreeSupport ?? base.sandbox.gitWorktreeSupport,
        },
        permissions: mergeRecordsOrDefault(base.permissions, project.permissions, {}),
        files: mergeFiles(base.files, project.files),
        audit: project.audit ?? base.audit,
        decisionLog: project.decisionLog ?? base.decisionLog,
        heuristics: mergeHeuristics(base.heuristics, project.heuristics),
    };
}

/**
 * The file a project-level write belongs in: the config already in use, or a new one in this checkout.
 *
 * The sandbox container image is a property of a repository (its recipe lives in the checkout), so a backend
 * answer the user gives while working in that repository is written next to the recipe rather than to the
 * global config: a checkout that wants a container should not turn one on for every other repository.
 */
export function resolveProjectConfigPath(cwd: string): string {
    return findConfigLocations(cwd).project ?? path.join(cwd, ".pi", "bash-sandbox-config.json");
}

/**
 * Write one field into a sandbox config file, creating it if needed.
 *
 * A read-modify-write of the raw JSON rather than a save of the merged in-memory config: the merged value
 * folds the global file, defaults, and every unknown key into one object, so writing it back would silently
 * move settings between files and drop keys this version does not know. Only the touched field changes;
 * everything else in the file survives the parse untouched.
 */
export interface SandboxConfigMountEdit {
    source: string;
    /** `null` removes the entry; the object form sets it. */
    value: SandboxConfigMountValue | null;
}

export interface SandboxConfigPatch {
    backend?: SandboxBackendChoice;
    containerDeclinedTag?: string | null;
    mounts?: readonly SandboxConfigMountEdit[];
    homeMounts?: SandboxConfigHomeMounts | null;
    network?: SandboxConfigNetwork | null;
    devices?: SandboxConfigDevices | null;
}

export function updateSandboxConfigField(configPath: string, patch: SandboxConfigPatch): void {
    let document: Record<string, unknown> = {};

    if (fs.existsSync(configPath)) {
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));

            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                document = parsed as Record<string, unknown>;
            }
        } catch {
            // A malformed file is the user's to fix; overwriting it would destroy what they were editing.
            throw new Error(`${configPath} is not valid JSON`);
        }
    }

    const sandbox =
        document.sandbox !== null && typeof document.sandbox === "object"
            ? (document.sandbox as Record<string, unknown>)
            : {};

    if (patch.backend !== undefined) {
        sandbox.backend = patch.backend;
    }

    if (patch.containerDeclinedTag !== undefined) {
        if (patch.containerDeclinedTag === null) {
            delete sandbox.containerDeclinedTag;
        } else {
            sandbox.containerDeclinedTag = patch.containerDeclinedTag;
        }
    }

    if (patch.mounts !== undefined) {
        const mounts = isRecord(sandbox.mounts) ? { ...sandbox.mounts } : {};

        for (const edit of patch.mounts) {
            if (edit.value === null) {
                delete mounts[edit.source];

                continue;
            }

            mounts[edit.source] = edit.value;
        }

        sandbox.mounts = mounts;
    }

    for (const key of ["homeMounts", "network", "devices"] as const) {
        if (patch[key] === undefined) {
            continue;
        }

        if (patch[key] === null) {
            delete sandbox[key];
        } else {
            sandbox[key] = patch[key];
        }
    }

    document.sandbox = sandbox;

    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o640 });
    fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function findConfigLocations(cwd: string): { global: string | null; project: string | null } {
    let projectConfig: string | null = null;

    // Check for project config in directory tree
    let currentFolder = cwd;
    for (let i = 0; i < 20; i++) {
        if (!currentFolder) {
            break;
        }

        const configPath = path.join(currentFolder, ".pi", "bash-sandbox-config.json");

        if (fs.existsSync(configPath)) {
            projectConfig = configPath;
            break;
        }

        const parentFolder = path.dirname(currentFolder);

        if (parentFolder === currentFolder) {
            break;
        }

        currentFolder = parentFolder;
    }

    // Also check SANDBOX_CONFIG_PATH as fallback project config
    if (!projectConfig && SANDBOX_CONFIG_PATH) {
        projectConfig = SANDBOX_CONFIG_PATH;
    }

    return {
        global: getGlobalConfigPath() ?? null,
        project: projectConfig,
    };
}

let _config: SandboxConfig | null = null;

function defaultConfig(): SandboxConfig {
    return {
        sandbox: {
            mounts: {},
            env: {},
            inheritEnv: {},
        },
        permissions: {},
        files: { readRoots: [], writeRoots: [] },
    };
}

export default {
    get default(): SandboxConfig {
        return defaultConfig();
    },

    get current(): SandboxConfig | null {
        if (_config === null) {
            const locations = findConfigLocations(process.cwd());
            const globalConfig = locations.global ? tryLoad(locations.global) : null;
            const projectConfig = locations.project ? tryLoad(locations.project) : null;

            if (!globalConfig && !projectConfig) {
                return null;
            }

            _config = mergeConfigs(globalConfig, projectConfig);
        }

        return _config ?? defaultConfig();
    },

    load(cwd: string) {
        const locations = findConfigLocations(cwd);
        const globalConfig = locations.global ? tryLoad(locations.global) : null;
        const projectConfig = locations.project ? tryLoad(locations.project) : null;

        if (!globalConfig && !projectConfig) {
            throw new Error("could not load sandbox config");
        }

        _config = mergeConfigs(globalConfig, projectConfig);
        return _config;
    },

    save(config: Partial<SandboxConfig>, cwd?: string) {
        cwd = cwd ?? process.cwd();
        const locations = findConfigLocations(cwd);

        const config_path =
            locations.project ?? locations.global ?? SANDBOX_CONFIG_PATH ?? getGlobalConfigPath();

        if (!config_path) {
            throw new Error("no config path available for saving");
        }

        if (!fs.existsSync(config_path)) {
            fs.mkdirSync(path.dirname(config_path), {
                recursive: true,
                mode: 0o640,
            });
        }

        let newConfig: SandboxConfig = _config ?? defaultConfig();
        newConfig = Object.assign(newConfig, config);

        fs.writeFileSync(config_path, JSON.stringify(newConfig), {
            mode: 0o600,
        });

        _config = newConfig;
        return _config;
    },
};
