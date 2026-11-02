import type { SandboxConfig } from "../../common/config";

/**
 * Environment policy shared by the sandbox backends.
 *
 * `resolveSandboxEnv` is the historical bubblewrap rule, extracted so both backends apply one policy:
 * explicit `sandbox.env` first, then whatever `sandbox.inheritEnv` allows, then the defaults. Bubblewrap
 * can inherit the host environment implicitly because it *is* the host filesystem view; a container cannot,
 * so `resolveContainerEnv` adds a second, narrower rule for crossing that boundary.
 */

export interface EnvEntry {
    key: string;
    value: string;
}

/** Variables bubblewrap has always passed even when `inheritEnv` is unset or restrictive. */
const DEFAULT_ENV_KEYS = ["PWD", "HOME", "PATH", "SHELL", "TERM", "USER"];

/**
 * Host path and host-service variables. They describe the host's filesystem and session and are wrong or
 * dangerous inside a container: a host `PATH` cannot resolve, a host `TMPDIR` does not exist, and
 * `SSH_AUTH_SOCK`/`DOCKER_HOST` would point a sandboxed command at a host daemon.
 */
const HOST_ONLY_KEYS = new Set([
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "OLDPWD",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
]);

const HOST_ONLY_PREFIXES = ["XDG_", "PODMAN", "DOCKER", "CONTAINER_", "BUILDAH_"];

/** Terminal and locale variables a shell needs to behave the way the agent expects. */
const TERMINAL_KEYS = new Set(["TERM", "COLORTERM", "TZ", "LANG", "LANGUAGE"]);

/** Names that usually carry credentials. Never inherited implicitly; an explicit allow is respected. */
const SECRET_PATTERN =
    /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i;

/**
 * Entries for `--setenv` (bubblewrap) or a per-command environment (container): custom `sandbox.env`
 * first, then inherited variables the config allows, then the defaults, each key at most once.
 */
export function resolveSandboxEnv(
    sandboxConfig: SandboxConfig,
    env: NodeJS.ProcessEnv,
): EnvEntry[] {
    const seen = new Set<string>();
    const entries: EnvEntry[] = [];

    const add = (key: string, value: string | undefined): void => {
        if (value === undefined || seen.has(key)) {
            return;
        }

        seen.add(key);
        entries.push({ key, value });
    };

    for (const [key, value] of Object.entries(sandboxConfig.sandbox?.env ?? {})) {
        add(key, value);
    }

    const inherit = sandboxConfig.sandbox?.inheritEnv;

    if (inherit !== undefined) {
        for (const [key, value] of Object.entries(env)) {
            if (inherit[key] !== "allow") {
                continue;
            }

            add(key, value);
        }
    }

    for (const key of DEFAULT_ENV_KEYS) {
        add(key, env[key]);
    }

    return entries;
}

/**
 * Environment for a command inside a container.
 *
 * The image supplies `PATH`, `HOME` and the rest, so host values for those keys are dropped rather than
 * overlaid: a host `PATH` would shadow the toolchain the image installs. What crosses is explicit intent
 * (`sandbox.env`, `inheritEnv: "allow"`) plus the variables that make a shell usable (terminal, locale,
 * `PI_*` session metadata). Credential-shaped names are excluded unless a name in `inheritEnv` says
 * otherwise, because an explicit allow is a decision the user made.
 */
export function resolveContainerEnv(
    sandboxConfig: SandboxConfig,
    env: NodeJS.ProcessEnv,
): EnvEntry[] {
    const seen = new Set<string>();
    const entries: EnvEntry[] = [];

    const add = (key: string, value: string | undefined): void => {
        if (value === undefined || seen.has(key)) {
            return;
        }

        seen.add(key);
        entries.push({ key, value });
    };

    for (const [key, value] of Object.entries(sandboxConfig.sandbox?.env ?? {})) {
        add(key, value);
    }

    const inherit = sandboxConfig.sandbox?.inheritEnv ?? {};

    for (const [key, value] of Object.entries(env)) {
        if (inherit[key] !== "allow" || isHostOnlyKey(key)) {
            continue;
        }

        add(key, value);
    }

    for (const [key, value] of Object.entries(env)) {
        if (seen.has(key) || isHostOnlyKey(key) || SECRET_PATTERN.test(key)) {
            continue;
        }

        if (TERMINAL_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("PI_")) {
            add(key, value);
        }
    }

    return entries;
}

function isHostOnlyKey(key: string): boolean {
    return HOST_ONLY_KEYS.has(key) || HOST_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function envEntriesToRecord(entries: readonly EnvEntry[]): Record<string, string> {
    return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
}
