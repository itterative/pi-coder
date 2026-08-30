import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** User-level pi agent memories shared by the parent and delegated agents. */
export function getUserMemoryDirectory(): string {
    return path.join(os.homedir(), ".pi", "agent", "memory");
}

/** Grace period before permission dialogs accept a buffered confirmation. */
export const PERMISSION_PROMPT_CONFIRMATION_DELAY_MS = 150;
