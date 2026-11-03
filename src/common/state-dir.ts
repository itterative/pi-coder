import path from "node:path";

import { resolveHomeDirectory } from "./home-directory";

/**
 * pi-coder's runtime state root, resolved without importing pi.
 *
 * `PI_CODER_STATE_DIR` relocates it. Otherwise it is `<agent dir>/pi-coder`, where the agent dir is pi's own
 * `getAgentDir()`: `PI_CODING_AGENT_DIR` when set (a leading `~` expanded), else `~/.pi/agent`.
 *
 * The extension itself passes pi's resolver into {@link resolveStateDirectory}, so it cannot disagree with the
 * agent directory pi actually uses. The env-only mirror exists for the report scripts: their CLI tests bundle
 * each script into one ESM file, and importing `@earendil-works/pi-coding-agent` there dies with
 * `Dynamic require of "child_process" is not supported`.
 *
 * A relative override resolves against the process cwd, so the state root is always absolute.
 */
export function resolveStateDirectory(
    env: NodeJS.ProcessEnv = process.env,
    agentDir?: string,
): string {
    const override = nonEmpty(env.PI_CODER_STATE_DIR);
    if (override !== undefined) {
        return path.resolve(expandTilde(override, env));
    }

    return path.resolve(agentDir ?? agentDirFromEnvironment(env), "pi-coder");
}

/** pi's `getAgentDir()` without the pi package: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function agentDirFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
    const configured = nonEmpty(env.PI_CODING_AGENT_DIR);
    if (configured !== undefined) {
        return expandTilde(configured, env);
    }

    return path.join(resolveHomeDirectory(env), ".pi", "agent");
}

/** The portion of pi's `normalizePath` that decides where a configured directory lands. */
function expandTilde(value: string, env: NodeJS.ProcessEnv): string {
    const home = resolveHomeDirectory(env);
    if (value === "~") {
        return home;
    }

    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return path.join(home, value.slice(2));
    }

    return value;
}

/** Blank means unset, so the default can apply. */
function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();

    return trimmed ? trimmed : undefined;
}
