import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runDigest } from "../../../src/tools/code/digest";
import { runSearch } from "../../../src/tools/code/search";
import { LocalCodeSource } from "../../../src/tools/code/source";

const roots: string[] = [];

function tempDir(name: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-coder-roots-${name}-`));

    roots.push(directory);

    return directory;
}

function write(root: string, relative: string, content: string): void {
    const target = path.join(root, relative);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

beforeEach(() => {
    clearCodeCache();
});

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe("outline read roots", () => {
    it("refuses a path outside the working directory when nothing declared it", async () => {
        const cwd = tempDir("cwd");
        const outside = tempDir("outside");

        write(outside, "memory/topic.md", "# Topic\n\nProse.\n");

        const source = new LocalCodeSource(cwd);

        await expect(source.assertReadable(path.join(outside, "memory"))).rejects.toThrow(
            "outside the working directory",
        );
    });

    it("accepts a declared root, and searches it literally", async () => {
        const cwd = tempDir("cwd");
        const outside = tempDir("outside");

        // A git-ignored tree is the case that matters: the user declared it, the walker would otherwise skip it.
        write(outside, ".gitignore", "*.md\n");
        write(
            outside,
            "memory/topic.md",
            "# Ledger retention\n\nCeiling arithmetic over the tile budget.\n",
        );

        const source = new LocalCodeSource(cwd, () => [outside]);

        await expect(source.assertReadable(path.join(outside, "memory"))).resolves.toBeUndefined();

        const result = await runSearch(source, {
            action: "search",
            path: path.join(outside, "memory"),
            query: "ceiling arithmetic",
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain("Ledger retention");
    });

    it("expands `~` in a declared root instead of reading it as a relative path", async () => {
        const cwd = tempDir("cwd");
        const home = tempDir("home");
        const previousHome = process.env.HOME;

        write(home, ".pi/agent/memory/notes.md", "# Notes\n\nText.\n");
        process.env.HOME = home;

        try {
            const source = new LocalCodeSource(cwd, () => ["~/.pi/agent/memory"]);

            await expect(
                source.assertReadable(path.join(home, ".pi/agent/memory")),
            ).resolves.toBeUndefined();
        } finally {
            process.env.HOME = previousHome;
        }
    });

    it("reports an unreadable declaration instead of failing the whole call", async () => {
        const cwd = tempDir("cwd");

        write(cwd, "src/a.cpp", "void alpha();\n");

        const source = new LocalCodeSource(cwd, () => [path.join(cwd, "does-not-exist")]);
        const result = await runDigest(source, { action: "digest", path: "src" });

        expect(result.text).toContain("alpha");
    });
});
