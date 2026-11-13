import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    buildConcurrency,
    createEmbedRuntime,
    MAX_TEXT_CHARS,
    refreshConcurrency,
} from "../../../src/tools/code/semantic/runtime";
import {
    devicePreference,
    extractTarGz,
    hasVulkanDevice,
    llamaArtifacts,
    llamaBinary,
    llamaBundleDir,
    llamaSupported,
    resetLlamaDevice,
    selectLlamaDevice,
} from "../../../src/tools/code/semantic/llamacpp";
import { modelProfile, PROFILES } from "../../../src/tools/code/semantic/profiles";
import { startEmbedServer } from "../../../src/tools/code/semantic/server";
import {
    createLlamaDouble,
    llamaDoubleEnv,
    type LlamaDouble,
} from "../../helpers/llama-server-double";

const dirs: string[] = [];
const ENV_KEYS = [
    "PI_CODER_OUTLINE_LLAMA_SERVER",
    "PI_CODER_OUTLINE_MODEL_FILE",
    "PI_CODER_OUTLINE_MODEL",
    "PI_CODER_OUTLINE_DEVICE",
    "PI_CODER_OUTLINE_WORKERS",
    "FAKE_LLAMA_DIMS",
    "FAKE_LLAMA_LOG",
    "FAKE_LLAMA_FAIL_START",
] as const;
const saved = new Map<string, string | undefined>();

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-llama-"));

    dirs.push(dir);

    return dir;
}

beforeEach(() => {
    for (const key of ENV_KEYS) {
        saved.set(key, process.env[key]);
    }

    resetLlamaDevice();
});

