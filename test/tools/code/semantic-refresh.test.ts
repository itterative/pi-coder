import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { buildIndex } from "../../../src/tools/code/semantic";
import { MODEL_DIMS, MODEL_ID } from "../../../src/tools/code/semantic/config";
import { projectRoots, refreshOnce, scanRoot } from "../../../src/tools/code/semantic/refresh";
import type { EmbedRuntime } from "../../../src/tools/code/semantic/runtime";
import {
    indexDir,
    namespaceFor,
    readManifest,
    writeManifest,
    writeShard,
    type IndexManifest,
} from "../../../src/tools/code/semantic/store";
import { EMBED_TEXT_VERSION } from "../../../src/tools/code/text";
import type { ParsedFile } from "../../../src/tools/code/types";
import { MemoryCodeSource } from "../../helpers/code-source";

const dirs: string[] = [];
const ROOT = "/project";

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-refresh-"));

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

function vectorFor(text: string): Float32Array {
    const digest = createHash("sha256").update(text).digest();
    const vector = new Float32Array(MODEL_DIMS);

    for (let index = 0; index < MODEL_DIMS; index += 1) {
        vector[index] = (digest[index % digest.length] ?? 0) / 255 - 0.5;
    }

    return vector;
}

/** Writes shards the way a build child would, so a test can seed a manifest without a model. */
function fakeRuntime(): EmbedRuntime {
    return {
        embedQuery: async () => vectorFor("query"),
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

async function parsedFile(files: Record<string, string>, relative: string): Promise<ParsedFile> {
    const loaded = await loadParsedFile(new MemoryCodeSource(ROOT, files), `${ROOT}/${relative}`);

    if (loaded.kind !== "parsed") {
        throw new Error(`expected ${relative} to parse`);
    }

    return loaded.parsed;
}

/** Long enough for the chunk policy, so a build plans body vectors as well as a head. */
function longSource(lines: number): string {
    const filler = Array.from(
        { length: lines },
        (_, index) => `    const value${index} = compute(${index});`,
    ).join("\n");

    return `export function long(): number {\n${filler}\n    return 0;\n}\n`;
}

const ORIGINAL = {
    "src/one.ts": `export function one(): number {\n    return 1;\n}\n`,
    "src/two.ts": `export function two(): number {\n    return 2;\n}\n`,
};

async function seededIndex(modelDir: string, sourceKind = "local"): Promise<number> {
    const files = await Promise.all([
        parsedFile(ORIGINAL, "src/one.ts"),
        parsedFile(ORIGINAL, "src/two.ts"),
    ]);

    await buildIndex({ sourceKind, root: ROOT, modelDir, files, runtime: fakeRuntime() });

    return Date.now();
}

describe("idle refresh decision", () => {
    const root = { dir: "/index/one", root: ROOT };

    it("rebuilds a root whose drift is small", async () => {
        const built: string[][] = [];
        const outcome = await refreshOnce({
            roots: [root],
            scan: async () => ({
                root: ROOT,
                changed: 1,
                files: [{ path: `${ROOT}/src/two.ts` } as ParsedFile],
                missing: 3,
            }),
            build: async (_indexed, files) => {
                built.push(files.map((file) => file.path));

                return 3;
            },
        });

        expect(outcome).toEqual({ missing: 3, rebuilt: 1, embedded: 3, overBudget: false });
        expect(built).toEqual([[`${ROOT}/src/two.ts`]]);
    });

    it("reports instead of building when the drift is too large to do unattended", async () => {
        let built = 0;
        const outcome = await refreshOnce({
            roots: [root],
            scan: async () => ({ root: ROOT, changed: 1, files: [], missing: 2_001 }),
            build: async () => {
                built += 1;

                return 0;
            },
        });

        expect(outcome).toEqual({ missing: 2_001, rebuilt: 0, embedded: 0, overBudget: true });
        expect(built).toBe(0);
    });

    it("does nothing when every root is current", async () => {
        const outcome = await refreshOnce({
            roots: [root],
            scan: async () => ({ root: ROOT, changed: 0, files: [], missing: 0 }),
            build: async () => 0,
        });

        expect(outcome).toEqual({ missing: 0, rebuilt: 0, embedded: 0, overBudget: false });
    });

    it("honours a caller's budget", async () => {
        const outcome = await refreshOnce({
            roots: [root],
            scan: async () => ({ root: ROOT, changed: 1, files: [], missing: 11 }),
            build: async () => 0,
            budget: 10,
        });

        expect(outcome.overBudget).toBe(true);
    });
});

describe("idle refresh scan", () => {
    it("counts body-chunk drift, which a head-only scan cannot see", async () => {
        const modelDir = tempDir();
        const source = longSource(200);
        const file = await parsedFile({ "src/long.ts": source }, "src/long.ts");

        await buildIndex({
            sourceKind: "local",
            root: ROOT,
            modelDir,
            files: [file],
            runtime: fakeRuntime(),
        });

        // Equal-length edit inside the body: the declaration's head text (doc, comments, signature) is unchanged, so
        // only a chunk key moves. Scanning heads alone would call this index warm.
        const edited = source.replace("compute(150)", "compute(151)");
        const touched = new MemoryCodeSource(
            ROOT,
            { "src/long.ts": edited },
            { "src/long.ts": Date.now() + 1_000 },
        );
        const finding = await scanRoot({ source: touched, root: ROOT, modelDir });

        expect(finding?.files).toHaveLength(1);
        expect(finding?.missing).toBe(1);
    });

    it("skips roots of another source kind, text version, or outside the project", async () => {
        const modelDir = tempDir();
        const builtAt = await seededIndex(modelDir);
        const indexRoot = path.join(modelDir, "index");

        // A namespace of another embed-text version, and one rooted outside the project: both are visible as
        // directories, and neither is this session's business.
        const stale = namespaceFor("local", ROOT, MODEL_ID, "code-retrieval-v0");
        const staleDir = indexDir(modelDir, stale);
        fs.mkdirSync(staleDir, { recursive: true });
        const manifest = readManifest(
            indexDir(modelDir, namespaceFor("local", ROOT, MODEL_ID, EMBED_TEXT_VERSION)),
        )!;
        const staleManifest: IndexManifest = { ...manifest, textVersion: "code-retrieval-v0" };
        writeManifest(staleDir, staleManifest);

        const elsewhere = path.join(path.dirname(modelDir), "somewhere-else");
        const outside = indexDir(
            modelDir,
            namespaceFor("local", elsewhere, MODEL_ID, EMBED_TEXT_VERSION),
        );
        fs.mkdirSync(outside, { recursive: true });
        writeManifest(outside, { ...manifest, root: elsewhere });

        const roots = projectRoots({ modelDir, cwd: ROOT, sourceKind: "local" });

        expect(roots).toEqual([
            {
                dir: indexDir(modelDir, namespaceFor("local", ROOT, MODEL_ID, EMBED_TEXT_VERSION)),
                root: ROOT,
            },
        ]);
        expect(fs.readdirSync(indexRoot)).toHaveLength(3);
        expect(builtAt).toBeGreaterThan(0);
    });

    it("includes roots under the project, not only the project itself", async () => {
        const modelDir = tempDir();
        const nested = `${ROOT}/.pi/local/fixture`;
        const manifest = emptyManifestFor(nested);

        writeManifest(
            indexDir(modelDir, namespaceFor("local", nested, MODEL_ID, EMBED_TEXT_VERSION)),
            manifest,
        );

        expect(
            projectRoots({ modelDir, cwd: ROOT, sourceKind: "local" }).map((entry) => entry.root),
        ).toEqual([nested]);
    });

    it("parses nothing when every file predates the build", async () => {
        const modelDir = tempDir();
        const builtAt = await seededIndex(modelDir);
        const source = new MemoryCodeSource(ROOT, ORIGINAL, {
            "src/one.ts": builtAt - 60_000,
            "src/two.ts": builtAt - 60_000,
        });

        const finding = await scanRoot({ source, root: ROOT, modelDir });

        expect(finding).toEqual({ root: ROOT, changed: 0, files: [], missing: 0 });
    });

    it("parses only the files written after the build, and counts what they add", async () => {
        const modelDir = tempDir();
        const builtAt = await seededIndex(modelDir);
        const edited = {
            ...ORIGINAL,
            "src/two.ts": `export function two(): number {\n    return 2;\n}\n\nexport function twoAndHalf(): number {\n    return 2;\n}\n`,
        };
        const source = new MemoryCodeSource(ROOT, edited, {
            "src/one.ts": builtAt - 60_000,
            "src/two.ts": builtAt + 60_000,
        });

        const finding = await scanRoot({ source, root: ROOT, modelDir });

        expect(finding?.changed).toBe(1);
        expect(finding?.files.map((file) => file.path)).toEqual([`${ROOT}/src/two.ts`]);
        expect(finding?.missing).toBe(1);
    });

    it("reports no missing work when a touched file still hashes to indexed text", async () => {
        const modelDir = tempDir();
        const builtAt = await seededIndex(modelDir);
        const source = new MemoryCodeSource(ROOT, ORIGINAL, {
            "src/one.ts": builtAt + 60_000,
            "src/two.ts": builtAt + 60_000,
        });

        const finding = await scanRoot({ source, root: ROOT, modelDir });

        expect(finding?.changed).toBe(2);
        expect(finding?.missing).toBe(0);
    });

    it("treats every file as changed when the manifest records no build time", async () => {
        const modelDir = tempDir();
        await seededIndex(modelDir);
        const namespace = namespaceFor("local", ROOT, MODEL_ID, EMBED_TEXT_VERSION);
        const dir = indexDir(modelDir, namespace);
        const manifest = readManifest(dir)!;
        const { builtAt: _dropped, ...withoutBuiltAt } = manifest;
        writeManifest(dir, withoutBuiltAt);

        const source = new MemoryCodeSource(ROOT, ORIGINAL);

        expect((await scanRoot({ source, root: ROOT, modelDir }))?.changed).toBe(2);
    });

    it("has nothing to say about a root this source kind never indexed", async () => {
        const modelDir = tempDir();
        await seededIndex(modelDir, "container");
        const source = new MemoryCodeSource(ROOT, ORIGINAL);

        expect(await scanRoot({ source, root: ROOT, modelDir })).toBeUndefined();
        expect(projectRoots({ modelDir, cwd: ROOT, sourceKind: "local" })).toEqual([]);
    });
});

function emptyManifestFor(root: string): IndexManifest {
    return {
        version: 1,
        modelId: MODEL_ID,
        dims: MODEL_DIMS,
        textVersion: EMBED_TEXT_VERSION,
        sourceKind: "local",
        root,
        builtAt: new Date().toISOString(),
        shards: {},
        entries: {},
    };
}
