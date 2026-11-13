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
    liveEntryKeys,
} from "../../../src/tools/code/semantic";
import { chunksOf } from "../../../src/tools/code/semantic/chunks";
import { modelProfile } from "../../../src/tools/code/semantic/profiles";
import { acquireIndexLock } from "../../../src/tools/code/semantic/lock";
import {
    MAX_JOB_ENTRIES,
    buildConcurrency,
    refreshConcurrency,
    splitJobs,
    type BuildFile,
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

/** The live model profile: fixtures are sized for whatever model this build ships. */
const profile = modelProfile();

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
    const vector = new Float32Array(profile.dims);

    for (let index = 0; index < profile.dims; index += 1) {
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

                writeShard(indexDirPath, file.shard, vectors, profile.dims);
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
    const namespace = namespaceFor(
        options.sourceKind,
        options.root,
        profile.id,
        EMBED_TEXT_VERSION,
    );
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

/** A function long enough for the chunk policy, so a build has to plan body vectors as well as a head. */
function longSource(lines: number, name = "long"): string {
    const filler = Array.from(
        { length: lines },
        (_, index) => `    const value${index} = compute(${index});`,
    ).join("\n");

    return `export function ${name}(): number {\n${filler}\n    return 0;\n}\n`;
}

async function parseOne(relative: string, source: string, mtime = 1): Promise<ParsedFile> {
    const memory = new MemoryCodeSource("/project", { [relative]: source }, { [relative]: mtime });
    const loaded = await loadParsedFile(memory, `/project/${relative}`);

    if (loaded.kind !== "parsed") {
        throw new Error("expected a parsed file");
    }

    return loaded.parsed;
}

describe("outline semantic worker budget", () => {
    it("caps a refresh at half the cores, and never above four", () => {
        // Half the cores leaves the warm serve child a core of its own on a small machine.
        expect(refreshConcurrency(16)).toBe(4);
        expect(refreshConcurrency(8)).toBe(4);
        expect(refreshConcurrency(4)).toBe(2);
        expect(refreshConcurrency(2)).toBe(1);
        expect(refreshConcurrency(1)).toBe(1);
        expect(refreshConcurrency()).toBeGreaterThanOrEqual(1);
        expect(refreshConcurrency()).toBeLessThanOrEqual(4);
    });

    it("still honours the explicit worker override for full builds", () => {
        expect(buildConcurrency({ PI_CODER_OUTLINE_WORKERS: "3" } as NodeJS.ProcessEnv)).toBe(3);
        expect(buildConcurrency({ PI_CODER_OUTLINE_WORKERS: "999" } as NodeJS.ProcessEnv)).toBe(8);
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
            async build(dir, jobs, onProgress, signal, onShard, maxConcurrency) {
                recorded = maxConcurrency?.maxConcurrency;

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
            expect(recorded).toBe(refreshConcurrency());
        });
    });
});

describe("build job splitting", () => {
    const job = (shard: string, count: number): BuildFile => ({
        shard,
        entries: Array.from({ length: count }, (_, index) => ({
            key: `${shard}-${String(index)}`,
            text: `title: src/x.cpp | text: function f${String(index)}.`,
        })),
    });

    it("leaves a file that already fits one line alone", () => {
        const files = [job("small", MAX_JOB_ENTRIES)];

        expect(splitJobs(files)).toEqual(files);
    });

    it("splits a vendored header's 1587 declarations into balanced lines", () => {
        const [only] = splitJobs([job("nlohmann", 1587)]);

        expect(only).toBeDefined();
        expect(only!.shard).toBe("nlohmann-p0");
    });

    it("keeps every entry, in order, and gives each part its own shard", () => {
        const files = splitJobs([job("nlohmann", 1587)]);
        const keys = files.flatMap((file) => file.entries.map((entry) => entry.key));

        expect(files).toHaveLength(Math.ceil(1587 / MAX_JOB_ENTRIES));
        expect(files.every((file) => file.entries.length <= MAX_JOB_ENTRIES)).toBe(true);
        expect(new Set(files.map((file) => file.shard)).size).toBe(files.length);
        expect(keys).toEqual(job("nlohmann", 1587).entries.map((entry) => entry.key));
    });

    it("splits a vendored header the build actually plans, not just the helper", async () => {
        const root = tempDir();
        const declarations = Array.from(
            { length: 1587 },
            (_, index) =>
                `int vendored_${String(index)}(int value) { return value + ${String(index)}; }`,
        ).join("\n");
        const source = new MemoryCodeSource("/project", { "vendor/json.hpp": declarations });
        const loaded = await loadParsedFile(source, "/project/vendor/json.hpp");

        if (loaded.kind !== "parsed") {
            throw new Error("expected a parsed file");
        }

        const planned: BuildFile[] = [];
        const runtime: EmbedRuntime = {
            ...fakeRuntime(vectorFor("query")),
            build: async (indexDirPath, files, onProgress, _signal, onShard) => {
                planned.push(...files);

                return await fakeRuntime(vectorFor("query")).build(
                    indexDirPath,
                    files,
                    onProgress,
                    _signal,
                    onShard,
                );
            },
        };

        await buildIndex({
            sourceKind: "local",
            root: "/project/vendor",
            modelDir: root,
            files: [loaded.parsed],
            runtime,
        });

        expect(planned.length).toBeGreaterThan(1);
        expect(planned.reduce((sum, file) => sum + file.entries.length, 0)).toBe(1587);
        expect(planned.every((file) => file.entries.length <= MAX_JOB_ENTRIES)).toBe(true);
        expect(new Set(planned.map((file) => file.shard)).size).toBe(planned.length);
    });

    it("keeps small files whole next to a split one", () => {
        const files = splitJobs([job("nlohmann", 200), job("small", 3)]);

        expect(files.at(-1)).toEqual(job("small", 3));
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

        const namespace = namespaceFor("local", "/project/src", profile.id, EMBED_TEXT_VERSION);
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
        const namespace = namespaceFor("local", "/project/src", profile.id, EMBED_TEXT_VERSION);
        const dir = indexDir(root, namespace);
        writeManifest(dir, { ...readManifest(dir)!, dims: profile.dims - 1 });

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
            {
                missing: files.reduce((sum, file) => sum + file.all.length, 0),
                refreshing: false,
                initial: false,
            },
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
                    profile.dims,
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

        expect(stale).toEqual([{ missing: files[0].all.length, refreshing: true, initial: false }]);
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

        const namespace = namespaceFor("local", "/project/src", profile.id, EMBED_TEXT_VERSION);
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
        expect(stale).toEqual([
            { missing: files[0].all.length, refreshing: false, initial: false },
        ]);
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

/**
 * A tree the parent index never covered gets its own namespace.
 *
 * This is the memory-directory case: git ignores `.pi/agent/memory`, so a repo-wide build cannot include it, and
 * the ancestor index therefore holds none of its vectors. Before these rules, such a search either appended a few
 * vectors into the parent namespace or stayed lexical forever, because `resolveIndex` found no index and the
 * "missing" count came back as zero.
 */
describe("outline semantic root ownership", () => {
    it("schedules a first build for a root with no index at all", async () => {
        const modelDir = tempDir();
        const stale: Array<{ missing: number; refreshing: boolean; initial?: boolean }> = [];
        const files = await parseBulk(4, "unindexed");
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir,
            runtime: fakeRuntime(vectorFor("query")),
            artifactsReady: () => true,
            onStale: (value) => stale.push(value),
        });
        const ranked = await semantic.rank({
            // No lexical match, so the ranking is empty until the first build lands.
            query: "zzz qqq",
            root: "/project/memory",
            sourceKind: "local",
            files,
        });

        expect(ranked).toEqual([]);
        expect(stale).toEqual([{ missing: 4, refreshing: true, initial: true }]);

        await vi.waitFor(() => {
            const namespace = namespaceFor(
                "local",
                "/project/memory",
                profile.id,
                EMBED_TEXT_VERSION,
            );

            expect(
                Object.keys(readManifest(indexDir(modelDir, namespace))?.entries ?? {}),
            ).toHaveLength(4);
        });
    });

    it("builds its own namespace instead of appending to an ancestor that holds none of its files", async () => {
        const modelDir = tempDir();
        const options = { sourceKind: "local", root: "/project", modelDir };
        const parentFiles = await parseBulk(2, "parent");

        // The parent index exists and is warm; it simply has nothing for the tree below it.
        await buildIndex({
            ...options,
            files: parentFiles,
            runtime: fakeRuntime(vectorFor("parent")),
        });

        const stale: Array<{ missing: number; refreshing: boolean; initial?: boolean }> = [];
        const childFiles = await parseBulk(3, "child");
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir,
            runtime: fakeRuntime(vectorFor("query")),
            artifactsReady: () => true,
            onStale: (value) => stale.push(value),
        });

        await semantic.rank({
            query: "zzz qqq",
            root: "/project/memory",
            sourceKind: "local",
            files: childFiles,
        });

        expect(stale).toEqual([{ missing: 3, refreshing: true, initial: true }]);

        await vi.waitFor(() => {
            const namespace = namespaceFor(
                "local",
                "/project/memory",
                profile.id,
                EMBED_TEXT_VERSION,
            );

            expect(
                Object.keys(readManifest(indexDir(modelDir, namespace))?.entries ?? {}),
            ).toHaveLength(3);
        });

        // The parent namespace is untouched: no churn, and no vectors that its own walk could never justify.
        expect(manifestSize(options)).toBe(2);
    });

    it("still refuses a first build larger than the limit, and says it is not indexed", async () => {
        const modelDir = tempDir();
        const stale: Array<{ missing: number; refreshing: boolean; initial?: boolean }> = [];
        const files = await parseBulk(4, "huge");
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir,
            runtime: fakeRuntime(vectorFor("query")),
            artifactsReady: () => true,
            // Pretend the tree is enormous: the point is the policy boundary, not the file count.
            initialBuildLimit: 2,
            onStale: (value) => stale.push(value),
        });

        await semantic.rank({
            query: "zzz qqq",
            root: "/project/huge",
            sourceKind: "local",
            files,
        });

        expect(stale).toEqual([{ missing: 4, refreshing: false, initial: true }]);
    });
});