afterEach(() => {
    for (const [key, value] of saved) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    saved.clear();
    resetLlamaDevice();

    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** One tar header, padded to 512 bytes: enough for the fields `extractTarGz` reads. */
function tarHeader(input: {
    name: string;
    size?: number;
    type?: string;
    link?: string;
    mode?: number;
}): Buffer {
    const header = Buffer.alloc(512);

    header.write(input.name, 0, 100, "utf8");
    header.write((input.mode ?? 0o644).toString(8).padStart(7, "0"), 100, 8, "utf8");
    header.write("0000000", 108, 8, "utf8");
    header.write("0000000", 116, 8, "utf8");
    header.write((input.size ?? 0).toString(8).padStart(11, "0"), 124, 12, "utf8");
    header.write("00000000000", 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write(input.type ?? "0", 156, 1, "utf8");
    header.write(input.link ?? "", 157, 100, "utf8");
    header.write("ustar", 257, 6, "utf8");
    header.write("00", 263, 3, "utf8");

    return header;
}

function tarEntry(input: { name: string; body?: string; type?: string; link?: string }): Buffer {
    const body = Buffer.from(input.body ?? "");

    return Buffer.concat([
        tarHeader({ ...input, size: body.length }),
        body,
        Buffer.alloc((512 - (body.length % 512)) % 512),
    ]);
}

describe("llama.cpp bundles", () => {
    it("pins an archive per device on a measured platform", () => {
        const specs = llamaArtifacts("linux", "x64");

        expect(specs).toHaveLength(2);
        expect(specs.map((spec) => spec.path)).toEqual([
            "llama/b12360/ubuntu-vulkan-x64.tar.gz",
            "llama/b12360/ubuntu-x64.tar.gz",
        ]);

        for (const spec of specs) {
            expect(spec.url).toContain("github.com/ggml-org/llama.cpp/releases/download/b12360");
            expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(spec.bytes).toBeGreaterThan(20_000_000);
        }
    });

    it("offers nothing on a platform it has not measured", () => {
        expect(llamaSupported("darwin", "arm64")).toBe(false);
        expect(llamaArtifacts("darwin", "arm64")).toEqual([]);
        expect(llamaArtifacts("linux", "arm64")).toEqual([]);
    });

    it("unpacks the archive under the state directory, stripping the top-level folder", () => {
        const dir = tempDir();
        const archive = path.join(dir, "bundle.tar.gz");
        const dest = llamaBundleDir(dir, "cpu");

        fs.writeFileSync(
            archive,
            zlib.gzipSync(
                Buffer.concat([
                    tarEntry({ name: "llama-b12360-bin-ubuntu-x64/", type: "5" }),
                    tarEntry({
                        name: "llama-b12360-bin-ubuntu-x64/llama-server",
                        body: "#!/bin/sh\n",
                    }),
                    tarEntry({
                        name: "llama-b12360-bin-ubuntu-x64/libllama.so",
                        type: "2",
                        link: "libllama.so.1",
                    }),
                    Buffer.alloc(1024),
                ]),
            ),
        );

        extractTarGz(archive, dest, 1);

        expect(fs.readFileSync(path.join(dest, "llama-server"), "utf8")).toBe("#!/bin/sh\n");
        expect(fs.readlinkSync(path.join(dest, "libllama.so"))).toBe("libllama.so.1");
        expect(llamaBinary(dir, "cpu")).toBe(path.join(dest, "llama-server"));
    });

    it("refuses an archive entry that escapes the destination", () => {
        const dir = tempDir();
        const archive = path.join(dir, "evil.tar.gz");
        const dest = path.join(dir, "out");

        fs.writeFileSync(
            archive,
            zlib.gzipSync(
                Buffer.concat([
                    tarEntry({ name: "pkg/../../escaped.txt", body: "no" }),
                    tarEntry({ name: "pkg/kept.txt", body: "yes" }),
                ]),
            ),
        );

        extractTarGz(archive, dest, 1);

        expect(fs.existsSync(path.join(dir, "escaped.txt"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "..", "escaped.txt"))).toBe(false);
        expect(fs.readFileSync(path.join(dest, "kept.txt"), "utf8")).toBe("yes");
    });

    it("treats a software rasteriser as no device at all", async () => {
        const dir = tempDir();
        const software = path.join(dir, "software.sh");
        const hardware = path.join(dir, "hardware.sh");

        fs.writeFileSync(
            software,
            '#!/bin/sh\necho "Available devices:"\necho "  Vulkan0: llvmpipe (LLVM 19.1.7, 256 bits) (1 MiB, 1 MiB free)"\n',
        );
        fs.writeFileSync(
            hardware,
            '#!/bin/sh\necho "Available devices:"\necho "  Vulkan0: AMD Radeon Graphics (RADV GFX1201) (16304 MiB, 953 MiB free)"\n',
        );
        fs.chmodSync(software, 0o755);
        fs.chmodSync(hardware, 0o755);

        expect(await hasVulkanDevice(software)).toBe(false);
        expect(await hasVulkanDevice(hardware)).toBe(true);
        expect(await hasVulkanDevice(path.join(dir, "absent"))).toBe(false);
    });

    it("lets the environment replace the binary outright", async () => {
        const dir = tempDir();
        const double = createLlamaDouble();

        dirs.push(double.dir);
        process.env.PI_CODER_OUTLINE_LLAMA_SERVER = double.binary;

        // The override replaces the binary, not the decision: the configured build device still applies.
        const auto = await selectLlamaDevice(dir);

        expect(auto.binary).toBe(path.resolve(double.binary));
        expect(auto.device).toBe("vulkan");

        process.env.PI_CODER_OUTLINE_DEVICE = "cpu";
        resetLlamaDevice();

        const pinned = await selectLlamaDevice(dir);

        expect(pinned.device).toBe("cpu");
        expect(pinned.binary).toBe(path.resolve(double.binary));
    });

    it("falls back to the cpu bundle when the Vulkan binary is not unpacked", async () => {
        const dir = tempDir();
        const binary = llamaBinary(dir, "cpu");

        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "#!/bin/sh\n");
        fs.chmodSync(binary, 0o755);

        const choice = await selectLlamaDevice(dir);

        expect(choice.device).toBe("cpu");
        expect(choice.reason).toContain("Vulkan bundle not installed");
    });
});

describe("profiles", () => {
    it("defaults to the measured winner and names its formatting", () => {
        const profile = modelProfile({} as NodeJS.ProcessEnv);

        expect(profile.name).toBe("qwen3");
        expect(profile.dims).toBe(1024);
        expect(profile.queryPrefix.startsWith("Instruct:")).toBe(true);
        expect(profile.docPrefix).toBe("");
    });

    it("selects by name, by full id, and keeps the width with the model", () => {
        expect(modelProfile({ PI_CODER_OUTLINE_MODEL: "gemma" } as NodeJS.ProcessEnv).dims).toBe(
            768,
        );
        expect(
            modelProfile({
                PI_CODER_OUTLINE_MODEL: "lfm2.5-embedding-350m-q8",
            } as NodeJS.ProcessEnv).name,
        ).toBe("lfm2");
        expect(
            modelProfile({ PI_CODER_OUTLINE_MODEL: "lfm2" } as NodeJS.ProcessEnv).docPrefix,
        ).toBe("document: ");
    });

    it("falls back to the default rather than failing on a name it does not know", () => {
        expect(modelProfile({ PI_CODER_OUTLINE_MODEL: "nope" } as NodeJS.ProcessEnv).name).toBe(
            "qwen3",
        );
    });

    it("keeps every profile a single hash-pinned download", () => {
        for (const profile of PROFILES) {
            expect(profile.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(profile.bytes).toBeGreaterThan(100_000_000);
            expect(profile.url.startsWith("https://huggingface.co/")).toBe(true);
            expect(profile.file.endsWith(".gguf")).toBe(true);
            expect(profile.dims).toBeGreaterThanOrEqual(768);
        }
    });
});

describe("device preference", () => {
    it("keeps queries on the cpu and lets builds take a gpu", () => {
        expect(devicePreference("query", {} as NodeJS.ProcessEnv)).toBe("cpu");
        expect(devicePreference("build", {} as NodeJS.ProcessEnv)).toBe("auto");
    });

    it("reads one role's variable before the blunt one", () => {
        const env = {
            PI_CODER_OUTLINE_DEVICE: "cpu",
            PI_CODER_OUTLINE_BUILD_DEVICE: "vulkan",
        } as NodeJS.ProcessEnv;

        expect(devicePreference("query", env)).toBe("cpu");
        expect(devicePreference("build", env)).toBe("vulkan");
    });

    it("ignores a typo rather than failing the channel", () => {
        expect(
            devicePreference("build", {
                PI_CODER_OUTLINE_BUILD_DEVICE: "gpu",
            } as NodeJS.ProcessEnv),
        ).toBe("auto");
    });
});

describe("build sizing", () => {
    it("caps the queue depth and honours the override", () => {
        expect(buildConcurrency({ PI_CODER_OUTLINE_WORKERS: "3" } as NodeJS.ProcessEnv)).toBe(3);
        expect(buildConcurrency({ PI_CODER_OUTLINE_WORKERS: "999" } as NodeJS.ProcessEnv)).toBe(8);
        expect(buildConcurrency({} as NodeJS.ProcessEnv)).toBeGreaterThanOrEqual(1);
    });

    it("keeps a background refresh to half the cores, never more than four", () => {
        expect(refreshConcurrency(16)).toBe(4);
        expect(refreshConcurrency(8)).toBe(4);
        expect(refreshConcurrency(4)).toBe(2);
        expect(refreshConcurrency(2)).toBe(1);
        expect(refreshConcurrency(1)).toBe(1);
    });
});

describe("the embedding runtime", () => {
    let double: LlamaDouble;

    beforeEach(() => {
        double = createLlamaDouble();
        dirs.push(double.dir);

        for (const [key, value] of Object.entries(llamaDoubleEnv(double, modelProfile().dims))) {
            process.env[key] = value;
        }

        // One CPU server for both roles unless a test says otherwise: that is the CPU-only machine, and it keeps the
        // spawn count in each assertion about content rather than about process lifecycle.
        process.env.PI_CODER_OUTLINE_BUILD_DEVICE = "cpu";
    });

    it("prefixes a query and only a query", async () => {
        const runtime = createEmbedRuntime({ modelDir: double.dir });

        try {
            const query = await runtime.embedQuery("where are vectors stored");
            const build = await runtime.build(
                tempDir(),
                [{ shard: "abcd", entries: [{ key: "k1", text: "a document about vectors" }] }],
                () => undefined,
            );
            const served = double.served();

            expect(query).toBeInstanceOf(Float32Array);
            expect(query).toHaveLength(modelProfile().dims);
            expect(build).toHaveLength(1);
            expect(served[0]).toBe(`${modelProfile().queryPrefix}where are vectors stored`);
            expect(served[1]).toBe(`${modelProfile().docPrefix}a document about vectors`);
        } finally {
            runtime.dispose();
        }
    });

    it("writes one shard per job, in key order, and reports progress and shards", async () => {
        const runtime = createEmbedRuntime({ modelDir: double.dir });
        const indexDir = tempDir();
        const progress: number[] = [];
        const shards: string[] = [];

        try {
            const built = await runtime.build(
                indexDir,
                [
                    {
                        shard: "aaaa",
                        entries: [
                            { key: "a1", text: "first" },
                            { key: "a2", text: "second" },
                        ],
                    },
                    { shard: "bbbb", entries: [{ key: "b1", text: "third" }] },
                ],
                (done) => progress.push(done),
                undefined,
                (shard) => shards.push(shard.shard),
                // One request in flight: the assertions below are about contents, not about ordering under load.
                { maxConcurrency: 1 },
            );

            expect(built.map((shard) => shard.shard).sort()).toEqual(["aaaa", "bbbb"]);
            expect(built.flatMap((shard) => shard.keys).sort()).toEqual(["a1", "a2", "b1"]);
            expect(built.find((shard) => shard.shard === "aaaa")?.keys).toEqual(["a1", "a2"]);
            expect(progress).toEqual([1, 2, 3]);
            expect(shards.sort()).toEqual(["aaaa", "bbbb"]);

            const file = path.join(indexDir, "shards", "aaaa.bin");

            expect(fs.statSync(file).size).toBe(2 * modelProfile().dims * 4);
        } finally {
            runtime.dispose();
        }
    });

    it("caps a text at the character budget instead of letting the server reject it", async () => {
        const runtime = createEmbedRuntime({ modelDir: double.dir });

        try {
            await runtime.build(
                tempDir(),
                [
                    {
                        shard: "cccc",
                        entries: [{ key: "k", text: "x".repeat(MAX_TEXT_CHARS + 500) }],
                    },
                ],
                () => undefined,
            );

            expect(double.served()[0]).toHaveLength(MAX_TEXT_CHARS);
        } finally {
            runtime.dispose();
        }
    });

    it("stops on an aborted build and keeps the shards it finished", async () => {
        const runtime = createEmbedRuntime({ modelDir: double.dir });
        const indexDir = tempDir();
        const controller = new AbortController();
        const shards: string[] = [];

        try {
            await expect(
                runtime.build(
                    indexDir,
                    [
                        { shard: "d1", entries: [{ key: "k1", text: "one" }] },
                        { shard: "d2", entries: [{ key: "k2", text: "two" }] },
                        { shard: "d3", entries: [{ key: "k3", text: "three" }] },
                    ],
                    () => {
                        controller.abort();
                    },
                    controller.signal,
                    (shard) => shards.push(shard.shard),
                    { maxConcurrency: 1 },
                ),
            ).rejects.toThrow();

            expect(shards.length).toBeLessThan(3);
        } finally {
            runtime.dispose();
        }
    });

    it("rejects once disposed rather than starting a second server", async () => {
        const runtime = createEmbedRuntime({ modelDir: double.dir });

        await runtime.embedQuery("warm");
        runtime.dispose();

        await expect(runtime.embedQuery("after dispose")).rejects.toThrow(/unavailable/);
    });

    it("runs a gpu build on its own server and releases it when the build ends", async () => {
        process.env.PI_CODER_OUTLINE_QUERY_DEVICE = "cpu";
        process.env.PI_CODER_OUTLINE_BUILD_DEVICE = "auto";
        resetLlamaDevice();

        const runtime = createEmbedRuntime({ modelDir: double.dir });
        const job = [{ shard: "g1", entries: [{ key: "k", text: "a document" }] }];

        try {
            await runtime.build(tempDir(), job, () => undefined);
            await runtime.build(tempDir(), job, () => undefined);

            // Two builds, two servers: the GPU process does not outlive the import that needed it.
            expect(double.starts()).toBe(2);
        } finally {
            runtime.dispose();
        }
    });

    it("keeps one server when queries and builds land on the same device", async () => {
        process.env.PI_CODER_OUTLINE_QUERY_DEVICE = "cpu";
        process.env.PI_CODER_OUTLINE_BUILD_DEVICE = "cpu";
        resetLlamaDevice();

        const runtime = createEmbedRuntime({ modelDir: double.dir });
        const job = [{ shard: "g2", entries: [{ key: "k", text: "a document" }] }];

        try {
            await runtime.embedQuery("a query");
            await runtime.build(tempDir(), job, () => undefined);
            await runtime.embedQuery("another query");

            expect(double.starts()).toBe(1);
        } finally {
            runtime.dispose();
        }
    });

    it("falls back to the cpu bundle when a gpu server cannot start", async () => {
        process.env.PI_CODER_OUTLINE_BUILD_DEVICE = "vulkan";
        process.env.FAKE_LLAMA_FAIL_GPU = "1";
        resetLlamaDevice();

        const runtime = createEmbedRuntime({ modelDir: double.dir });

        try {
            const built = await runtime.build(
                tempDir(),
                [{ shard: "g3", entries: [{ key: "k", text: "a document" }] }],
                () => undefined,
            );

            expect(built).toHaveLength(1);
            expect(double.served()).toHaveLength(1);
        } finally {
            runtime.dispose();
        }
    });

    it("surfaces a server that exits instead of topping out on a health timeout", async () => {
        process.env.FAKE_LLAMA_FAIL_START = "1";

        await expect(
            startEmbedServer({
                binary: double.binary,
                modelFile: double.modelFile,
                gpuLayers: 0,
            }),
        ).rejects.toThrow(/exited/);
    });
});
