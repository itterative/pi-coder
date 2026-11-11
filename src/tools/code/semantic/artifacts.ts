import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** One downloaded file: where it goes, where it comes from, and the bytes it must hash to. */
export interface ArtifactSpec {
    path: string;
    url: string;
    sha256: string;
    bytes: number;
}

const RUNTIME_VERSION = "1.31.0-dev.20260914-8d85527a0";
const TOKENIZERS_VERSION = "0.2.0";
const MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
const CDN = "https://cdn.jsdelivr.net/npm";
const HUB = "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve";

/**
 * The pinned download set for the fully dynamic embedding runtime.
 *
 * Every URL is version-locked and every file carries the hash it was measured at, because these bytes are
 * executed (the wasm runtime and the tokenizer) or fed to a model. The model's q4 weights live in an
 * external-data file next to the graph, which is why both are listed.
 */
export const ARTIFACTS: readonly ArtifactSpec[] = [
    {
        path: "runtime/ort.wasm.bundle.min.mjs",
        url: `${CDN}/onnxruntime-web@${RUNTIME_VERSION}/dist/ort.wasm.bundle.min.mjs`,
        sha256: "17b52c1ac62b421dc508b4c28b9a9675251c6e25dd512ef54b83a5e2c4242869",
        bytes: 73_123,
    },
    {
        path: "runtime/ort-wasm-simd-threaded.wasm",
        url: `${CDN}/onnxruntime-web@${RUNTIME_VERSION}/dist/ort-wasm-simd-threaded.wasm`,
        sha256: "06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3",
        bytes: 14_264_838,
    },
    {
        // The bundle resolves its loader glue relative to wasmPaths, so the .wasm alone is not enough.
        path: "runtime/ort-wasm-simd-threaded.mjs",
        url: `${CDN}/onnxruntime-web@${RUNTIME_VERSION}/dist/ort-wasm-simd-threaded.mjs`,
        sha256: "c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f",
        bytes: 24_381,
    },
    {
        path: "runtime/tokenizers.mjs",
        url: `${CDN}/@huggingface/tokenizers@${TOKENIZERS_VERSION}/dist/tokenizers.mjs`,
        sha256: "1c4a848f86156201c033d6cd08c4cf81ae1088552acec3367f31ef086edf5af0",
        bytes: 98_937,
    },
    {
        path: "model/config.json",
        url: `${HUB}/${MODEL_REVISION}/config.json`,
        sha256: "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d",
        bytes: 5_031,
    },
    {
        path: "model/tokenizer.json",
        url: `${HUB}/${MODEL_REVISION}/tokenizer.json`,
        sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
        bytes: 32_170_510,
    },
    {
        path: "model/tokenizer_config.json",
        url: `${HUB}/${MODEL_REVISION}/tokenizer_config.json`,
        sha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874",
        bytes: 1_599,
    },
    {
        path: "model/model_q4.onnx",
        url: `${HUB}/${MODEL_REVISION}/onnx/model_q4.onnx`,
        sha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9",
        bytes: 490_742,
    },
    {
        path: "model/model_q4.onnx_data",
        url: `${HUB}/${MODEL_REVISION}/onnx/model_q4.onnx_data`,
        sha256: "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49",
        bytes: 174_028_800,
    },
];

export const TOTAL_ARTIFACT_BYTES = ARTIFACTS.reduce((sum, spec) => sum + spec.bytes, 0);

/** A cheap "is it all here" check: sizes only, no hashing. */
export function artifactsPresent(dir: string, specs: readonly ArtifactSpec[] = ARTIFACTS): boolean {
    return specs.every((spec) => {
        try {
            return fs.statSync(path.join(dir, spec.path)).size === spec.bytes;
        } catch {
            return false;
        }
    });
}

interface VerifiedEntry {
    bytes: number;
    mtimeMs: number;
    sha256: string;
}

interface VerifiedFile {
    files: Record<string, VerifiedEntry>;
}

