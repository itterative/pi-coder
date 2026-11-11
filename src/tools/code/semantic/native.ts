import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The native (ONNX Runtime CPU) embedding runtime.
 *
 * The wasm build bootstraps its worker threads through a `blob:` module import, which Node's ESM loader refuses, so
 * it runs single-threaded and needs one *process* per core. The native build takes real intra-op threads instead:
 * measured on 16 cores with the same artifacts, a query embedding is 673 ms on wasm and 27 ms here, a 93-token
 * document 1589 ms against 90 ms, session start 2.5 s against 0.2 s, and it holds less memory (486 MB against
 * 767 MB). Vectors are identical — cosine 1.000000 against the wasm runtime — so switching runtimes never
 * invalidates an index.
 *
 * We drive the raw Node-API binding rather than shipping `onnxruntime-node`'s JS: the binding's surface is
 * `initOrtOnce`, `InferenceSession.loadModel`, `run`, and a `Tensor` class it wraps output in, which is about
 * thirty lines in `embed-worker.mjs`. That keeps the artifact to two files instead of ~230 JS modules.
 */
export interface NativeCpu {
    platform: NodeJS.Platform;
    arch: string;
    /** Directory inside the npm package's `bin/napi-v6`, and the runtime's directory name under the state dir. */
    packageDir: string;
    /** The ORT shared library the binding dlopens; its name is platform-specific. */
    library: string;
    binding: { bytes: number; sha256: string };
    libraryFile: { bytes: number; sha256: string };
}

export const NATIVE_ORT_VERSION = "1.31.1";
const PACKAGE_ROOT = `https://unpkg.com/onnxruntime-node@${NATIVE_ORT_VERSION}/bin/napi-v6`;

/**
 * Platforms with a verified native runtime.
 *
 * Only linux-x64 is proven end to end. Everywhere else the wasm runtime takes over, unchanged, so an unsupported
 * platform loses speed and nothing else. Adding one means measuring its two files, not just listing it: the
 * library name differs (`libonnxruntime.dylib`/`onnxruntime.dll`) and macOS binaries are notarised per architecture.
 */
export const NATIVE_CPUS: readonly NativeCpu[] = [
    {
        platform: "linux",
        arch: "x64",
        packageDir: "linux/x64",
        library: "libonnxruntime.so.1",
        binding: {
            bytes: 519_712,
            sha256: "e3a108803b8bd33c8e9691b52921c37bede7a6886251aa41219f053d268ee231",
        },
        libraryFile: {
            bytes: 47_552_704,
            sha256: "f19a4da48c4c65e0cdccff82354482f657fa91a3455b66174195b94ca55b0e6f",
        },
    },
];

export interface NativeArtifact {
    path: string;
    url: string;
    sha256: string;
    bytes: number;
}

export function nativeCpu(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): NativeCpu | undefined {
    return NATIVE_CPUS.find((cpu) => cpu.platform === platform && cpu.arch === arch);
}

/** Where this platform's two files live under the state directory; `undefined` when native is unsupported. */
export function nativeRuntimeDir(
    modelDir: string,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): string | undefined {
    const cpu = nativeCpu(platform, arch);

    return cpu === undefined
        ? undefined
        : path.join(modelDir, "native", `${cpu.platform}-${cpu.arch}`);
}

/** The two downloads for this platform, as ordinary artifact specs (nothing native-only in the format). */
export function nativeArtifacts(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): NativeArtifact[] {
    const cpu = nativeCpu(platform, arch);

    if (cpu === undefined) {
        return [];
    }

    const dir = `native/${cpu.platform}-${cpu.arch}`;

    return [
        {
            path: `${dir}/onnxruntime_binding.node`,
            url: `${PACKAGE_ROOT}/${cpu.packageDir}/onnxruntime_binding.node`,
            ...cpu.binding,
        },
        {
            path: `${dir}/${cpu.library}`,
            url: `${PACKAGE_ROOT}/${cpu.packageDir}/${cpu.library}`,
            ...cpu.libraryFile,
        },
    ];
}

/** Whether the worker can load the native runtime from this model directory. */
export function nativeRuntimePresent(
    modelDir: string,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): boolean {
    const cpu = nativeCpu(platform, arch);
    const dir = nativeRuntimeDir(modelDir, platform, arch);

    if (cpu === undefined || dir === undefined) {
        return false;
    }

    try {
        return (
            fs.statSync(path.join(dir, "onnxruntime_binding.node")).size === cpu.binding.bytes &&
            fs.statSync(path.join(dir, cpu.library)).size === cpu.libraryFile.bytes
        );
    } catch {
        return false;
    }
}

/**
 * Intra-op threads for one child process.
 *
 * A query is a single short sequence, so it stops scaling at four threads (27 ms at 4, 30 ms at 16) and should not
 * take a core from anything else. A build splits the cores between its processes, and a build process holds a copy
 * of the weights, so it gets whatever is left up to eight — also where the measurements flatten out.
 */
export function nativeThreadCount(kind: "query" | "build", cores: number, processes = 1): number {
    const available = Math.max(1, cores);

    if (kind === "query") {
        return Math.min(4, available);
    }

    return Math.max(1, Math.min(8, Math.floor(available / Math.max(1, processes))));
}

/**
 * Processes and threads for a native build.
 *
 * The wasm runtime needed one process per core and one process per ~8 declarations, because each child paid ~5 s to
 * load the model. Native loads in 0.2 s and shares threads inside one process, so a refresh is a single process and
 * only a large build splits into two.
 */
export function nativeBuildPlan(input: {
    declarations: number;
    cores?: number;
    maxProcesses?: number;
    /** A background refresh passes its cap here too, so "at most four" means four cores of work. */
    maxThreads?: number;
}): { processes: number; threads: number } {
    const cores = input.cores ?? os.availableParallelism();
    const processes = Math.max(
        1,
        Math.min(input.maxProcesses ?? 2, Math.ceil(Math.max(1, input.declarations) / 128)),
    );
    const threads = Math.min(
        nativeThreadCount("build", cores, processes),
        input.maxThreads ?? Number.POSITIVE_INFINITY,
    );

    return { processes, threads: Math.max(1, threads) };
}