describe("body chunks in the index", () => {
    it("plans and embeds a head plus one vector per chunk, and counts them as live", async () => {
        const root = tempDir();
        const file = await parseOne("src/long.ts", longSource(200));
        const declaration = file.all.find((candidate) => candidate.name === "long")!;
        const chunks = chunksOf(file, declaration);
        const texts: string[] = [];
        const runtime: EmbedRuntime = {
            ...fakeRuntime(vectorFor("query")),
            build: async (dir, jobs, onProgress, signal, onShard) => {
                texts.push(...jobs.flatMap((job) => job.entries.map((entry) => entry.text)));

                return await fakeRuntime(vectorFor("query")).build(
                    dir,
                    jobs,
                    onProgress,
                    signal,
                    onShard,
                );
            },
        };

        expect(chunks.length).toBeGreaterThan(1);

        const options = { sourceKind: "local", root: "/project/src", modelDir: root };
        const result = await buildIndex({ ...options, files: [file], runtime });

        expect(result.live).toBe(1 + chunks.length);
        expect(result.embedded).toBe(1 + chunks.length);
        expect(texts.some((text) => text.includes("(§1/"))).toBe(true);
        expect(liveEntryKeys([file]).size).toBe(result.live);
        expect(countEmbeddings({ ...options, files: [file] }).live).toBe(result.live);
    });

    it("re-embeds only the chunk an edit touches, and prunes the old vector", async () => {
        const root = tempDir();
        const source = longSource(200);
        const before = await parseOne("src/long.ts", source, 1);
        const beforeChunks = chunksOf(
            before,
            before.all.find((entry) => entry.name === "long")!,
        );
        const options = { sourceKind: "local", root: "/project/src", modelDir: root };

        const first = await buildIndex({
            ...options,
            files: [before],
            runtime: fakeRuntime(vectorFor("query")),
        });

        expect(first.live).toBe(1 + beforeChunks.length);

        const edited = source.replace("compute(150)", "compute(151)");
        const after = await parseOne("src/long.ts", edited, 2);
        const afterChunks = chunksOf(
            after,
            after.all.find((entry) => entry.name === "long")!,
        );
        const beforeKeys = new Set(beforeChunks.map((chunk) => chunk.key));
        const changed = afterChunks.filter((chunk) => !beforeKeys.has(chunk.key));

        expect(changed).toHaveLength(1);

        const second = await buildIndex({
            ...options,
            files: [after],
            runtime: fakeRuntime(vectorFor("query")),
        });

        expect(second.embedded).toBe(changed.length);
        expect(second.live).toBe(1 + afterChunks.length);
        expect(second.dead).toBe(changed.length);
        expect(second.pruned).toBe(true);
        expect(manifestSize(options)).toBe(second.live);
    });

    it("ranks a body chunk as its declaration and reports which chunk matched", async () => {
        const root = tempDir();
        const file = await parseOne("src/long.ts", longSource(200));
        const declaration = file.all.find((candidate) => candidate.name === "long")!;
        const chunks = chunksOf(file, declaration);
        const options = { sourceKind: "local", root: "/project/src", modelDir: root };

        await buildIndex({
            ...options,
            files: [file],
            runtime: fakeRuntime(vectorFor("query")),
        });

        const target = chunks[1]!;
        const semantic = createSemanticSearch({
            mode: "hybrid",
            modelDir: root,
            runtime: fakeRuntime(vectorFor(target.text)),
            artifactsReady: () => true,
            autoRefresh: false,
        });
        const ranked = await semantic.rank({
            query: "lifetime policy",
            root: "/project/src",
            sourceKind: "local",
            files: [file],
        });

        expect(ranked[0]?.declaration.name).toBe("long");
        expect(ranked[0]?.chunk?.index).toBe(target.index);
        expect(ranked[0]?.chunk?.startLine).toBe(target.startLine);
    });
});
