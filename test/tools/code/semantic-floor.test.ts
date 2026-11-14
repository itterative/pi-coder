import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { buildIndex, createSemanticSearch } from "../../../src/tools/code/semantic";
import { modelProfile } from "../../../src/tools/code/semantic/profiles";
import {
    aboveFloor,
    DENSE_FLOOR,
    RELATED_FLOOR_RATIO,
} from "../../../src/tools/code/semantic/rank";
import type { EmbedRuntime } from "../../../src/tools/code/semantic/runtime";
import { writeShard } from "../../../src/tools/code/semantic/store";
import type { ParsedFile } from "../../../src/tools/code/types";
import { MemoryCodeSource } from "../../helpers/code-source";

const dirs: string[] = [];
const ROOT = "/project";
const profile = modelProfile();

beforeEach(() => {
    clearCodeCache();
});

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-floor-"));

    dirs.push(dir);

    return dir;
}

describe("outline related floor", () => {
    it("keeps the rows near the best score and drops the rest", () => {
        expect(RELATED_FLOOR_RATIO).toBeGreaterThan(0);
        expect(
            aboveFloor([{ score: 10 }, { score: 7 }, { score: 6.4 }, { score: 1 }]),
        ).toHaveLength(2);
    });

    it("lets an absolute floor override the relative one", () => {
        // 0.7 × 0.65 is 0.455, so a relative-only floor keeps the 0.48 row; the absolute floor is what drops it.
        expect(
            aboveFloor([{ score: 0.7 }, { score: 0.48 }, { score: 0.4 }], DENSE_FLOOR),
        ).toHaveLength(1);
    });

    it("keeps nothing from a ranking with no positive score", () => {
        expect(aboveFloor([])).toEqual([]);
        expect(aboveFloor([{ score: 0 }, { score: 0 }], DENSE_FLOOR)).toEqual([]);
        expect(aboveFloor([{ score: 0 }])).toEqual([]);
    });
});

describe("outline dense channel floor", () => {
    /** A unit vector whose cosine against the query vector is exactly `value`. */
    function atCosine(value: number): Float32Array {
        const vector = new Float32Array(profile.dims);

        vector[0] = value;
        vector[1] = Math.sqrt(Math.max(0, 1 - value * value));

        return vector;
    }

    const FILES = {
        "src/alpha.ts": "export function AlphaRunner(): void {}\n",
        "src/delta.ts": "export function DeltaHelper(): void {}\n",
        "src/gamma.ts": "export function GammaFiller(): void {}\n",
        "src/beta.ts": "export function BetaFiller(): void {}\n",
    } as const;

    const COSINES = new Map([
        ["alpharunner", 0.7],
        ["deltahelper", 0.6],
        ["gammafiller", 0.48],
        ["betafiller", 0.4],
    ]);

    async function parsedFiles(): Promise<ParsedFile[]> {
        const source = new MemoryCodeSource(ROOT, FILES);
        const parsed: ParsedFile[] = [];

        for (const relative of Object.keys(FILES)) {
            const loaded = await loadParsedFile(source, `${ROOT}/${relative}`);

            if (loaded.kind !== "parsed") {
                throw new Error(`expected ${relative} to parse`);
            }

            parsed.push(loaded.parsed);
        }

        return parsed;
    }

    /** Seeds a real index whose vectors sit at chosen cosines against the fixed query vector. */
    function fakeRuntime(): EmbedRuntime {
        return {
            embedQuery: async () => atCosine(1),
            build: async (indexDirPath, files, onProgress, _signal, onShard) => {
                const shards: Array<{ shard: string; keys: string[] }> = [];
                let done = 0;

                for (const file of files) {
                    const vectors = file.entries.map((entry) => {
                        const name = entry.text.toLowerCase();
                        const cosine = Array.from(COSINES).find(([key]) => name.includes(key))?.[1];

                        if (cosine === undefined) {
                            throw new Error(`no cosine fixture for ${entry.key}: ${entry.text}`);
                        }

                        return atCosine(cosine);
                    });
                    const keys = file.entries.map((entry) => entry.key);

                    writeShard(indexDirPath, file.shard, vectors, profile.dims);
                    shards.push({ shard: file.shard, keys });
                    onShard?.({ shard: file.shard, keys });
                    done += vectors.length;
                    onProgress(done, done);
                }

                return shards;
            },
            dispose: () => undefined,
        };
    }

    it("drops a dense row below the absolute floor", async () => {
        const modelDir = tempDir();
        const files = await parsedFiles();
        const runtime = fakeRuntime();

        await buildIndex({ sourceKind: "local", root: ROOT, modelDir, files, runtime });

        const search = createSemanticSearch({
            mode: "hybrid",
            modelDir,
            runtime,
            artifactsReady: () => true,
            autoRefresh: false,
        });
        const ranked = await search.rank({
            query: "runner",
            root: ROOT,
            sourceKind: "local",
            files,
            similarityOnly: true,
        });
        const names = ranked.map((entry) => entry.declaration?.name);

        // 0.7 and 0.6 clear both floors. 0.48 clears the relative one (0.7 × 0.65 = 0.455) and fails the absolute
        // one, which is what `DENSE_FLOOR` is for; 0.4 fails both.
        expect(names).toContain("AlphaRunner");
        expect(names).toContain("DeltaHelper");
        expect(names).not.toContain("GammaFiller");
        expect(names).not.toContain("BetaFiller");
    });
});
