import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
}

export async function gitRaw(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
}

export async function hasAncestor(
    cwd: string,
    baseRevision: string,
    revision: string,
): Promise<boolean> {
    try {
        await git(cwd, ["merge-base", "--is-ancestor", baseRevision, revision]);
        return true;
    } catch {
        return false;
    }
}
