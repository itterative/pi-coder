import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import {
    buildIndex,
    countEmbeddings,
    createSemanticSearch,
    embeddingKey,
} from "../../../src/tools/code/semantic";
import { MODEL_DIMS, MODEL_ID } from "../../../src/tools/code/semantic/config";
import { acquireIndexLock } from "../../../src/tools/code/semantic/lock";
import {
    buildWorkerCount,
    refreshWorkerCount,
    type EmbedRuntime,
} from "../../../src/tools/code/semantic/runtime";
import {
    indexDir,
    namespaceFor,
    readManifest,
    readVectors,
    writeManifest,
    writeShard,
} from "../../../src/tools/code/semantic/store";
import { EMBED_TEXT_VERSION, embedTextOf } from "../../../src/tools/code/text";
import type { ParsedFile } from "../../../src/tools/code/types";
import { MemoryCodeSource } from "../../helpers/code-source";

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-build-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

beforeEach(() => {
    clearCodeCache();
});

/** Deterministic stand-in for the model, so store and fusion logic are testable without the runtime. */
function vectorFor(text: string): Float32Array {
    const digest = createHash("sha256").update(text).digest();
    const vector = new Float32Array(MODEL_DIMS);

    for (let index = 0; index < MODEL_DIMS; index += 1) {
        vector[index] = (digest[index % digest.length] ?? 0) / 255 - 0.5;
    }

    return vector;
}

function fakeRuntime(queryVector: Float32Array): EmbedRuntime {
    return {
        embedQuery: async () => queryVector,
        build: async (indexDirPath, files, onProgress, _signal, onShard) => {
            const shards: Array<{ shard: string; keys: string[] }> = [];
            let done = 0;

            for (const file of files) {
                const vectors = file.entries.map((entry) => vectorFor(entry.text));
                const keys = file.entries.map((entry) => entry.key);

                writeShard(indexDirPath, file.shard, vectors, MODEL_DIMS);
                shards.push({ shard: file.shard, keys });
                onShard?.({ shard: file.shard, keys });
                done += file.entries.length;
                onProgress(done, done);
            }

            return shards;
        },
        dispose: () => undefined,
    };
}

const FILES = {
    "src/hint.ts": `/** Keeps recently used cache entries alive. */
export function promote(key: string): string {
    return key;
}

/** A plain unrelated helper. */
export function other(): void {}
`,
    "src/spare.ts": `/** Formats a duration for display. */
export function formatDuration(seconds: number): string {
    return String(seconds);
}
`,
};

async function parseBulk(
    count: number,
    tag: string,
    edited: readonly number[] = [],
): Promise<ParsedFile[]> {
    const body = Array.from({ length: count }, (_, index) => {
        const mark = edited.includes(index) ? `${tag} edited` : tag;

        return `/** ${mark} declaration ${index}. */\nexport function value${index}(): number {\n    return ${index};\n}\n`;
    }).join("\n");
    const source = new MemoryCodeSource("/project", { "src/bulk.ts": body });
    const loaded = await loadParsedFile(source, "/project/src/bulk.ts");

    if (loaded.kind !== "parsed") {
        throw new Error("expected a parsed file");
    }

    return [loaded.parsed];
}

function manifestSize(options: { sourceKind: string; root: string; modelDir: string }): number {
    const namespace = namespaceFor(options.sourceKind, options.root, MODEL_ID, EMBED_TEXT_VERSION);
    const manifest = readManifest(indexDir(options.modelDir, namespace));

    return Object.keys(manifest?.entries ?? {}).length;
}

async function parseFiles(): Promise<ParsedFile[]> {
    const source = new MemoryCodeSource("/project", FILES);
    const parsed: ParsedFile[] = [];

    for (const relative of Object.keys(FILES)) {
        const loaded = await loadParsedFile(source, `/project/${relative}`);

        if (loaded.kind !== "parsed") {
            throw new Error("expected a parsed file");
        }

        parsed.push(loaded.parsed);
    }

    return parsed;
}