function readVerified(dir: string): VerifiedFile {
    try {
        const parsed: unknown = JSON.parse(
            fs.readFileSync(path.join(dir, "verified.json"), "utf8"),
        );

        if (typeof parsed === "object" && parsed !== null && "files" in parsed) {
            return parsed as VerifiedFile;
        }
    } catch {
        // No verification record yet.
    }

    return { files: {} };
}

function writeVerified(dir: string, verified: VerifiedFile): void {
    const file = path.join(dir, "verified.json");
    const temporary = `${file}.tmp.${process.pid}`;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(verified, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

async function sha256File(file: string): Promise<string> {
    const hash = createHash("sha256");

    for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk as Buffer);
    }

    return hash.digest("hex");
}

export interface EnsureOptions {
    dir: string;
    fetchImpl?: typeof fetch;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
    specs?: readonly ArtifactSpec[];
}

/**
 * Ensure every artifact is present and hash-verified, downloading only what is missing.
 *
 * Downloads stream to a `.part` file while hashing, so a truncated transfer or a bad mirror never becomes a
 * usable artifact: the rename happens only after the byte count and digest both match. An existing file is
 * re-hashed only when its size or mtime changed since the last verification, which keeps a warm start cheap
 * even though the model is 166 MB.
 */
export async function ensureArtifacts(options: EnsureOptions): Promise<void> {
    const { dir, fetchImpl = fetch, onProgress, signal } = options;
    const specs = options.specs ?? ARTIFACTS;
    const verified = readVerified(dir);
    let changed = false;

    fs.mkdirSync(dir, { recursive: true });

    for (const spec of specs) {
        const target = path.join(dir, spec.path);
        const stat = await fsp.stat(target).catch(() => undefined);
        const recorded = verified.files[spec.path];

        if (stat !== undefined && stat.size === spec.bytes) {
            const trusted =
                recorded !== undefined &&
                recorded.bytes === stat.size &&
                recorded.mtimeMs === stat.mtimeMs &&
                recorded.sha256 === spec.sha256;

            if (trusted) {
                continue;
            }

            onProgress?.(`verifying ${spec.path}`);
            const digest = await sha256File(target);

            if (digest === spec.sha256) {
                verified.files[spec.path] = {
                    bytes: stat.size,
                    mtimeMs: stat.mtimeMs,
                    sha256: digest,
                };
                changed = true;
                continue;
            }
        }

        onProgress?.(`downloading ${spec.path}`);
        await download(spec, target, fetchImpl, signal);
        const downloaded = await fsp.stat(target);
        verified.files[spec.path] = {
            bytes: downloaded.size,
            mtimeMs: downloaded.mtimeMs,
            sha256: spec.sha256,
        };
        changed = true;
    }

    if (changed) {
        writeVerified(dir, verified);
    }
}

async function download(
    spec: ArtifactSpec,
    target: string,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<void> {
    const response = await fetchImpl(spec.url, { signal, redirect: "follow" });

    if (!response.ok || response.body === null) {
        throw new Error(`semantic: could not download ${spec.path}: HTTP ${response.status}`);
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });

    const temporary = `${target}.part`;
    const hash = createHash("sha256");
    let received = 0;

    const out = fs.createWriteStream(temporary);

    try {
        for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk as Uint8Array);

            signal?.throwIfAborted();
            received += buffer.length;
            hash.update(buffer);

            if (!out.write(buffer)) {
                await new Promise<void>((resolve) => out.once("drain", resolve));
            }
        }
    } finally {
        await new Promise<void>((resolve, reject) => {
            out.end((error?: Error | null) => (error ? reject(error) : resolve()));
        });
    }

    if (received !== spec.bytes) {
        await fsp.rm(temporary, { force: true });
        throw new Error(`semantic: ${spec.path} is ${received} bytes, expected ${spec.bytes}`);
    }

    const digest = hash.digest("hex");

    if (digest !== spec.sha256) {
        await fsp.rm(temporary, { force: true });
        throw new Error(`semantic: ${spec.path} failed its checksum`);
    }

    await fsp.rename(temporary, target);
}
