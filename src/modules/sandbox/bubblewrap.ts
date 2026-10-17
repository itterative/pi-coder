import fs from "node:fs";
import path from "node:path";
import config, { type SandboxConfig, DEFAULT_HOME_MOUNTS } from "../../common/config";
import { resolveHomeDirectory } from "../../common/home-directory";

export interface SandboxOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    config?: SandboxConfig;
    /** Runtime-managed roots that should be available inside the sandbox. */
    additionalRoots?: readonly string[];
    /** Additional roots that must be mounted read-only. */
    readOnlyAdditionalRoots?: readonly string[];
}

function escapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function escapeArgWithSubstitution(arg: string, homeDir: string): string {
    arg = arg.replace(/^~/, homeDir);
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function buildEnvCmd(sandboxConfig: SandboxConfig, options?: SandboxOptions): string[] {
    const cmd: string[] = [];
    const env = options?.env ?? process.env;

    const setEnvVars = new Set<string>();
    const defaultEnvVars = ["PWD", "HOME", "PATH", "SHELL", "TERM", "USER"];

    const envConfig = sandboxConfig.sandbox?.env;
    const inheritEnvConfig = sandboxConfig.sandbox?.inheritEnv;

    if (inheritEnvConfig !== undefined) {
        cmd.push("--clearenv");
    }

    // apply custom environment variables first
    if (envConfig) {
        for (const [key, value] of Object.entries(envConfig)) {
            setEnvVars.add(key);
            cmd.push("--setenv", key, escapeArg(value));
        }
    }

    // then go through the allowed envs
    if (inheritEnvConfig) {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) {
                continue;
            }

            if (setEnvVars.has(key)) {
                continue;
            }

            if (inheritEnvConfig[key] !== "allow") {
                continue;
            }

            setEnvVars.add(key);
            cmd.push("--setenv", key, escapeArg(value));
        }
    }

    // finally, set the default envs
    for (const key of defaultEnvVars) {
        if (setEnvVars.has(key)) {
            continue;
        }

        const value = env[key];
        if (value === undefined) {
            continue;
        }

        setEnvVars.add(key);
        cmd.push("--setenv", key, escapeArg(value));
    }

    return cmd;
}

interface MountOptions extends SandboxOptions {
    /**
     * `sandbox` (default) is the execution profile: the workspace and `/tmp` are writable and the GPU
     * devices are passed through. `probe` is `buildProbeCommand`'s observation profile — `/tmp` becomes a
     * throwaway tmpfs and the GPU devices are left out, because a probe must not be able to leave anything
     * behind or reach hardware no decision of ours has approved.
     */
    profile?: "sandbox" | "probe";
}

function buildMountCmd(sandboxConfig: SandboxConfig, options?: MountOptions): string[] {
    const cmd: string[] = [];
    const env = options?.env ?? process.env;
    const probing = options?.profile === "probe";

    cmd.push("--proc", "/proc");
    cmd.push("--dev", "/dev");

    if (probing) {
        cmd.push("--tmpfs", "/tmp");
    } else {
        // temporary, needs proper solution
        cmd.push("--dev-bind", "/dev/kfd", "/dev/kfd");
        cmd.push("--dev-bind", "/dev/dri", "/dev/dri");

        cmd.push("--bind", escapeArg("/tmp"), escapeArg("/tmp"));
    }

    // Minimal system mounts (no /etc - too much sensitive data)
    const systemMounts = ["/usr", "/bin", "/lib", "/lib64", "/etc", "/sys"];

    // Essential /etc files for networking and SSL
    // const etcMounts = [
    //     "/etc/resolv.conf",
    //     "/etc/hosts",
    //     "/etc/ssl/certs",
    //     "/etc/ca-certificates",
    //     "/etc/pki",
    //     "/etc/locale.conf",
    //     "/etc/localtime",
    // ];

    // Shell and bash completion
    const commonMounts = [
        "/etc/bashrc",
        "/etc/bash.bashrc",
        "/etc/profile",
        "/etc/profile.d",
        "/etc/bash_completion",
        "/usr/share/bash-completion",
        "/run/systemd/resolve",
        "/opt",
    ];

    for (const mount of systemMounts) {
        cmd.push("--ro-bind", escapeArg(mount), escapeArg(mount));
    }

    // for (const file of etcMounts) {
    //     cmd.push("--ro-bind-try", escapeArg(file), escapeArg(file));
    // }

    for (const file of commonMounts) {
        cmd.push("--ro-bind-try", escapeArg(file), escapeArg(file));
    }

    // Home mounts - configurable via homeMounts option
    const homeMountsConfig = sandboxConfig.sandbox?.homeMounts;
    if (homeMountsConfig !== false) {
        const homeDir = resolveHomeDirectory(env);
        if (homeDir) {
            let homeMounts: string[];

            if (homeMountsConfig === true || homeMountsConfig === undefined) {
                // Use defaults
                homeMounts = DEFAULT_HOME_MOUNTS;
            } else if (Array.isArray(homeMountsConfig)) {
                // Use custom list
                homeMounts = homeMountsConfig;
            } else {
                homeMounts = [];
            }

            for (const file of homeMounts) {
                cmd.push(
                    "--ro-bind-try",
                    escapeArg(`${homeDir}/${file}`),
                    escapeArg(`${homeDir}/${file}`),
                );
            }
        }
    }

    return cmd;
}

