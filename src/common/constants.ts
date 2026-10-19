import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPackageDir } from "@earendil-works/pi-coding-agent";

/** Root of this installed pi-coder extension, for both source and compiled layouts. */
export const PI_CODER_EXTENSION_DIR = path.resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
);

/** Extension-local, gitignored runtime state. */
export const PI_CODER_STATE_DIR = path.join(PI_CODER_EXTENSION_DIR, ".state");
export const PI_CODER_AGENT_SESSIONS_DIR = path.join(PI_CODER_STATE_DIR, "agent-sessions");
export const PI_CODER_WORKSPACES_DIR = path.join(PI_CODER_STATE_DIR, "workspaces");

export const SANDBOX_CONFIG_PATH_GLOBAL = path.join(
    os.homedir(),
    ".pi",
    "bash-sandbox-config.json",
);
export const SANDBOX_CONFIG_PATH = process.env.SANDBOX_CONFIG_PATH;

/**
 * Development bash permission decision log. Extension-local runtime state like the
 * other `.state/` files; relocate with `SANDBOX_DECISION_LOG_PATH` and disable with
 * `SANDBOX_DECISION_LOG=0`.
 */
export const BASH_DECISION_LOG_PATH = path.join(PI_CODER_STATE_DIR, "bash-log.jsonl");

/**
 * Development trace of what each compaction actually sent and got back: one JSONL record per stage, so the
 * raw model response and the composed summary can be read side by side. Extension-local runtime state like
 * the bash decision log; relocate with `COMPACTION_TRACE_PATH` and disable with `COMPACTION_TRACE=0`.
 */
export const COMPACTION_TRACE_PATH = path.join(PI_CODER_STATE_DIR, "compaction-trace.jsonl");

/** User-level pi agent memories shared by the parent and delegated agents. */
export function getUserMemoryDirectory(): string {
    return path.join(os.homedir(), ".pi", "agent", "memory");
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
