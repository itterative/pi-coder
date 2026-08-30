import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { CommandTag, type HeuristicAssessment } from "../../../modules/sandbox/heuristics";

const execFile = promisify(execFileCallback);

export interface SafeBashRuntimeBlock {
    reason: string;
    traceReason: string;
}

type SafeBashRuntimeRule = (cwd: string) => Promise<SafeBashRuntimeBlock | undefined>;

/**
 * Git status may launch an external fsmonitor hook configured by the repository
 * or user. The built-in monitor is enabled by literal `true`; any other active
 * value is blocked for direct safe-bash execution before status is launched.
 */
async function checkGitStatusFsmonitor(cwd: string): Promise<SafeBashRuntimeBlock | undefined> {
    try {
        const { stdout } = await execFile("git", ["config", "--get", "core.fsmonitor"], {
            cwd,
            encoding: "utf8",
            windowsHide: true,
            maxBuffer: 1_024,
        });
        const value = stdout.trim();
        if (value === "true" || value === "false") return undefined;
        return {
            traceReason: "GIT_FSMONITOR",
            reason: `Read-only agent bash blocked: git status uses unsupported core.fsmonitor value ${JSON.stringify(value)}. Only unset, false, or literal true is allowed for direct safe-bash execution.`,
        };
    } catch (error) {
        // Git uses status 1 to report an unset key.
        if ((error as { code?: unknown }).code === 1) return undefined;
        return {
            traceReason: "GIT_FSMONITOR_CHECK_FAILED",
            reason: "Read-only agent bash blocked: unable to verify core.fsmonitor before git status.",
        };
    }
}

const SAFE_BASH_RUNTIME_RULES: Partial<Record<CommandTag, SafeBashRuntimeRule>> = {
    [CommandTag.GIT_STATUS]: checkGitStatusFsmonitor,
};

/** Runs contextual safeguards selected by the command tags emitted by the heuristic. */
export async function getSafeBashRuntimeBlock(
    assessment: HeuristicAssessment,
    cwd: string,
): Promise<SafeBashRuntimeBlock | undefined> {
    for (const tag of assessment.tags) {
        const rule = SAFE_BASH_RUNTIME_RULES[tag];
        if (!rule) continue;
        const block = await rule(cwd);
        if (block) return block;
    }
    return undefined;
}
