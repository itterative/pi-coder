import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    artifactBytes,
    nativeArtifactBytes,
    TOTAL_ARTIFACT_BYTES,
} from "../../../src/tools/code/semantic/artifacts";
import {
    NATIVE_CPUS,
    NATIVE_ORT_VERSION,
    nativeArtifacts,
    nativeBuildPlan,
    nativeCpu,
    nativeRuntimeDir,
    nativeRuntimePresent,
    nativeThreadCount,
} from "../../../src/tools/code/semantic/native";

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-native-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function writeRuntime(modelDir: string, sizes: { binding: number; library: number }): void {
    const cpu = NATIVE_CPUS[0];
    const dir = nativeRuntimeDir(modelDir)!;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "onnxruntime_binding.node"), Buffer.alloc(sizes.binding));
    fs.writeFileSync(path.join(dir, cpu.library), Buffer.alloc(sizes.library));
}

describe("outline native runtime", () => {
    it("maps a platform to its package layout", () => {
        expect(nativeCpu("linux", "x64")?.packageDir).toBe("linux/x64");
        // Anything unverified falls back to wasm rather than guessing at a library name.
        expect(nativeCpu("darwin", "arm64")).toBeUndefined();
        expect(nativeCpu("linux", "arm64")).toBeUndefined();
    });

    it("pins the two files the CPU binding needs", () => {
        const specs = nativeArtifacts("linux", "x64");

        expect(specs.map((spec) => spec.path)).toEqual([
            "native/linux-x64/onnxruntime_binding.node",
            "native/linux-x64/libonnxruntime.so.1",
        ]);
        expect(specs[0]?.url).toContain(
            `onnxruntime-node@${NATIVE_ORT_VERSION}/bin/napi-v6/linux/x64`,
        );
        expect(specs.every((spec) => /^[0-9a-f]{64}$/.test(spec.sha256))).toBe(true);
        expect(specs.reduce((sum, spec) => sum + spec.bytes, 0)).toBeGreaterThan(40_000_000);
        expect(nativeArtifacts("darwin", "arm64")).toEqual([]);
    });

    it("counts the native payload on top of the base artifacts, but only where it exists", () => {
        expect(artifactBytes("linux", "x64")).toBe(
            TOTAL_ARTIFACT_BYTES + nativeArtifactBytes("linux", "x64"),
        );
        expect(artifactBytes("darwin", "arm64")).toBe(TOTAL_ARTIFACT_BYTES);
    });

    it("reports the runtime present only at the exact pinned sizes", () => {
        const modelDir = tempDir();
        const cpu = NATIVE_CPUS[0];
        const sizes = { binding: cpu.binding.bytes, library: cpu.libraryFile.bytes };

        // Absent, then present, then a mismatched size (a truncated download must not be loadable).
        expect(nativeRuntimePresent(modelDir, "linux", "x64")).toBe(false);

        writeRuntime(modelDir, sizes);
        expect(nativeRuntimePresent(modelDir, "linux", "x64")).toBe(true);

        fs.writeFileSync(path.join(nativeRuntimeDir(modelDir)!, cpu.library), "short");
        expect(nativeRuntimePresent(modelDir, "linux", "x64")).toBe(false);
    });

    it("caps query threads at four and build threads at the measured knee of eight", () => {
        // Measured: a query is 91 ms at one thread, 27 ms at four, 30 ms at sixteen; a build declaration is 346 ms
        // at one thread, 94 ms at four, 55 ms at eight, 88 ms at twelve, 97 ms at sixteen.
        expect(nativeThreadCount("query", 1)).toBe(1);
        expect(nativeThreadCount("query", 2)).toBe(2);
        expect(nativeThreadCount("query", 16)).toBe(4);
        expect(nativeThreadCount("build", 1)).toBe(1);
        expect(nativeThreadCount("build", 4)).toBe(4);
        expect(nativeThreadCount("build", 16)).toBe(8);
        expect(nativeThreadCount("build", 32)).toBe(8);
    });

    it("builds in one process, because more processes only contend", () => {
        // Measured over 400 declarations of this repo's own distribution on 16 cores: one process of eight threads
        // took 55 ms each, two processes of eight 64 ms, two of four 97 ms, and one of four 94 ms.
        expect(nativeBuildPlan({ declarations: 1, cores: 16 })).toEqual({
            processes: 1,
            threads: 8,
        });
        expect(nativeBuildPlan({ declarations: 5_000, cores: 16 })).toEqual({
            processes: 1,
            threads: 8,
        });
        expect(nativeBuildPlan({ declarations: 5_000, cores: 4 })).toEqual({
            processes: 1,
            threads: 4,
        });
        // A refresh's cap is a share of the machine: four threads in the one process.
        expect(nativeBuildPlan({ declarations: 500, cores: 16, maxThreads: 4 })).toEqual({
            processes: 1,
            threads: 4,
        });
        expect(nativeBuildPlan({ declarations: 500, cores: 1, maxThreads: 4 })).toEqual({
            processes: 1,
            threads: 1,
        });
    });

    it("describes only platforms it has measured", () => {
        expect(NATIVE_CPUS.every((cpu) => cpu.library.length > 0)).toBe(true);
        expect(nativeRuntimeDir("/models", "darwin", "arm64")).toBeUndefined();
        expect(nativeRuntimeDir("/models", "linux", "x64")).toBe("/models/native/linux-x64");
    });
});
