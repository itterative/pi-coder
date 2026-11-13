import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { modelFile } from "./artifacts";
import { modelProfile } from "./profiles";
import {
    devicePreference,
    resolveDevice,
    type DeviceChoice,
    type DevicePreference,
} from "./llamacpp";
import { startEmbedServer, type EmbedServer } from "./server";

const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_BUILD_CONCURRENCY = 8;

/**
 * Most characters one text may send.
 *
 * The old runtime cut at 1,024 *tokens*; without a tokenizer in the parent, the honest knob is characters. 12,000
 * characters is roughly 3,000 tokens of prose (less of dense code), which sits inside the server's 8k context and its
 * 4k physical batch, and is three times the old cut. Only a handful of memory sections in this repo ever reach it.
 */
export const MAX_TEXT_CHARS = 12_000;

export interface BuildFile {
    shard: string;
    entries: Array<{ key: string; text: string }>;
}

export interface BuildShard {
    shard: string;
    keys: string[];
}

/**
 * Most declarations one shard may carry.
 *
 * Shards used to be build-job lines, and this split kept one huge file from being a serial bottleneck for a child.
 * Serialisation is the server's job now, but the cap still earns its place: a 1,587-declaration header stays 25
 * shards, so pruning and re-reading stay proportional to the edit rather than to the file.
 */
export const MAX_JOB_ENTRIES = 64;

export function splitJobs(files: BuildFile[]): BuildFile[] {
    return files.flatMap((file) => {
        if (file.entries.length <= MAX_JOB_ENTRIES) {
            return [file];
        }

        const parts: BuildFile[] = [];

        for (let start = 0; start < file.entries.length; start += MAX_JOB_ENTRIES) {
            parts.push({
                shard: `${file.shard}-p${parts.length.toString(36)}`,
                entries: file.entries.slice(start, start + MAX_JOB_ENTRIES),
            });
        }

        return parts;
    });
}

/**
 * Embedding requests in flight during a build.
 *
 * The server serialises them, so this is a queue depth rather than a worker count: it costs nothing on CPU and bought
 * 1.38x on a Vulkan device at 257 tokens, where the GPU is idle between short requests. Capped low because the point
 * is to keep the device busy, not to queue minutes of work the user wants to cancel.
 */
export function buildConcurrency(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt((env.PI_CODER_OUTLINE_WORKERS ?? "").trim(), 10);

    if (Number.isFinite(configured) && configured > 0) {
        return Math.min(configured, MAX_BUILD_CONCURRENCY);
    }

    return Math.max(1, Math.min(4, os.availableParallelism()));
}

/** How deep a background refresh may queue, so an unattended build leaves the device to the user's queries. */
export const REFRESH_CONCURRENCY_MAX = 4;

export function refreshConcurrency(cores: number = os.availableParallelism()): number {
    return Math.max(1, Math.min(REFRESH_CONCURRENCY_MAX, Math.floor(Math.max(1, cores) / 2)));
}

export interface BuildOptions {
    /** Upper bound on requests in flight; defaults to `buildConcurrency()`. */
    maxConcurrency?: number;
    /**
     * Device for this build.
     *
     * The default is the configured build preference (`auto`: the GPU when there is a real one), and a background
     * refresh passes `cpu` — it runs unattended while the user is doing something else, which is the one time
     * borrowing VRAM is not defensible.
     */
    device?: DevicePreference;
}

export interface EmbedRuntime {
    /** Embed one query, with the model's instruction prefix, or reject when the runtime is unavailable. */
    embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
    /**
     * Batch-embed a build job and write one shard file per job.
     *
     * `onShard` fires as each shard is durably written, so the caller can publish it in the manifest before the build
     * finishes. That is what makes a killed build resumable instead of leaving orphaned shard files.
     */
    build(
        indexDir: string,
        files: BuildFile[],
        onProgress: (done: number, total: number) => void,
        signal?: AbortSignal,
        onShard?: (shard: BuildShard) => void,
        options?: BuildOptions,
    ): Promise<BuildShard[]>;
    dispose(): void;
}

/** Write one shard: float32 little-endian vectors in key order, which is what `store.ts` reads back. */
function writeShard(
    indexDir: string,
    shard: string,
    vectors: readonly Float32Array[],
    dims: number,
): void {
    const file = path.join(indexDir, "shards", `${shard}.bin`);
    const temporary = `${file}.tmp.${process.pid}`;
    const buffer = Buffer.alloc(vectors.length * dims * 4);
    let cursor = 0;

    for (const vector of vectors) {
        for (const value of vector) {
            buffer.writeFloatLE(value, cursor);
            cursor += 4;
        }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, file);
}

/** One live server, with the device it runs on. */
interface Slot {
    choice: DeviceChoice;
    server: EmbedServer;
}

/**
 * A client for the embedding servers.
 *
 * **Two roles, one server each, and the GPU one is transient.** Queries run on the configured query device (CPU by
 * default) through a warm server that stays in RAM; builds run on the configured build device (a GPU when there is one)
 * through a server that is started for the build and killed when it finishes. That asymmetry is the point: a search
 * tool must not sit on the user's VRAM between imports, and the numbers say it does not need to — a warm CPU query is
 * ~56 ms against ~13 ms on a GPU, while a build is 20x faster there (4.8 vs 96.6 vectors/s here).
 *
 * Mixing backends is safe because it is the same weights: CPU and Vulkan vectors for the same text score cosine
 * 0.9994–0.9998, so an index built on the GPU is queried on the CPU with no ranking penalty, and entry keys are text
 * hashes rather than vector values.
 *
 * When both roles land on the same device (the common CPU-only machine), there is one server, not two.
 */
