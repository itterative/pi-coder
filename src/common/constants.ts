import os from "node:os";
import path from "node:path";

export const SANDBOX_CONFIG_PATH_GLOBAL = path.join(os.homedir(), ".pi", "bash-sandbox-config.json")
export const SANDBOX_CONFIG_PATH = process.env.SANDBOX_CONFIG_PATH;
