import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DecisionWorkspace, DecisionWorkspaceChange } from "./types";

/** How many changed paths reach the classifier; the rest become a truncation note. */
export const MAX_WORKSPACE_CHANGES = 10;

/** How long `git status` may take before the field is left out of the state. */
const GIT_STATUS_TIMEOUT_MS = 1000;
const MAX_STATUS_BYTES = 1024 * 1024;

const execFileAsync = promisify(execFile);

/**
 * Read the runner's uncommitted changes for the classifier state.
 *
 * This is the one state field collected by running something, so it is best-effort by construction: a cwd
 * that is not a repository, a missing git, a timeout, or an oversized status each drop the field rather than
 * fail the consult. An empty status is dropped too — a clean tree says nothing the command needs.
 */
export async function workspaceStatusFor(cwd: string): Promise<DecisionWorkspace | undefined> {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(
            "git",
            ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=normal"],
            { timeout: GIT_STATUS_TIMEOUT_MS, maxBuffer: MAX_STATUS_BYTES, encoding: "utf8" },
        ));
    } catch {
        return undefined;
    }

    const changes = parseGitStatus(stdout);
    if (changes.length === 0) {
        return undefined;
    }

    return {
        changes: changes.slice(0, MAX_WORKSPACE_CHANGES),
        truncated: changes.length > MAX_WORKSPACE_CHANGES,
    };
}

/**
 * Read porcelain-v1 lines into the change list the state carries.
 *
 * The two status letters are the index and the worktree: `??` is untracked, a rename comes as
 * `old -> new`, and a conflict is where either side is `U` (or both sides delete/add the same path). Order
 * matters — rename before delete, because an `R` line can carry a `D` in its second letter for the old path.
 */
export function parseGitStatus(output: string): DecisionWorkspaceChange[] {
    const changes: DecisionWorkspaceChange[] = [];

    for (const line of output.split("\n")) {
        if (line.length < 4) {
            continue;
        }

        const path = line.slice(3).trim();
        if (path === "") {
            continue;
        }

        changes.push({ status: changeStatus(line.slice(0, 2)), path });
    }

    return changes;
}

function changeStatus(code: string): DecisionWorkspaceChange["status"] {
    if (code === "??") {
        return "untracked";
    }

    if (code.includes("R")) {
        return "renamed";
    }

    if (code.includes("U") || code === "AA" || code === "DD") {
        return "conflicted";
    }

    if (code.includes("D")) {
        return "deleted";
    }

    if (code.includes("A")) {
        return "added";
    }

    return "modified";
}
