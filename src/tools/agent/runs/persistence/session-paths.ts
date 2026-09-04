import fs from "node:fs";
import path from "node:path";
import { PI_CODER_AGENT_SESSIONS_DIR } from "../../../../common/constants";
import { normalizeCwdForSessionDirectory } from "../../../../common/paths";

export interface AgentCwdSessionDirOptions {
    agentSessionsDir?: string;
}

/** Returns the extension-local session directory for one cwd. */
export function getAgentCwdSessionDir(
    cwd: string,
    { agentSessionsDir = PI_CODER_AGENT_SESSIONS_DIR }: AgentCwdSessionDirOptions = {},
): string {
    const sessionDir = path.join(
        path.resolve(agentSessionsDir),
        normalizeCwdForSessionDirectory(cwd),
    );
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.resolve(agentSessionsDir), 0o700);
    fs.chmodSync(sessionDir, 0o700);
    return sessionDir;
}

export function inside(directory: string, candidate: string): boolean {
    const relative = path.relative(directory, candidate);
    return (
        relative !== "" &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
    );
}

export function safeExistingChildFile(
    childSessionDir: string,
    candidate: string,
): string | undefined {
    try {
        const resolved = path.resolve(candidate);
        const stat = fs.lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
        const real = fs.realpathSync(resolved);
        return inside(childSessionDir, real) ? real : undefined;
    } catch {
        return undefined;
    }
}
