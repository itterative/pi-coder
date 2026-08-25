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
    git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
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
