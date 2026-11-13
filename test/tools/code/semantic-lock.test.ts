import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { buildIndex } from "../../../src/tools/code/semantic";
import { modelProfile } from "../../../src/tools/code/semantic/profiles";
import { acquireIndexLock, indexLockHeld } from "../../../src/tools/code/semantic/lock";
import type { EmbedRuntime } from "../../../src/tools/code/semantic/runtime";
import { indexDir, namespaceFor, writeShard } from "../../../src/tools/code/semantic/store";
import { EMBED_TEXT_VERSION } from "../../../src/tools/code/text";
import { MemoryCodeSource } from "../../helpers/code-source";

/** The live model profile: fixtures are sized for whatever model this build ships. */
const profile = modelProfile();

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-lock-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function namespaceDir(modelDir: string, root: string): string {
    return indexDir(modelDir, namespaceFor("local", root, profile.id, EMBED_TEXT_VERSION));
}

/** A pid that certainly belongs to no live process: spawn one, let it exit, then reuse its number. */
function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""]);

    return child.pid ?? 0;
}

function writeLock(dir: string, holder: Record<string, unknown>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "build.lock"), JSON.stringify(holder));
}

describe("outline index build lock", () => {
    it("is exclusive until the holder releases it", () => {
        const dir = tempDir();
        const first = acquireIndexLock(dir);

        expect(first).toBeDefined();
        expect(indexLockHeld(dir)).toBe(true);
        expect(acquireIndexLock(dir)).toBeUndefined();

        first?.release();

        expect(indexLockHeld(dir)).toBe(false);
        expect(acquireIndexLock(dir)).toBeDefined();
    });

    it("takes over a lock whose process is gone", () => {
        const dir = tempDir();
        writeLock(dir, { pid: deadPid(), token: "gone", startedAt: Date.now() });

        expect(indexLockHeld(dir)).toBe(false);
        expect(acquireIndexLock(dir)).toBeDefined();
    });

    it("takes over an old lock even when its pid looks alive", () => {
        const dir = tempDir();
        // Our own pid is alive; only the age can make this one abandoned.
        writeLock(dir, { pid: process.pid, token: "old", startedAt: Date.now() - 3 * 60 * 60_000 });

        expect(indexLockHeld(dir)).toBe(false);
        expect(acquireIndexLock(dir)).toBeDefined();
    });

    it("leaves another writer's lock alone when it is live", () => {
        const dir = tempDir();
        writeLock(dir, { pid: process.pid, token: "someone-else", startedAt: Date.now() });

        expect(acquireIndexLock(dir)).toBeUndefined();
        // Still intact, so the owner can still release it.
        expect(indexLockHeld(dir)).toBe(true);
    });

    it("only the owner can release", () => {
        const dir = tempDir();
        const lock = acquireIndexLock(dir)!;

        // Simulate a takeover: someone replaced the lock file after it looked abandoned.
        writeLock(dir, { pid: process.pid, token: "new-owner", startedAt: Date.now() });
        lock.release();

        expect(indexLockHeld(dir)).toBe(true);
    });

    it("refuses to build while another build holds the namespace", async () => {
        const dir = tempDir();
        const lock = acquireIndexLock(namespaceDir(dir, "/project/src"))!;

        try {
            await expect(
                buildIndex({
                    sourceKind: "local",
                    root: "/project/src",
                    modelDir: dir,
                    files: [],
                    runtime: fakeRuntime(),
                }),
            ).rejects.toThrow(/another outline build/);
        } finally {
            lock.release();
        }
    });

    it("releases the lock when a build finishes or throws", async () => {
        const dir = tempDir();
        const files = await parsedFile();

        await buildIndex({
            sourceKind: "local",
            root: "/project/src",
            modelDir: dir,
            files,
            runtime: fakeRuntime(),
        });

        expect(indexLockHeld(namespaceDir(dir, "/project/src"))).toBe(false);

        // A changed doc comment is a new key, so this build has work to do and reaches the worker.
        await expect(
            buildIndex({
                sourceKind: "local",
                root: "/project/src",
                modelDir: dir,
                files: await parsedFile("Edited helper."),
                runtime: {
                    ...fakeRuntime(),
                    build: async () => {
                        throw new Error("worker died");
                    },
                },
            }),
        ).rejects.toThrow("worker died");

        // A failed build must not leave the namespace locked for the rest of the session.
        expect(indexLockHeld(namespaceDir(dir, "/project/src"))).toBe(false);
    });

    it("scopes the lock to one namespace, so another root can build", () => {
        const dir = tempDir();
        const first = acquireIndexLock(namespaceDir(dir, "/project/src"));

        expect(first).toBeDefined();
        expect(acquireIndexLock(namespaceDir(dir, "/project/docs"))).toBeDefined();
    });
});

function fakeRuntime(): EmbedRuntime {
    return {
        embedQuery: async () => new Float32Array(profile.dims),
        build: async (indexDirPath, jobs, onProgress, _signal, onShard) => {
            const shards = [];

            for (const [index, file] of jobs.entries()) {
                const vectors = file.entries.map(() => new Float32Array(profile.dims));
                const keys = file.entries.map((entry) => entry.key);

                writeShard(indexDirPath, file.shard, vectors, profile.dims);
                shards.push({ shard: file.shard, keys });
                onShard?.({ shard: file.shard, keys });
                onProgress((index + 1) * file.entries.length, jobs.length);
            }

            return shards;
        },
        dispose: () => undefined,
    };
}

async function parsedFile(doc = "One helper.") {
    clearCodeCache();

    const source = new MemoryCodeSource("/project", {
        "src/one.ts": `/** ${doc} */\nexport function one(): void {}\n`,
    });
    const loaded = await loadParsedFile(source, "/project/src/one.ts");

    if (loaded.kind !== "parsed") {
        throw new Error("expected a parsed file");
    }

    return [loaded.parsed];
}
