import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    MAX_WORKSPACE_CHANGES,
    parseGitStatus,
    workspaceStatusFor,
} from "../../../src/modules/decision";

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-workspace-"));
    temporaryDirectories.push(directory);
    return directory;
}

function git(directory: string, args: string[]): void {
    execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("parseGitStatus", () => {
    it("maps porcelain codes to readable statuses", () => {
        const output = [
            " M src/a.ts",
            "?? tmp/b.txt",
            "A  src/c.ts",
            " D src/d.ts",
            "R  src/old.ts -> src/new.ts",
            "UU src/conflict.ts",
            "MM src/both.ts",
        ].join("\n");

        expect(parseGitStatus(output)).toEqual([
            { status: "modified", path: "src/a.ts" },
            { status: "untracked", path: "tmp/b.txt" },
            { status: "added", path: "src/c.ts" },
            { status: "deleted", path: "src/d.ts" },
            { status: "renamed", path: "src/old.ts -> src/new.ts" },
            { status: "conflicted", path: "src/conflict.ts" },
            { status: "modified", path: "src/both.ts" },
        ]);
    });

    it("ignores blank and short lines", () => {
        expect(parseGitStatus("\n \n M x\n")).toEqual([{ status: "modified", path: "x" }]);
    });
});

describe("workspaceStatusFor", () => {
    it("reads a real repository and drops a clean tree", async () => {
        const directory = tempDirectory();
        git(directory, ["init"]);
        fs.writeFileSync(path.join(directory, "modified.txt"), "hello\n");
        git(directory, ["add", "modified.txt"]);
        git(directory, [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-m",
            "init",
        ]);
        fs.writeFileSync(path.join(directory, "modified.txt"), "changed\n");
        fs.writeFileSync(path.join(directory, "untracked.txt"), "new\n");

        expect(await workspaceStatusFor(directory)).toEqual({
            changes: [
                { status: "modified", path: "modified.txt" },
                { status: "untracked", path: "untracked.txt" },
            ],
            truncated: false,
        });

        git(directory, ["checkout", "--", "modified.txt"]);
        fs.rmSync(path.join(directory, "untracked.txt"));

        expect(await workspaceStatusFor(directory)).toBeUndefined();
    });

    it("returns undefined when the cwd is not a repository", async () => {
        expect(await workspaceStatusFor(tempDirectory())).toBeUndefined();
    });

    it("clips a long status list", async () => {
        const directory = tempDirectory();
        git(directory, ["init"]);
        for (let index = 0; index < MAX_WORKSPACE_CHANGES + 2; index += 1) {
            fs.writeFileSync(path.join(directory, `file-${index}.txt`), "x");
        }

        const workspace = await workspaceStatusFor(directory);

        expect(workspace?.changes).toHaveLength(MAX_WORKSPACE_CHANGES);
        expect(workspace?.truncated).toBe(true);
    });
});