export function createEmbedRuntime(options: { modelDir: string }): EmbedRuntime {
    const slots = new Map<string, Slot>();
    const starting = new Map<string, Promise<Slot>>();
    let broken = false;
    let idle: NodeJS.Timeout | undefined;

    const closeSlot = (device: "cpu" | "vulkan"): void => {
        const slot = slots.get(device);

        if (slot !== undefined) {
            slot.server.dispose();
            slots.delete(device);
        }

        starting.delete(device);
    };

    const close = (): void => {
        if (idle !== undefined) {
            clearTimeout(idle);
            idle = undefined;
        }

        for (const device of [...slots.keys()]) {
            closeSlot(device as "cpu" | "vulkan");
        }
    };

    const touch = (): void => {
        if (idle !== undefined) {
            clearTimeout(idle);
        }

        idle = setTimeout(close, IDLE_TIMEOUT_MS);
        idle.unref?.();
    };

    const ensure = async (preference: DevicePreference): Promise<Slot> => {
        if (broken) {
            throw new Error("semantic: runtime unavailable");
        }

        const choice = await resolveDevice(options.modelDir, preference);
        const existing = slots.get(choice.device);

        if (existing !== undefined) {
            return existing;
        }

        const pending = starting.get(choice.device);

        if (pending !== undefined) {
            return pending;
        }

        const started = (async (): Promise<Slot> => {
            const server = await startEmbedServer({
                binary: choice.binary,
                modelFile: modelFile(options.modelDir),
                gpuLayers: choice.device === "vulkan" ? 999 : 0,
                deviceId: choice.deviceId,
            });
            const slot = { choice, server };

            slots.set(choice.device, slot);

            return slot;
        })();

        starting.set(choice.device, started);

        try {
            const slot = await started;

            touch();

            return slot;
        } catch (error) {
            starting.delete(choice.device);

            throw error;
        }
    };

    /**
     * A server for one role, with the GPU fallback.
     *
     * A Vulkan start can fail for reasons that are not defects: the user's own model already holds the VRAM, a driver
     * was upgraded under a running session, or the device hangs. None of those should fail a build that the CPU can do,
     * so the failure is retried on the CPU bundle and the build continues at CPU speed.
     */
    const ensureForRole = async (role: "query" | "build"): Promise<Slot> => {
        const preference = devicePreference(role);

        try {
            const slot = await ensure(preference);

            return slot;
        } catch (error) {
            if (preference === "cpu") {
                broken = true;

                throw error;
            }

            process.stderr.write(
                `semantic: ${preference} device unavailable (${error instanceof Error ? error.message : String(error)}); using cpu\n`,
            );

            return ensure("cpu");
        }
    };

    const embedWith = async (
        slot: Slot,
        prefix: string,
        text: string,
        signal?: AbortSignal,
    ): Promise<Float32Array> => {
        const capped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

        touch();

        return slot.server.embed(`${prefix}${capped}`, signal);
    };

    /**
     * Embed `files` with `concurrency` requests in flight, writing each shard as it completes.
     *
     * Files are the unit of work and of sharding. The queue is fed in order, so a cancelled build keeps exactly the
     * shards whose files finished, and progress counts entries rather than files because entries are what the caller's
     * estimate is made of.
     */
    const build = async (
        indexDir: string,
        files: BuildFile[],
        onProgress: (done: number, total: number) => void,
        signal?: AbortSignal,
        onShard?: (shard: BuildShard) => void,
        buildOptions: BuildOptions = {},
    ): Promise<BuildShard[]> => {
        if (broken) {
            throw new Error("semantic: runtime unavailable");
        }

        signal?.throwIfAborted();
        fs.mkdirSync(indexDir, { recursive: true });

        const profile = modelProfile();
        const slot = await ensureForRole("build");
        const jobs = splitJobs(files);
        const total = jobs.reduce((sum, job) => sum + job.entries.length, 0);
        // The GPU is borrowed only when queries are not on it: sharing a device means sharing the process, and closing
        // it would pull the server out from under the next search.
        const queryPreference = devicePreference("query");
        const transient = queryPreference !== "auto" && slot.choice.device !== queryPreference;
        // A CPU server is strictly serial and extra requests only queue, so a query behind an unattended build waits
        // for all of them instead of one. A device that overlaps work (Vulkan) keeps the extra depth.
        const requested =
            buildOptions.maxConcurrency ?? (slot.choice.device === "cpu" ? 1 : buildConcurrency());
        const concurrency = Math.max(1, Math.min(requested, jobs.length || 1));
        const shards: BuildShard[] = [];
        let done = 0;
        let next = 0;

        const runOne = async (job: BuildFile): Promise<void> => {
            const vectors: Float32Array[] = [];
            const keys: string[] = [];

            for (const entry of job.entries) {
                signal?.throwIfAborted();

                vectors.push(await embedWith(slot, profile.docPrefix, entry.text, signal));
                keys.push(entry.key);
                done += 1;
                onProgress(done, total);
            }

            writeShard(indexDir, job.shard, vectors, profile.dims);

            const shard = { shard: job.shard, keys };

            shards.push(shard);
            onShard?.(shard);
        };

        const drain = async (): Promise<void> => {
            while (next < jobs.length) {
                const job = jobs[next];

                next += 1;

                if (job !== undefined) {
                    await runOne(job);
                }
            }
        };

        try {
            await Promise.all(Array.from({ length: concurrency }, () => drain()));
        } finally {
            // Release the GPU the moment the import is done: this is the whole reason a build may use it at all.
            if (transient) {
                closeSlot(slot.choice.device);
            }
        }

        return shards;
    };

    return {
        async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
            const slot = await ensureForRole("query");

            return embedWith(slot, modelProfile().queryPrefix, text, signal);
        },
        build,
        dispose(): void {
            broken = true;
            close();
        },
    };
}
