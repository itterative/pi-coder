import os from "node:os";
import path from "node:path";

import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

import { applyDevEnvFromExtension } from "./dev-env";
import { resolveStateDirectory } from "./state-dir";

export { PI_CODER_EXTENSION_DIR } from "./extension-dir";

/**
 * A development checkout may pin pi-coder's own settings in `<extension>/.env`; apply it before any constant
 * below reads the environment. An installed copy has no such file, so this is a no-op there. See `dev-env.ts`
 * for the prefixes and precedence.
 */
applyDevEnvFromExtension();

/**
 * pi-coder's durable runtime state: delegated agent transcripts, isolated worktrees, the decision log and
 * compaction trace, container state, and profiles.
 *
 * Under pi's agent directory, deliberately **not** inside {@link PI_CODER_EXTENSION_DIR}. A git-installed
 * extension is updated with `git reset --hard` followed by `git clean -fdx`, and `-x` deletes ignored files
 * too, so anything this package writes inside its own checkout is destroyed by the next update. The agent
 * directory is pi's durable location for the same kind of data (`sessions/`, `memory/`, `scratchpad/`) and
 * follows `PI_CODING_AGENT_DIR`. A non-blank `PI_CODER_STATE_DIR` relocates it, e.g. to keep a development
 * checkout's state apart from the installed extension's; a relative value resolves against the extension
 * checkout. A checkout's gitignored `.env` may set it too (see `dev-env.ts`), which is how the development
 * copy keeps its state in `<checkout>/.state` while an installed copy uses the default.
 */
export const PI_CODER_STATE_DIR = resolveStateDirectory(process.env, getAgentDir());
export const PI_CODER_AGENT_SESSIONS_DIR = path.join(PI_CODER_STATE_DIR, "agent-sessions");
export const PI_CODER_WORKSPACES_DIR = path.join(PI_CODER_STATE_DIR, "workspaces");

export const SANDBOX_CONFIG_PATH_GLOBAL = path.join(
    os.homedir(),
    ".pi",
    "bash-sandbox-config.json",
);
export const SANDBOX_CONFIG_PATH = process.env.SANDBOX_CONFIG_PATH;

/**
 * Development bash permission decision log. pi-coder runtime state like the other state files; relocate
 * with `SANDBOX_DECISION_LOG_PATH` and disable with `SANDBOX_DECISION_LOG=0`.
 */
export const BASH_DECISION_LOG_PATH = path.join(PI_CODER_STATE_DIR, "bash-log.jsonl");

/**
 * Development trace of what each compaction actually sent and got back: one JSONL record per stage, so the
 * raw model response and the composed summary can be read side by side. pi-coder runtime state like the
 * bash decision log; relocate with `COMPACTION_TRACE_PATH` and disable with `COMPACTION_TRACE=0`.
 */
export const COMPACTION_TRACE_PATH = path.join(PI_CODER_STATE_DIR, "compaction-trace.jsonl");

/**
 * The pi sessions directory every transcript for this agent dir is written to.
 *
 * Resolved through pi's own agent dir rather than a hardcoded `~/.pi/agent`, so a config that moved
 * (`PI_CODING_AGENT_DIR`) mounts the directory pi actually writes to. pi's `getSessionsDir()` is not on its
 * public surface, so this mirrors it: `<agent dir>/sessions`. The parent, not a per-cwd subdirectory, because
 * pi writes sessions under `sessions/<encoded-cwd>/` and a runtime that reviews sessions needs all of them.
 */
export function getUserSessionsDirectory(): string {
    return path.join(getAgentDir(), "sessions");
}

/**
 * Root for the per-runtime temporary scratchpads.
 *
 * Resolved through pi's agent dir like sessions and memories, so a moved config (`PI_CODING_AGENT_DIR`) moves the
 * scratchpads too, and deliberately outside the project checkout. Unlike `/tmp`, this directory outlives a host,
 * container, or dev-environment restart, so pi-coder owns its cleanup (age and size) rather than the OS.
 */
export function getScratchpadDirectory(): string {
    return path.join(getAgentDir(), "scratchpad");
}

/**
 * User-level pi agent memories shared by the parent and delegated agents.
 *
 * Resolved through pi's own agent dir, like {@link getUserSessionsDirectory}, so a session that moved its config
 * (`PI_CODING_AGENT_DIR`) reads and writes the memories pi actually builds its prompt from. The default is
 * unchanged: `~/.pi/agent/memory`.
 */
export function getUserMemoryDirectory(): string {
    return path.join(getAgentDir(), "memory");
}

/**
 * The running pi package's own directory, or `undefined` when it cannot be located.
 *
 * pi-coder's system prompt tells every agent to read pi's docs and examples, and pi builds those paths from
 * its own `getPackageDir()` — so asking pi is the only way this root can name the same directory the prompt
 * advertised. Resolving it from the module graph instead would point at whatever copy this extension happens
 * to have installed, which in a development checkout is a `node_modules` neighbour of the source rather than
 * the running CLI. A failure to ask is not an error: the root is simply absent and those reads prompt as they
 * always did.
 */
export function getPiPackageDirectory(): string | undefined {
    if (cachedPiPackage !== undefined) {
        return cachedPiPackage.packageDirectory;
    }

    let packageDirectory: string | undefined;
    try {
        const candidate = getPackageDir();
        if (typeof candidate === "string" && candidate.trim() !== "") {
            packageDirectory = candidate;
        }
    } catch {
        packageDirectory = undefined;
    }

    cachedPiPackage = { packageDirectory };
    return packageDirectory;
}

/** Memoized because the answer cannot move within a process, and a failure is worth remembering too. */
let cachedPiPackage: { packageDirectory: string | undefined } | undefined;

/** Grace period before permission dialogs accept a buffered confirmation. */
export const PERMISSION_PROMPT_CONFIRMATION_DELAY_MS = 150;