function buildGitWorktreeMountCmd(
    sandboxConfig: SandboxConfig,
    cwd: string,
    mountFlag = "--bind-try",
): string[] {
    const cmd: string[] = [];

    if (sandboxConfig.sandbox?.gitWorktreeSupport === false) {
        return cmd;
    }

    const gitPath = path.join(cwd, ".git");
    if (!fs.existsSync(gitPath) || !fs.statSync(gitPath).isFile()) {
        return cmd;
    }

    let gitContent: string;
    try {
        gitContent = fs.readFileSync(gitPath, "utf-8").trim();
    } catch {
        return cmd;
    }

    const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/);
    if (!gitdirMatch) {
        return cmd;
    }

    const worktreeGitDir = gitdirMatch[1].trim();

    // Read commondir to find the main repo's .git directory
    const commondirPath = path.join(worktreeGitDir, "commondir");
    if (fs.existsSync(commondirPath)) {
        try {
            const commondir = fs.readFileSync(commondirPath, "utf-8").trim();
            const mainGitDir = path.isAbsolute(commondir)
                ? commondir
                : path.resolve(path.dirname(commondirPath), commondir);
            cmd.push(mountFlag, escapeArg(mainGitDir), escapeArg(mainGitDir));
        } catch {
            // If commondir can't be read, continue without main repo mount
        }
    }

    // Mount the worktree-specific git dir (e.g. main-repo/.git/worktrees/feature/)
    cmd.push(mountFlag, escapeArg(worktreeGitDir), escapeArg(worktreeGitDir));

    return cmd;
}

export default function sandbox(bwrap: string, command: string, options?: SandboxOptions): string {
    const cmd: string[] = [bwrap];
    const env = options?.env ?? process.env;
    const cwd = options?.cwd ?? process.cwd();
    const homeDir = resolveHomeDirectory(env);

    const sandboxConfig = options?.config ?? config.current ?? config.default;

    cmd.push("--bind", escapeArg(cwd), escapeArg(cwd));

    const envCmd = buildEnvCmd(sandboxConfig, { env, cwd });
    cmd.push(...envCmd);

    for (const [source, mode] of Object.entries(sandboxConfig.sandbox?.mounts ?? {})) {
        const dest = source;

        if (mode === "readonly") {
            cmd.push(
                "--ro-bind-try",
                escapeArgWithSubstitution(source, homeDir),
                escapeArgWithSubstitution(dest, homeDir),
            );
        } else if (mode === "readwrite") {
            cmd.push(
                "--bind-try",
                escapeArgWithSubstitution(source, homeDir),
                escapeArgWithSubstitution(dest, homeDir),
            );
        }
    }

    // Auto-detect and mount git worktree dependencies
    const gitWorktreeCmd = buildGitWorktreeMountCmd(sandboxConfig, cwd);
    cmd.push(...gitWorktreeCmd);

    // Add system and home mounts
    const mountCmd = buildMountCmd(sandboxConfig, options);
    cmd.push(...mountCmd);

    // Mount additional roots after broad mounts such as /tmp so nested roots
    // remain visible if the broad mount is narrowed or reordered later.
    const readOnlyRoots = new Set(
        (options?.readOnlyAdditionalRoots ?? []).map((root) =>
            path.resolve(root.replace(/^~/, homeDir)),
        ),
    );
    for (const root of options?.additionalRoots ?? []) {
        const resolvedRoot = path.resolve(root.replace(/^~/, homeDir));
        if (resolvedRoot === cwd) continue;
        const mount = readOnlyRoots.has(resolvedRoot) ? "--ro-bind" : "--bind";
        cmd.push(mount, escapeArg(resolvedRoot), escapeArg(resolvedRoot));
    }

    const shell = env.SHELL ?? "sh";

    cmd.push("--die-with-parent");
    cmd.push("--", shell, "-c", escapeArg(command));

    return cmd.join(" ");
}