describe("outline semantic worker budget", () => {
    it("caps a refresh at half the cores, and never above four", () => {
        // Half the cores leaves the warm serve child a core of its own on a small machine.
        expect(refreshWorkerCount(16)).toBe(4);
        expect(refreshWorkerCount(8)).toBe(4);
        expect(refreshWorkerCount(4)).toBe(2);
        expect(refreshWorkerCount(2)).toBe(1);
        expect(refreshWorkerCount(1)).toBe(1);
        expect(refreshWorkerCount()).toBeGreaterThanOrEqual(1);
        expect(refreshWorkerCount()).toBeLessThanOrEqual(4);
    });

    it("still honours the explicit worker override for full builds", () => {
        expect(buildWorkerCount({ PI_CODER_OUTLINE_WORKERS: "3" } as NodeJS.ProcessEnv)).toBe(3);
        expect(buildWorkerCount({ PI_CODER_OUTLINE_WORKERS: "999" } as NodeJS.ProcessEnv)).toBe(32);
    });

    it("passes the refresh budget to the build a search starts", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };

        // Index only the second file, so the search below finds the first one missing.
        await buildIndex({
            ...options,
            files: [files[1]],
            runtime: fakeRuntime(vectorFor("query")),
        });

        let recorded: number | undefined;
        const recording: EmbedRuntime = {
            ...fakeRuntime(vectorFor("query")),
            async build(dir, jobs, onProgress, signal, onShard, maxWorkers) {
                recorded = maxWorkers;

                return fakeRuntime(vectorFor("query")).build(
                    dir,
                    jobs,
                    onProgress,
                    signal,
                    onShard,
                );
            },
        };
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime: recording,
            artifactsReady: () => true,
        });

        await semantic.rank({
            query: "cache entries",
            root: "/project/src",
            sourceKind: "local",
            files,
        });

        await vi.waitFor(() => {
            expect(recorded).toBe(refreshWorkerCount());
        });
    });
});

