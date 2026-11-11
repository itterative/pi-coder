import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    appendManifestShard,
    cosine,
    emptyManifest,
    hashKey,
    indexDir,
    namespaceFor,
    normalizeVector,
    pruneManifest,
    readManifest,
    readVectors,
    replaceShard,
    shouldCompact,
    writeManifest,
    writeShard,
} from "../../../src/tools/code/semantic/store";

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-store-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("outline semantic store", () => {
    it("round-trips vectors through a shard and manifest", () => {
        const dir = tempDir();
        const manifest = emptyManifest("model", 4, "v1");
        const a = new Float32Array([1, 0, 0, 0]);
        const b = new Float32Array([0, 1, 0, 0]);

        writeShard(dir, "shard-a", [a, b], 4);
        writeManifest(dir, replaceShard(manifest, "shard-a", ["ka", "kb"]));

        const stored = readManifest(dir);
        expect(stored).toBeDefined();
        const vectors = readVectors(dir, stored!, ["ka", "kb", "missing"]);

        expect(Array.from(vectors.get("ka")!)).toEqual([1, 0, 0, 0]);
        expect(Array.from(vectors.get("kb")!)).toEqual([0, 1, 0, 0]);
        expect(vectors.has("missing")).toBe(false);
    });

    it("replaces a shard's entries without touching other shards", () => {
        const manifest = replaceShard(emptyManifest("model", 2, "v1"), "one", ["a", "b"]);

        expect(manifest.shards.one.count).toBe(2);

        const replaced = replaceShard(manifest, "one", ["c"]);

        expect(Object.keys(replaced.entries)).toEqual(["c"]);
        expect(replaced.shards.one.count).toBe(1);
    });

    it("re-reads the manifest when a shard is appended", () => {
        const dir = tempDir();
        const manifest = emptyManifest("model", 2, "v1");

        writeManifest(dir, replaceShard(manifest, "first", ["a"]));
        expect(Object.keys(readManifest(dir)!.entries)).toEqual(["a"]);

        appendManifestShard(dir, manifest, "second", ["b"]);

        expect(Object.keys(readManifest(dir)!.entries).toSorted()).toEqual(["a", "b"]);
    });

    it("replays a large manifest in one pass", () => {
        // Rebuilding the entries object per line - what the replay used to do - copies ~108M entries for this
        // fixture and times the test out; one in-place pass finishes in tens of milliseconds.
        const dir = tempDir();
        const shards = 1200;
        const keysPerShard = 150;
        const lines = [
            JSON.stringify({ version: 1, modelId: "model", dims: 4, textVersion: "v1" }),
        ];

        for (let shard = 0; shard < shards; shard += 1) {
            const keys = Array.from({ length: keysPerShard }, (_, key) => `s${shard}-k${key}`);

            lines.push(JSON.stringify({ shard: `shard-${shard}`, keys }));
        }

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "manifest.jsonl"), `${lines.join("\n")}\n`);

        const manifest = readManifest(dir);

        expect(Object.keys(manifest!.entries)).toHaveLength(shards * keysPerShard);
        expect(manifest!.shards["shard-7"]?.count).toBe(keysPerShard);
    });

    it("prunes dead keys and deletes their shard files", () => {
        const dir = tempDir();
        writeShard(dir, "keep", [new Float32Array([1, 0])], 2);
        writeShard(dir, "drop", [new Float32Array([0, 1])], 2);
        const manifest = replaceShard(
            replaceShard(emptyManifest("model", 2, "v1"), "keep", ["a"]),
            "drop",
            ["b"],
        );

        const pruned = pruneManifest(dir, manifest, new Set(["a"]));

        expect(Object.keys(pruned.entries)).toEqual(["a"]);
        expect(Object.keys(pruned.shards)).toEqual(["keep"]);
        expect(fs.existsSync(path.join(dir, "shards", "drop.bin"))).toBe(false);
    });

    it("only compacts once dead entries clear both floors", () => {
        // Absolute floor: a handful of strays in a small index is not worth a manifest rewrite.
        expect(shouldCompact(63, 10)).toBe(false);
        expect(shouldCompact(64, 100)).toBe(true);
        // Relative floor: a large healthy index is not rewritten over a few dead entries.
        expect(shouldCompact(64, 6_400)).toBe(false);
        expect(shouldCompact(640, 6_400)).toBe(true);
    });

    it("treats a missing shard as absent vectors", () => {
        const dir = tempDir();
        const manifest = replaceShard(emptyManifest("model", 2, "v1"), "gone", ["a"]);

        expect(readVectors(dir, manifest, ["a"]).size).toBe(0);
    });

    it("separates namespaces by source kind", () => {
        const local = namespaceFor("local", "/repo", "model", "v1");
        const container = namespaceFor("container", "/repo", "model", "v1");

        expect(local).not.toBe(container);
        expect(indexDir("/root", local)).toContain(local);
    });

    it("hashes identical text to the same key", () => {
        expect(hashKey("same")).toBe(hashKey("same"));
        expect(hashKey("same")).not.toBe(hashKey("different"));
    });

    it("normalizes before comparing so cosine is a dot product", () => {
        const vector = normalizeVector(new Float32Array([3, 4]));

        expect(Array.from(vector)).toHaveLength(2);
        expect(vector[0]).toBeCloseTo(0.6);
        expect(vector[1]).toBeCloseTo(0.8);
        expect(cosine(vector, vector)).toBeCloseTo(1);
    });
});
