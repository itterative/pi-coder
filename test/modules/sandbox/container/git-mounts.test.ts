import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitSupportMounts } from "../../../../src/modules/sandbox/container/git-mounts";

/**
 * A container mounts the working tree and nothing else, so the two layouts that keep git data *outside* the
 * tree need explicit mounts: a linked worktree (`.git` is a file naming `<main>/.git/worktrees/<name>`) and a
 * shared clone (history borrowed through `objects/info/alternates`). Both are real states in this project —
 * isolated workers use one or the other — and both fail loudly with "not a git repository" when the mount is
 * missing, which is the kind of failure that reads like a product bug.
 */

const tempDirs: string[] = [];

beforeEach(() => {});

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-mounts-"));
    tempDirs.push(directory);

    return directory;
}

describe("container git mounts", () => {
    it("adds nothing for a checkout with no .git", () => {
        expect(gitSupportMounts(tempDir())).toEqual([]);
    });

    it("adds nothing for a plain repository, whose .git is inside the mounted tree", () => {
        const repo = tempDir();
        fs.mkdirSync(path.join(repo, ".git", "objects", "info"), { recursive: true });

        expect(gitSupportMounts(repo)).toEqual([]);
    });

    it("mounts both git directories of a linked worktree read-write", () => {
        const repo = tempDir();
        const mainGitDir = path.join(repo, ".git");
        const worktreeGitDir = path.join(mainGitDir, "worktrees", "feature");
        const worktree = path.join(repo, "wt");
        fs.mkdirSync(worktreeGitDir, { recursive: true });
        fs.mkdirSync(worktree);
        fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
        fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

        expect(gitSupportMounts(worktree)).toEqual([
            { source: mainGitDir, target: mainGitDir, mode: "rw" },
            { source: worktreeGitDir, target: worktreeGitDir, mode: "rw" },
        ]);
    });

    it("resolves an absolute commondir too", () => {
        const repo = tempDir();
        const mainGitDir = path.join(repo, "main.git");
        const worktreeGitDir = path.join(mainGitDir, "worktrees", "feature");
        const worktree = path.join(repo, "wt");
        fs.mkdirSync(worktreeGitDir, { recursive: true });
        fs.mkdirSync(worktree);
        fs.writeFileSync(path.join(worktreeGitDir, "commondir"), `${mainGitDir}\n`);
        fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

        expect(gitSupportMounts(worktree)).toEqual([
            { source: mainGitDir, target: mainGitDir, mode: "rw" },
            { source: worktreeGitDir, target: worktreeGitDir, mode: "rw" },
        ]);
    });

    it("mounts a shared clone's alternates target read-only", () => {
        const parent = tempDir();
        const parentObjects = path.join(parent, ".git", "objects");
        fs.mkdirSync(parentObjects, { recursive: true });

        const clone = tempDir();
        fs.mkdirSync(path.join(clone, ".git", "objects", "info"), { recursive: true });
        fs.writeFileSync(
            path.join(clone, ".git", "objects", "info", "alternates"),
            `${parentObjects}\n`,
        );

        expect(gitSupportMounts(clone)).toEqual([
            { source: parentObjects, target: parentObjects, mode: "ro" },
        ]);
    });

    it("skips an alternates entry that does not exist instead of failing the session", () => {
        const clone = tempDir();
        fs.mkdirSync(path.join(clone, ".git", "objects", "info"), { recursive: true });
        fs.writeFileSync(
            path.join(clone, ".git", "objects", "info", "alternates"),
            "/nonexistent/objects\n",
        );

        expect(gitSupportMounts(clone)).toEqual([]);
    });

    it("skips an unreadable .git file rather than guessing", () => {
        const directory = tempDir();
        fs.writeFileSync(path.join(directory, ".git"), "not a gitdir line\n");

        expect(gitSupportMounts(directory)).toEqual([]);
    });
});
