import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { llamaArtifacts } from "./llamacpp";
import { modelProfile } from "./profiles";

/** One downloaded file: where it goes, where it comes from, and the bytes it must hash to. */
export interface ArtifactSpec {
    path: string;
    url: string;
    sha256: string;
    bytes: number;
}

/**
 * The model file as an artifact spec: the profile's weights, which are the only per-model download.
 *
 * The GGUF carries its own tokenizer, so a profile is one file — where the ONNX runtime needed a graph, an external
 * data file, a 32 MB `tokenizer.json`, a config, and 24 MB of wasm beside it.
 */
export function modelArtifact(env: NodeJS.ProcessEnv = process.env): ArtifactSpec {
    const profile = modelProfile(env);

    return {
        path: profile.file,
        url: profile.url,
        sha256: profile.sha256,
        bytes: profile.bytes,
    };
}

/** The model file on disk, with a test/CI override. */
export function modelFile(modelDir: string, env: NodeJS.ProcessEnv = process.env): string {
    const override = (env.PI_CODER_OUTLINE_MODEL_FILE ?? "").trim();

    return override.length > 0
        ? path.resolve(override)
        : path.join(modelDir, modelArtifact(env).path);
}

/**
 * Bytes this machine will download for the live profile: its model plus whichever runtime archives its platform has.
 *
 * Only the selected model is fetched, so switching profiles costs a download and a rebuild rather than tripling the
 * footprint of every install.
 */
export function artifactBytes(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
    env: NodeJS.ProcessEnv = process.env,
): number {
    return runtimeArtifacts(platform, arch, env).reduce((sum, spec) => sum + spec.bytes, 0);
}

/** The full download for this platform and profile. */
export function runtimeArtifacts(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
    env: NodeJS.ProcessEnv = process.env,
): ArtifactSpec[] {
    return [modelArtifact(env), ...llamaArtifacts(platform, arch)];
}

/** A cheap "is it all here" check: sizes only, no hashing. */
export function artifactsPresent(
    dir: string,
    specs: readonly ArtifactSpec[] = runtimeArtifacts(),
): boolean {
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
    const specs = options.specs ?? runtimeArtifacts();
    const verified = readVerified(dir);
    let changed = false;

    fs.mkdirSync(dir, { recursive: true });

    for (const spec of specs) {
        changed =
            (await ensureOne(spec, { dir, verified, fetchImpl, onProgress, signal })) || changed;
    }

    if (changed) {
        writeVerified(dir, verified);
    }
}

interface EnsureOne {
    dir: string;
    verified: VerifiedFile;
    fetchImpl: typeof fetch;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
}

/** One artifact, verified against the hash recorded the last time its size and mtime were unchanged. */
async function ensureOne(spec: ArtifactSpec, ctx: EnsureOne): Promise<boolean> {
    const target = path.join(ctx.dir, spec.path);
    const stat = await fsp.stat(target).catch(() => undefined);
    const recorded = ctx.verified.files[spec.path];

    if (stat !== undefined && stat.size === spec.bytes) {
        const trusted =
            recorded !== undefined &&
            recorded.bytes === stat.size &&
            recorded.mtimeMs === stat.mtimeMs &&
            recorded.sha256 === spec.sha256;

        if (trusted) {
            return false;
        }

        ctx.onProgress?.(`verifying ${spec.path}`);
        const digest = await sha256File(target);

        if (digest === spec.sha256) {
            ctx.verified.files[spec.path] = {
                bytes: stat.size,
                mtimeMs: stat.mtimeMs,
                sha256: digest,
            };

            return true;
        }
    }

    ctx.onProgress?.(`downloading ${spec.path}`);
    await download(spec, target, ctx.fetchImpl, ctx.signal);
    const downloaded = await fsp.stat(target);
    ctx.verified.files[spec.path] = {
        bytes: downloaded.size,
        mtimeMs: downloaded.mtimeMs,
        sha256: spec.sha256,
    };

    return true;
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
