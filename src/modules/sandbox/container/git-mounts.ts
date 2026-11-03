import fs from "node:fs";
import path from "node:path";

import type { SandboxMountEntry } from "../posture";

/**
 * Git mounts a checkout needs beyond its own directory.
 *
 * A container mounts the working tree and nothing else, so two very common layouts break inside it:
 *
 * - **A worktree** (a user's linked worktree, or pi-coder's own `<state>/workspaces/<id>`): its `.git` is a
 *   *file* naming `<main>/.git/worktrees/<name>`, which lives outside the mounted cwd. Git cannot even read
 *   HEAD there.
 * - **An isolated child's shared clone** (`<state>/workspaces/<id>`): history comes from
 *   `objects/info/alternates` pointing into the parent repository, which is likewise outside the mount.
 *
 * This mirrors what the bwrap profile auto-detects (`buildGitWorktreeMountCmd`), written as a mount list
 * because the container takes paths rather than a shell string. The worktree's git directory is read-write
 * because a commit writes refs there; the alternates target is read-only because a clone only borrows objects
 * from it.
 *
 * Missing or unreadable pieces are skipped rather than fatal: a checkout without `.git`, a worktree whose
 * `commondir` is unreadable, and a plain repository all end up with no extra mounts, which is the right
 * answer for each.
 */
export function gitSupportMounts(cwd: string): SandboxMountEntry[] {
    const mounts: SandboxMountEntry[] = [];
    const gitPath = path.join(cwd, ".git");

    if (!exists(gitPath)) {
        return mounts;
    }

    if (isDirectory(gitPath)) {
        // A real repository. Only the alternates case needs anything beyond the cwd mount.
        return alternatesMounts(path.join(gitPath, "objects", "info", "alternates"));
    }

    const worktreeGitDir = readGitdirFile(gitPath);

    if (worktreeGitDir === undefined) {
        return mounts;
    }

    const commonDir = readCommondir(worktreeGitDir);

    if (commonDir !== undefined) {
        mounts.push({ source: commonDir, target: commonDir, mode: "rw" });
        mounts.push(...alternatesMounts(path.join(commonDir, "objects", "info", "alternates")));
    }

    mounts.push({ source: worktreeGitDir, target: worktreeGitDir, mode: "rw" });

    return mounts;
}

/** The object stores an alternates file borrows from, each mounted read-only at its real path. */
function alternatesMounts(alternatesPath: string): SandboxMountEntry[] {
    const text = readText(alternatesPath);

    if (text === undefined) {
        return [];
    }

    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => path.resolve(path.dirname(alternatesPath), line))
        .filter((target) => exists(target))
        .map((target) => ({ source: target, target, mode: "ro" as const }));
}

function readGitdirFile(gitPath: string): string | undefined {
    const text = readText(gitPath);
    const match = text?.match(/^gitdir:\s*(.+)$/m);

    return match?.[1]?.trim();
}

/** `commondir` names the main repository's `.git`, either absolutely or relative to the worktree's git dir. */
function readCommondir(worktreeGitDir: string): string | undefined {
    const text = readText(path.join(worktreeGitDir, "commondir"));

    if (text === undefined || text.length === 0) {
        return undefined;
    }

    return path.isAbsolute(text) ? text : path.resolve(worktreeGitDir, text);
}

function readText(filePath: string): string | undefined {
    try {
        return fs.readFileSync(filePath, "utf8").trim();
    } catch {
        return undefined;
    }
}

function exists(target: string): boolean {
    try {
        fs.statSync(target);
        return true;
    } catch {
        return false;
    }
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}
