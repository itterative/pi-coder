import fs from "node:fs";
import path from "node:path";

import { SANDBOX_CONFIG_PATH, SANDBOX_CONFIG_PATH_GLOBAL } from "./constants";

function getGlobalConfigPath(): string | undefined {
    return process.env.SANDBOX_CONFIG_PATH_GLOBAL ?? SANDBOX_CONFIG_PATH_GLOBAL;
}

export type SandboxConfigMounts = Record<string, "readonly" | "readwrite">;
export type SandboxConfigPermissions = Record<string, "deny" | "ask" | "allow" | "allow:sandbox">;
export type SandboxConfigEnvFilter = Record<string, "allow" | "deny">;
export type SandboxConfigHomeMounts = boolean | string[];

// Default home directory mounts when homeMounts is true
export const DEFAULT_HOME_MOUNTS = [".bashrc", ".bash_profile", ".local", ".config"];

export interface SandboxConfigAudit {
    provider?: string;
    model?: string;
}

export interface SandboxConfigCwdConfinement {
    enabled?: boolean; // default: true
    /** Execution permission used when a heuristic classification succeeds. */
    permission?: "allow" | "allow:sandbox"; // default: "allow:sandbox"
    commands?: string[]; // restrict heuristic to these known commands (default: all known)
    denyPaths?: string[]; // additional sensitive path segment patterns (glob, e.g. "*.secret")
    blockDotfiles?: boolean; // treat any dotfile/dotdir segment as sensitive (default: false)
    resolveSymlinks?: boolean; // verify paths stay within cwd after symlink resolution (default: true)
}

export interface SandboxConfigHeuristics {
    cwdConfinement?: SandboxConfigCwdConfinement;
}

export interface SandboxConfig {
    sandbox: {
        enabled?: boolean; // master switch for bubblewrap sandboxing (default: true)
        mounts: SandboxConfigMounts;
        env?: Record<string, string>; // custom env vars
        inheritEnv?: SandboxConfigEnvFilter; // filter for existing env vars
        homeMounts?: SandboxConfigHomeMounts; // home directory mounts: true (default), false (none), or array of paths
        gitWorktreeSupport?: boolean; // auto-mount git worktree dependencies (default: true)
    };
    permissions: SandboxConfigPermissions;
    audit?: SandboxConfigAudit;
    heuristics?: SandboxConfigHeuristics;
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
                mounts: data.sandbox?.mounts ?? {},
                env: data.sandbox?.env,
                inheritEnv: data.sandbox?.inheritEnv,
                homeMounts: data.sandbox?.homeMounts,
                gitWorktreeSupport: data.sandbox?.gitWorktreeSupport,
            },
            permissions: data.permissions ?? {},
            audit: data.audit
                ? {
                      provider: data.audit.provider,
                      model: data.audit.model,
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
            mounts: mergeRecordsOrDefault(base.sandbox.mounts, project.sandbox.mounts, {}),
            env: mergeRecords(base.sandbox.env, project.sandbox.env),
            inheritEnv: mergeRecords(base.sandbox.inheritEnv, project.sandbox.inheritEnv),
            homeMounts: mergeHomeMounts(base.sandbox.homeMounts, project.sandbox.homeMounts),
            gitWorktreeSupport:
                project.sandbox.gitWorktreeSupport ?? base.sandbox.gitWorktreeSupport,
        },
        permissions: mergeRecordsOrDefault(base.permissions, project.permissions, {}),
        audit: project.audit ?? base.audit,
        heuristics: mergeHeuristics(base.heuristics, project.heuristics),
    };
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