export interface ProbeCommandOptions extends SandboxOptions {
    bwrap?: string;
    /** Host directory that receives every write the command makes to the workspace. */
    upper: string;
    /** Empty directory on the same filesystem as `upper`, required by overlayfs. */
    work: string;
    /**
     * Descriptor bwrap reports its own status on. Load-bearing: the caller uses it to tell "the command ran
     * and exited N" from "the sandbox never started", which an exit status alone cannot distinguish.
     */
    statusFd?: number;
}

/**
 * Build the bwrap command line that runs `command` for observation instead of for effect.
 *
 * The workspace becomes an overlay: the real tree is the read-only lower layer and `upper` collects every
 * write, so reads are native, changes are captured in full, a deletion is recorded as a whiteout, and the
 * real tree cannot be modified. Everything else is mounted read-only, including configured writable mounts
 * and a worktree's git directories — a probe that could write to a real path would be an execution, not an
 * observation. `/tmp` is a throwaway tmpfs rather than the host's, so a scratch write is neither real nor
 * mistaken for a workspace change.
 *
 * Network is unshared. That is the deliberate limit of the reading: a command that needs the network fails
 * here instead of being observed, and the caller must report that as no evidence rather than as "nothing
 * would change".
 */
export function buildProbeCommand(command: string, options: ProbeCommandOptions): string {
    const cmd: string[] = [options.bwrap ?? "bwrap"];
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const homeDir = resolveHomeDirectory(env);
    const sandboxConfig = options.config ?? config.current ?? config.default;

    cmd.push("--unshare-all");
    cmd.push("--die-with-parent");

    cmd.push(...buildEnvCmd(sandboxConfig, { env, cwd }));

    for (const source of Object.keys(sandboxConfig.sandbox?.mounts ?? {})) {
        cmd.push(
            "--ro-bind-try",
            escapeArgWithSubstitution(source, homeDir),
            escapeArgWithSubstitution(source, homeDir),
        );
    }

    // A worktree's git directories live outside the workspace, so the overlay does not cover them. Git
    // commands that write fail loudly here rather than reaching the real object store.
    cmd.push(...buildGitWorktreeMountCmd(sandboxConfig, cwd, "--ro-bind-try"));

    cmd.push(...buildMountCmd(sandboxConfig, { env, cwd, profile: "probe" }));

    for (const root of options.additionalRoots ?? []) {
        const resolvedRoot = path.resolve(root.replace(/^~/, homeDir));
        if (resolvedRoot === cwd) {
            continue;
        }

        cmd.push("--ro-bind-try", escapeArg(resolvedRoot), escapeArg(resolvedRoot));
    }

    cmd.push("--overlay-src", escapeArg(cwd));
    cmd.push("--overlay", escapeArg(options.upper), escapeArg(options.work), escapeArg(cwd));
    cmd.push("--chdir", escapeArg(cwd));

    if (options.statusFd !== undefined) {
        cmd.push("--json-status-fd", String(options.statusFd));
    }

    const shell = env.SHELL ?? "sh";
    cmd.push("--", shell, "-c", escapeArg(command));

    return cmd.join(" ");
}