describe("outline semantic build", () => {
    it("embeds missing declarations and reuses them on a second run", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = {
            sourceKind: "local",
            root: "/project/src",
            modelDir: root,
            files,
            runtime,
        };

        const first = await buildIndex(options);

        expect(first.embedded).toBeGreaterThan(0);
        expect(first.live).toBe(first.embedded);

        const second = await buildIndex(options);

        expect(second.embedded).toBe(0);
        expect(second.live).toBe(first.live);
    });

    it("stores vectors under content keys", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const target = files[0].all.find((declaration) => declaration.name === "promote")!;
        const key = embeddingKey(files[0], target);

        await buildIndex({
            sourceKind: "local",
            root: "/project/src",
            modelDir: root,
            files,
            runtime: fakeRuntime(vectorFor("query")),
        });

        const namespace = namespaceFor("local", "/project/src", MODEL_ID, EMBED_TEXT_VERSION);
        const manifest = readManifest(indexDir(root, namespace))!;

        expect(manifest.entries[key]).toBeDefined();
        const vectors = readVectors(indexDir(root, namespace), manifest, [key]);

        expect(Array.from(vectors.get(key)!)).toEqual(
            Array.from(vectorFor(embedTextOf(files[0], target))),
        );
    });

    it("fuses dense hits below BM25 when a query matches no name", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const target = files[0].all.find((declaration) => declaration.name === "promote")!;

        await buildIndex({
            sourceKind: "local",
            root: "/project/src",
            modelDir: root,
            files,
            runtime: fakeRuntime(vectorFor("query")),
        });

        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime: fakeRuntime(vectorFor(embedTextOf(files[0], target))),
            artifactsReady: () => true,
        });
        const ranked = await semantic.rank({
            query: "keep entries alive",
            root: "/project/src",
            sourceKind: "local",
            files,
        });

        expect(ranked[0]?.declaration.name).toBe("promote");
    });

    it("ignores a namespace written by a model of another width", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const target = files[0].all.find((declaration) => declaration.name === "promote")!;
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };

        await buildIndex({ ...options, runtime: fakeRuntime(vectorFor("query")) });

        // The namespace hash carries the model id and text version, never the width, so a wrong-dims index lands in
        // the same directory and would otherwise be accepted and read with the wrong stride.
        const namespace = namespaceFor("local", "/project/src", MODEL_ID, EMBED_TEXT_VERSION);
        const dir = indexDir(root, namespace);
        writeManifest(dir, { ...readManifest(dir)!, dims: MODEL_DIMS - 1 });

        const stale: Array<{ missing: number; refreshing: boolean }> = [];
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime: fakeRuntime(vectorFor(embedTextOf(files[0], target))),
            artifactsReady: () => true,
            autoRefresh: false,
            onStale: (value) => stale.push(value),
        });
        const ranked = await semantic.rank({
            query: "zzz qqq",
            root: "/project/src",
            sourceKind: "local",
            files,
        });

        // Rejected outright: BM25 has nothing for this query either, so an empty result means the dense channel never
        // ran — the namespace was not read with the wrong stride.
        expect(ranked).toEqual([]);
        expect(stale).toEqual([]);
    });

    it("treats a vector of another width as missing instead of ranking it", async () => {
        const root = tempDir();
        const files = await parseFiles();

        await buildIndex({
            sourceKind: "local",
            root: "/project/src",
            modelDir: root,
            files,
            runtime: fakeRuntime(vectorFor("query")),
        });

        const stale: Array<{ missing: number; refreshing: boolean }> = [];
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            // A query vector of a different width than the stored ones: the pair cannot be compared, and truncating
            // would score noise rather than reporting the mismatch.
            runtime: fakeRuntime(new Float32Array(4)),
            artifactsReady: () => true,
            autoRefresh: false,
            onStale: (value) => stale.push(value),
        });
        const ranked = await semantic.rank({
            query: "zzz qqq",
            root: "/project/src",
            sourceKind: "local",
            files,
        });

        expect(ranked).toEqual([]);
        expect(stale).toEqual([
            { missing: files.reduce((sum, file) => sum + file.all.length, 0), refreshing: false },
        ]);
    });

    it("counts what an index build still has to embed", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };
        const before = countEmbeddings(options);

        expect(before.missing).toBe(before.live);
        expect(before.missing).toBeGreaterThan(0);

        await buildIndex({ ...options, runtime: fakeRuntime(vectorFor("query")) });

        expect(countEmbeddings(options)).toEqual({ live: before.live, missing: 0, files: 0 });
    });

    it("keeps shards published before a failed build", async () => {
        const root = tempDir();
        const files = await parseFiles();
        let published = 0;
        const failing: EmbedRuntime = {
            embedQuery: async () => vectorFor("query"),
            build: async (indexDirPath, jobs, _onProgress, _signal, onShard) => {
                const first = jobs[0];
                const keys = first.entries.map((entry) => entry.key);

                writeShard(
                    indexDirPath,
                    first.shard,
                    first.entries.map((entry) => vectorFor(entry.text)),
                    MODEL_DIMS,
                );
                onShard?.({ shard: first.shard, keys });
                published = keys.length;

                throw new Error("interrupted");
            },
            dispose: () => undefined,
        };
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };

        await expect(buildIndex({ ...options, runtime: failing })).rejects.toThrow("interrupted");

        const after = countEmbeddings(options);

        expect(published).toBeGreaterThan(0);
        expect(after.live - after.missing).toBe(published);
    });

    it("refreshes declarations a search found missing, without pruning the rest", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };

        // Index only the second file: the search then sees some vectors, but not the first file's.
        await buildIndex({ ...options, files: [files[1]], runtime });

        const stale: Array<{ missing: number; refreshing: boolean }> = [];
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime: fakeRuntime(vectorFor("query")),
            onStale: (value) => stale.push(value),
            artifactsReady: () => true,
        });

        await semantic.rank({
            query: "keeps recently used cache entries alive",
            root: "/project/src",
            sourceKind: "local",
            files,
        });

        expect(stale).toEqual([{ missing: files[0].all.length, refreshing: true }]);
        await vi.waitFor(() => {
            expect(countEmbeddings(options).missing).toBe(0);
        });
    });

    it("does not schedule a refresh while another process holds the build lock", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };

        // Index only the second file, so the search below finds the first one missing.
        await buildIndex({
            ...options,
            files: [files[1]],
            runtime: fakeRuntime(vectorFor("query")),
        });

        const namespace = namespaceFor("local", "/project/src", MODEL_ID, EMBED_TEXT_VERSION);
        const lock = acquireIndexLock(indexDir(root, namespace))!;
        const stale: Array<{ missing: number; refreshing: boolean }> = [];
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime: fakeRuntime(vectorFor("query")),
            artifactsReady: () => true,
            onStale: (value) => stale.push(value),
        });

        try {
            await semantic.rank({
                query: "cache entries",
                root: "/project/src",
                sourceKind: "local",
                files,
            });
        } finally {
            lock.release();
        }

        // Reported as not indexed rather than as a background refresh that would immediately bounce off the lock.
        expect(stale).toEqual([{ missing: files[0].all.length, refreshing: false }]);
    });

    it("does not prune entries outside an incremental refresh", async () => {
        const root = tempDir();
        const files = await parseFiles();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, files };

        await buildIndex({ ...options, files: [files[0]], runtime });
        await buildIndex({ ...options, files: [files[1]], runtime, prune: false });

        expect(countEmbeddings(options).missing).toBe(0);
    });

    it("compacts dead entries when a root-covering build replaces them", async () => {
        const root = tempDir();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, runtime };

        await buildIndex({ ...options, files: await parseBulk(70, "first") });
        expect(manifestSize(options)).toBe(70);

        // Every declaration's text changed, so all 70 old keys are dead and 70 new ones take their place.
        const replaced = await buildIndex({
            ...options,
            files: await parseBulk(70, "second"),
            prune: false,
            coversRoot: true,
        });

        expect(replaced.embedded).toBe(70);
        expect(replaced.dead).toBe(70);
        expect(replaced.pruned).toBe(true);
        expect(manifestSize(options)).toBe(70);
    });

    it("never compacts when the file set is only part of the root", async () => {
        const root = tempDir();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, runtime };

        await buildIndex({ ...options, files: await parseBulk(70, "first") });

        const bulk = await parseBulk(70, "second");
        const oneFile: ParsedFile = { ...bulk[0], all: bulk[0].all.slice(0, 1) };
        // A subdirectory search refreshes only what it parsed; the rest of the index must survive.
        const found = await buildIndex({ ...options, files: [oneFile], prune: false });

        expect(found.pruned).toBe(false);
        expect(manifestSize(options)).toBe(71);
    });

    it("leaves a few dead entries alone", async () => {
        const root = tempDir();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, runtime };

        await buildIndex({ ...options, files: await parseBulk(70, "gen") });

        // Three of seventy declarations changed: three dead entries is far below both floors, so the manifest is
        // appended to rather than rewritten.
        const partial = await buildIndex({
            ...options,
            files: await parseBulk(70, "gen", [1, 2, 3]),
            prune: false,
            coversRoot: true,
        });

        expect(partial.embedded).toBe(3);
        expect(partial.dead).toBe(3);
        expect(partial.pruned).toBe(false);
        expect(manifestSize(options)).toBe(73);
    });

    it("compacts on a search that finds nothing missing but plenty dead", async () => {
        const root = tempDir();
        const runtime = fakeRuntime(vectorFor("query"));
        const options = { sourceKind: "local", root: "/project/src", modelDir: root, runtime };

        await buildIndex({ ...options, files: await parseBulk(70, "first") });
        // Add a second generation without pruning, so the namespace holds 140 entries for 70 declarations.
        await buildIndex({
            ...options,
            files: await parseBulk(70, "second"),
            prune: false,
        });
        expect(manifestSize(options)).toBe(140);

        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime,
            artifactsReady: () => true,
        });

        await semantic.rank({
            query: "declaration",
            root: "/project/src",
            sourceKind: "local",
            files: await parseBulk(70, "second"),
        });

        // Nothing to embed, but half the namespace is dead: the search schedules a prune-only build.
        await vi.waitFor(() => {
            expect(manifestSize(options)).toBe(70);
        });
    });

    it("stays lexical when the embedding channel is off", async () => {
        const files = await parseFiles();
        const semantic = createSemanticSearch({
            mode: "bm25",
            modelDir: tempDir(),
        });
        const ranked = await semantic.rank({
            query: "cache entries",
            root: "/project/src",
            sourceKind: "local",
            files,
        });

        expect(ranked[0]?.declaration.name).toBe("promote");
    });
});
