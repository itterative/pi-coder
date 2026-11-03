import fs from "node:fs";
import path from "node:path";

import { PI_CODER_EXTENSION_DIR } from "./extension-dir";
import { resolveStateDirectory } from "./state-dir";

/**
 * A development checkout's `.env`: settings for *this copy* of pi-coder only.
 *
 * The file lives at the extension root, never in the caller's cwd, so an untrusted project cannot redirect
 * pi-coder's state, logs, or config. A copy that pi installed from git has no `.env` (it is untracked, and a
 * git-installed package update runs `git clean -fdx`), which is exactly the split wanted: a checkout pins its
 * own runtime state, an installed extension keeps the default state root.
 *
 * Only keys pi-coder owns are applied, by prefix: `PI_CODER_`, `PI_SANDBOX_`, `PI_MEMORY_`, `SANDBOX_`,
 * `COMPACTION_`, `DECISION_MODEL_`, `AGENT_CONFIG_`. `HOME`, `PATH`, and pi's own `PI_*` settings are ignored
 * on purpose: pi has already resolved its agent directory and config by the time extensions load, so letting
 * a file change them would only make the two disagree.
 *
 * An explicitly set environment variable wins over the file, as with dotenv: the file fills gaps, it does not
 * override a launch that chose a value. The one path-valued key, `PI_CODER_STATE_DIR`, is stored absolute
 * (resolved against the extension checkout), so a child process or sandbox that inherits it cannot re-base it
 * on a different copy of pi-coder.
 *
 * `PI_CODER_ENV_FILE` chooses the file: unset/blank means `<extension>/.env`, an off value (`0`, `false`,
 * `no`, `off`) disables it, and anything else names a file (resolved against the cwd). The test setup sets
 * it off so a developer's `.env` cannot change what a suite asserts; tests that exercise this module call
 * {@link applyDevEnvFile} directly.
 */
export function applyDevEnvFromExtension(env: NodeJS.ProcessEnv = process.env): string[] {
    const filePath = devEnvFilePath(env);

    return filePath === undefined ? [] : applyDevEnvFile(env, filePath);
}

/** The file this process would read, or `undefined` when the switch disables it. */
export function devEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const configured = nonEmpty(env.PI_CODER_ENV_FILE);
    if (configured === undefined) {
        return path.join(PI_CODER_EXTENSION_DIR, ".env");
    }

    if (OFF_VALUES.has(configured.toLowerCase())) {
        return undefined;
    }

    return path.resolve(configured);
}

/**
 * Apply the owned keys of one env file, returning the ones that landed.
 *
 * A missing or unreadable file is not an error: most runs, including every installed copy, have none.
 */
export function applyDevEnvFile(env: NodeJS.ProcessEnv, filePath: string): string[] {
    let text: string;
    try {
        text = fs.readFileSync(filePath, "utf-8");
    } catch {
        return [];
    }

    const applied: string[] = [];

    for (const [key, value] of Object.entries(parseEnvFile(text))) {
        if (!isOwnedKey(key) || nonEmpty(env[key]) !== undefined) {
            continue;
        }

        // The state root is made absolute here so the value a child process or sandbox inherits means the
        // same thing there: a relative `.state` would otherwise be re-based on whatever copy of pi-coder
        // the child happens to load.
        env[key] =
            key === "PI_CODER_STATE_DIR"
                ? resolveStateDirectory({ ...env, PI_CODER_STATE_DIR: value })
                : value;
        applied.push(key);
    }

    return applied;
}

/**
 * `KEY=VALUE` lines, with the parts a hand-written dev file actually uses.
 *
 * Blank lines and `#` comments are skipped, `export ` is optional, and a value may be single- or double-quoted
 * (the quotes are stripped, not unescaped). An unquoted value loses a trailing ` # comment`. Later duplicates
 * win. Keys must be shell identifiers, and a line without ``=`` is ignored rather than treated as an error.
 */
export function parseEnvFile(text: string): Record<string, string> {
    const values: Record<string, string> = {};

    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.replace(/^\s*export\s+/u, "").trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }

        const separator = line.indexOf("=");
        if (separator <= 0) {
            continue;
        }

        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
            continue;
        }

        values[key] = parseValue(line.slice(separator + 1).trim());
    }

    return values;
}

/** Prefixes that name a pi-coder setting; everything else in the file belongs to somebody else. */
const OWNED_PREFIXES = [
    "PI_CODER_",
    "PI_SANDBOX_",
    "PI_MEMORY_",
    "SANDBOX_",
    "COMPACTION_",
    "DECISION_MODEL_",
    "AGENT_CONFIG_",
] as const;

const OFF_VALUES = new Set(["0", "false", "no", "off"]);

function isOwnedKey(key: string): boolean {
    return OWNED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function parseValue(value: string): string {
    const quoted =
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")));

    if (quoted) {
        return value.slice(1, -1);
    }

    const comment = value.search(/\s#/u);

    return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** Blank means unset, so a default can apply. */
function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();

    return trimmed ? trimmed : undefined;
}
