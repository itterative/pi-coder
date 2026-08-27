import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config, { type SandboxConfig, DEFAULT_HOME_MOUNTS, type SandboxConfigHomeMounts } from "../../common/config";

export interface SandboxOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    config?: SandboxConfig;
    /** Runtime-managed roots that should be available inside the sandbox. */
    additionalRoots?: readonly string[];
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

function buildMountCmd(sandboxConfig: SandboxConfig, options?: SandboxOptions): string[] {
    const cmd: string[] = [];
    const env = options?.env ?? process.env;

    cmd.push("--proc", "/proc");
    cmd.push("--dev", "/dev");
    cmd.push("--bind", escapeArg("/tmp"), escapeArg("/tmp"))

    // Minimal system mounts (no /etc - too much sensitive data)
    const systemMounts = ["/usr", "/bin", "/lib", "/lib64"];

    // Essential /etc files for networking and SSL
    const etcMounts = [
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/ssl/certs",
        "/etc/ca-certificates",
        "/etc/pki",
        "/etc/locale.conf",
        "/etc/localtime",
    ];

    // Shell and bash completion
    const commonMounts = [
        "/etc/bashrc",
        "/etc/bash.bashrc",
        "/etc/profile",
        "/etc/profile.d",
        "/etc/bash_completion",
        "/usr/share/bash-completion",
        "/run/systemd/resolve",
    ];

    for (const mount of systemMounts) {
        cmd.push("--ro-bind", escapeArg(mount), escapeArg(mount));
    }

    for (const file of etcMounts) {
        cmd.push("--ro-bind-try", escapeArg(file), escapeArg(file));
    }

    for (const file of commonMounts) {
        cmd.push("--ro-bind-try", escapeArg(file), escapeArg(file));
    }

    // Home mounts - configurable via homeMounts option
    const homeMountsConfig = sandboxConfig.sandbox?.homeMounts;
    if (homeMountsConfig !== false) {
        const homeDir = env.HOME ?? os.homedir();
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

function buildGitWorktreeMountCmd(sandboxConfig: SandboxConfig, cwd: string): string[] {
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
            cmd.push("--bind-try", escapeArg(mainGitDir), escapeArg(mainGitDir));
        } catch {
            // If commondir can't be read, continue without main repo mount
        }
    }

    // Mount the worktree-specific git dir (e.g. main-repo/.git/worktrees/feature/)
    cmd.push("--bind-try", escapeArg(worktreeGitDir), escapeArg(worktreeGitDir));

    return cmd;
}

export default function sandbox(bwrap: string, command: string, options?: SandboxOptions): string {
    const cmd: string[] = [bwrap];
    const env = options?.env ?? process.env;
    const cwd = options?.cwd ?? process.cwd();
    const homeDir = env.HOME ?? os.homedir();

    const sandboxConfig = options?.config ?? config.current ?? config.default;

    cmd.push("--bind", escapeArg(cwd), escapeArg(cwd));

    const envCmd = buildEnvCmd(sandboxConfig, { env, cwd });
    cmd.push(...envCmd);

    for (const [source, mode] of Object.entries(sandboxConfig.sandbox?.mounts ?? {})) {
        const dest = source;

        if (mode === "readonly") {
            cmd.push("--ro-bind-try", escapeArgWithSubstitution(source, homeDir), escapeArgWithSubstitution(dest, homeDir));
        } else if (mode === "readwrite") {
            cmd.push("--bind-try", escapeArgWithSubstitution(source, homeDir), escapeArgWithSubstitution(dest, homeDir));
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
    for (const root of options?.additionalRoots ?? []) {
        const resolvedRoot = path.resolve(root);
        if (resolvedRoot === cwd) continue;
        cmd.push("--bind", escapeArg(resolvedRoot), escapeArg(resolvedRoot));
    }

    const shell = env.SHELL ?? "sh";

    cmd.push("--die-with-parent");
    cmd.push("--", shell, "-c", escapeArg(command));

    return cmd.join(" ");
}
