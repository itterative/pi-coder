import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reviewHistory } from "../../src/tools/agent/child/history-review";

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): string {
    git(cwd, ["add", "--all"]);
    git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
}

describe("reviewHistory", () => {
    it("withholds sensitive deleted paths and redacts common secret values", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-review-"));
        tempDirs.push(cwd);
        git(cwd, ["init", "-q"]);
        fs.mkdirSync(path.join(cwd, "src"));
        fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_PASSWORD=removed-secret\n");
        fs.writeFileSync(path.join(cwd, "src", "app.ts"), "export const version = 1;\n");
        const base = commit(cwd, "baseline");

        fs.rmSync(path.join(cwd, ".env"));
        fs.writeFileSync(path.join(cwd, "src", "app.ts"), "export const version = 2;\n");
        fs.writeFileSync(path.join(cwd, "src", "config.ts"), "export const apiKey = 'visible-secret';\n");
        const head = commit(cwd, "review change");

        const result = await reviewHistory(cwd, { base, head });

        expect(result.details).toMatchObject({
            changedFiles: 3,
            reviewedFiles: 2,
            withheldSensitiveFiles: 1,
            redactedLines: expect.any(Number),
        });
        expect(result.text).toContain("export const version = 2;");
        expect(result.text).toContain("apiKey = [REDACTED]");
        expect(result.text).not.toContain(".env");
        expect(result.text).not.toContain("removed-secret");
        expect(result.text).not.toContain("visible-secret");
    });

    it("treats changed filenames as literal pathspecs", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-review-"));
        tempDirs.push(cwd);
        git(cwd, ["init", "-q"]);
        fs.writeFileSync(path.join(cwd, "safe.txt"), "before\n");
        const base = commit(cwd, "baseline");

        fs.writeFileSync(path.join(cwd, ".env"), "API_KEY=withheld-by-path\n");
        fs.writeFileSync(path.join(cwd, ":(glob)**"), "ordinary literal filename\n");
        const head = commit(cwd, "pathspec magic");

        const result = await reviewHistory(cwd, { base, head });

        expect(result.details).toMatchObject({ changedFiles: 2, reviewedFiles: 1, withheldSensitiveFiles: 1 });
        expect(result.text).toContain("ordinary literal filename");
        expect(result.text).not.toContain("withheld-by-path");
    });

    it("ignores inherited Git relocation variables and requires the repository root", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-review-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-review-outside-"));
        tempDirs.push(cwd, outside);
        git(cwd, ["init", "-q"]);
        fs.writeFileSync(path.join(cwd, "file.txt"), "one\n");
        const base = commit(cwd, "first");
        fs.writeFileSync(path.join(cwd, "file.txt"), "two\n");
        const head = commit(cwd, "second");
        git(outside, ["init", "-q"]);

        const originalGitDir = process.env.GIT_DIR;
        const originalWorkTree = process.env.GIT_WORK_TREE;
        process.env.GIT_DIR = path.join(outside, ".git");
        process.env.GIT_WORK_TREE = outside;
        try {
            const result = await reviewHistory(cwd, { base, head });
            expect(result.text).toContain("two");
        } finally {
            if (originalGitDir === undefined) delete process.env.GIT_DIR;
            else process.env.GIT_DIR = originalGitDir;
            if (originalWorkTree === undefined) delete process.env.GIT_WORK_TREE;
            else process.env.GIT_WORK_TREE = originalWorkTree;
        }

        fs.mkdirSync(path.join(cwd, "nested"));
        await expect(reviewHistory(path.join(cwd, "nested"), { base, head }))
            .rejects.toThrow("requires the agent cwd to be the repository root");
    });

    it("rejects ranges whose changed-path metadata is truncated", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-review-"));
        tempDirs.push(cwd);
        git(cwd, ["init", "-q"]);
        const base = commit(cwd, "baseline");
        fs.mkdirSync(path.join(cwd, "src"));
        for (let index = 0; index < 500; index++) {
            const name = `metadata-${String(index).padStart(4, "0")}-${"x".repeat(32)}.ts`;
            fs.writeFileSync(path.join(cwd, "src", name), "export {};\n");
        }
        const head = commit(cwd, "large change");

        await expect(reviewHistory(cwd, { base, head }))
            .rejects.toThrow("Changed-path metadata exceeds");
    });

    it("requires a linear, constrained commit range", async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-review-"));
        tempDirs.push(cwd);
        git(cwd, ["init", "-q"]);
        fs.writeFileSync(path.join(cwd, "file.txt"), "one\n");
        const base = commit(cwd, "first");
        fs.writeFileSync(path.join(cwd, "file.txt"), "two\n");
        const head = commit(cwd, "second");

        await expect(reviewHistory(cwd, { base: head, head: base }))
            .rejects.toThrow("Base must be an ancestor of head.");
        await expect(reviewHistory(cwd, { base: "main", head }))
            .rejects.toThrow("Revisions must be HEAD, HEAD~<number>, or a commit SHA.");
    });
});
