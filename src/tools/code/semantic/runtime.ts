import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { PI_CODER_EXTENSION_DIR } from "../../../common/constants";
import { MODEL_DIMS } from "./config";
import {
    nativeBuildPlan,
    nativeRuntimeDir,
    nativeRuntimePresent,
    nativeThreadCount,
} from "./native";

const WORKER_SCRIPT = path.join(PI_CODER_EXTENSION_DIR, "src/tools/code/semantic/embed-worker.mjs");
const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_BUILD_WORKERS = 32;
/** Conservative resident estimate per child: model weights, tokenizer, wasm heap, and Node itself. */
const BYTES_PER_WORKER = 1_073_741_824;

/** MemAvailable when Linux exposes it; plain free memory is the conservative fallback elsewhere. */
function availableMemoryBytes(): number {
    try {
        const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
        const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);

        if (match !== null) {
            return Number.parseInt(match[1] ?? "0", 10) * 1024;
        }
    } catch {
        // Not Linux, or /proc is unavailable.
    }

    return os.freemem();
}

/**
 * Build processes to run at once.
 *
 * The wasm session is single-threaded, so the only way to use more than one core is more processes; each
 * holds its own copy of the model, which is why this is capped by both cores and available memory rather
 * than by a flat constant. A 16-core machine with enough free RAM gets 16 workers.
 */
export function buildWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt((env.PI_CODER_OUTLINE_WORKERS ?? "").trim(), 10);

    if (Number.isFinite(configured) && configured > 0) {
        return Math.min(configured, MAX_BUILD_WORKERS);
    }

    const cores = Math.max(1, os.availableParallelism());
    const memoryLimited = Math.floor(
        Math.max(0, availableMemoryBytes() - BYTES_PER_WORKER) / BYTES_PER_WORKER,
    );

    return Math.max(1, Math.min(cores, memoryLimited, MAX_BUILD_WORKERS));
}

export interface BuildFile {
    shard: string;
    entries: Array<{ key: string; text: string }>;
}

export interface BuildShard {
    shard: string;
    keys: string[];
}

/**
 * Most declarations one build job line may carry.
 *
 * A job line is the unit a build child takes: it embeds its lines in order, so one line is as serial as its entry
 * count. A source file used to be one indivisible line, and the largest file in the vibes tree
 * (`third_party/nlohmann/.../json.hpp`) has 1587 declarations — that child kept grinding for minutes after the others
 * finished, which is the tail the build showed. Shards are named per line rather than per file, so a split is
 * invisible to the manifest and to pruning.
 */
export const MAX_JOB_ENTRIES = 64;

/**
 * Split entry lists too big to balance into parts, so no source file is a serial bottleneck.
 *
 * Splitting does not change what is embedded, only how evenly it divides: [keys] keep their order within each part,
 * and every part gets its own shard name because two lines may touch the same file's directory in the shard store.
 */
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
 * Most build workers a background refresh may use.
 *
 * A refresh runs unattended while the user keeps querying, and a query embedding competes with it for cores. Measured
 * on a 16-core machine with 64 declarations: 4 workers cost a concurrent query 9% of its latency, 8 workers 20%, and 16
 * workers (512 declarations) 124% — while the extra workers buy little, because each child loads ~1.85 s of model
 * before it embeds its first item. Explicit builds keep the full scaling: the user asked for them and is waiting.
 */
export const REFRESH_WORKERS_MAX = 4;

/** Worker ceiling for a background refresh: half the cores, never more than `REFRESH_WORKERS_MAX`. */
export function refreshWorkerCount(cores: number = os.availableParallelism()): number {
    return Math.max(1, Math.min(REFRESH_WORKERS_MAX, Math.floor(Math.max(1, cores) / 2)));
}

export interface EmbedRuntime {
    /** Embed one query through the warm child, or reject when the runtime is unavailable. */
    embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
    /**
     * Batch-embed a build job; the child writes shards and reports progress.
     *
     * `onShard` fires as each shard is durably written, so the caller can publish it in the manifest before
     * the build finishes. That is what makes a killed build resumable instead of leaving orphaned shard files.
     */
    build(
        indexDir: string,
        files: BuildFile[],
        onProgress: (done: number, total: number) => void,
        signal?: AbortSignal,
        onShard?: (shard: BuildShard) => void,
        /** Upper bound on child processes; defaults to `buildWorkerCount()`. */
        maxWorkers?: number,
    ): Promise<BuildShard[]>;
    dispose(): void;
}

interface PendingRequest {
    resolve: (vector: Float32Array) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
}

/**
 * Environment for a worker child.
 *
 * `PI_OUTLINE_NATIVE_DIR` is only set when this platform's native runtime is actually on disk, so the worker takes
 * the native path when it can and the wasm one otherwise — the choice is made by what exists, not by a preference
 * file that could disagree with it.
 */
function workerEnv(modelDir: string, threads: number): NodeJS.ProcessEnv {
    const nativeDir = nativeRuntimeDir(modelDir);
    const present = nativeDir !== undefined && nativeRuntimePresent(modelDir);

    return {
        ...process.env,
        PI_OUTLINE_MODEL_DIR: modelDir,
        PI_OUTLINE_THREADS: String(threads),
        ...(present ? { PI_OUTLINE_NATIVE_DIR: nativeDir } : {}),
    };
}

/**
 * A client for the embedding child process.
 *
 * The child holds the wasm session, because loading it takes seconds and 166 MB of weights; spawning it per
 * query would make every semantic search pay model startup. It is spawned on first use, kept warm for a few
 * minutes of idleness, and killed on dispose. Any failure marks the runtime broken for the rest of the
 * session: a second attempt would fail the same way, and lexical search must keep working.
 */
export function createEmbedRuntime(options: { modelDir: string }): EmbedRuntime {
    let child: ChildProcess | undefined;
    let ready: Promise<void> | undefined;
    let broken = false;
    let nextId = 0;
    let idle: NodeJS.Timeout | undefined;
    let stderr = "";
    const pending = new Map<number, PendingRequest>();

    const close = (): void => {
        if (idle !== undefined) {
            clearTimeout(idle);
            idle = undefined;
        }

        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error("semantic: runtime stopped"));
        }

        pending.clear();
        child?.kill();
        child = undefined;
        ready = undefined;
    };

    const touch = (): void => {
        if (idle !== undefined) {
            clearTimeout(idle);
        }

        idle = setTimeout(close, IDLE_TIMEOUT_MS);
        idle.unref?.();
    };

    const start = (): Promise<void> => {
        if (broken) {
            return Promise.reject(new Error("semantic: runtime unavailable"));
        }

        if (ready !== undefined) {
            return ready;
        }

        const spawned = spawn(process.execPath, [WORKER_SCRIPT, "--serve"], {
            env: workerEnv(options.modelDir, nativeThreadCount("query", os.availableParallelism())),
            stdio: ["pipe", "pipe", "pipe"],
        });

        child = spawned;
        stderr = "";

        spawned.stderr?.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
        });

        ready = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                broken = true;
                close();
                reject(new Error("semantic: runtime did not start"));
            }, READY_TIMEOUT_MS);

            const lines = readline.createInterface({ input: spawned.stdout });

            lines.on("line", (line) => {
                let message: Record<string, unknown>;

                try {
                    message = JSON.parse(line) as Record<string, unknown>;
                } catch {
                    return;
                }

                if (message.type === "ready") {
                    clearTimeout(timeout);
                    resolve();

                    return;
                }

                if (message.type === "vector" && typeof message.id === "number") {
                    const request = pending.get(message.id);

                    if (request === undefined) {
                        return;
                    }

                    pending.delete(message.id);
                    clearTimeout(request.timer);

                    const buffer = Buffer.from(String(message.vector), "base64");
                    const copy = buffer.buffer.slice(
                        buffer.byteOffset,
                        buffer.byteOffset + buffer.byteLength,
                    );

                    request.resolve(new Float32Array(copy));

                    return;
                }

                if (message.type === "error") {
                    clearTimeout(timeout);
                    broken = true;
                    close();
                    reject(new Error(`semantic: ${String(message.message)}`));
                }
            });

            spawned.on("error", (error) => {
                clearTimeout(timeout);
                broken = true;
                close();
                reject(error);
            });

            spawned.on("exit", (code) => {
                clearTimeout(timeout);

                if (pending.size > 0) {
                    broken = true;
                    close();
                    reject(
                        new Error(
                            `semantic: runtime exited (${code ?? "signal"})${stderr.length > 0 ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`,
                        ),
                    );
                }
            });
        });

        return ready;
    };

    const embedQuery = async (text: string, signal?: AbortSignal): Promise<Float32Array> => {
        await start();
        signal?.throwIfAborted();
        touch();

        const id = (nextId += 1);

        return await new Promise<Float32Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error("semantic: embedding timed out"));
            }, REQUEST_TIMEOUT_MS);

            pending.set(id, { resolve, reject, timer });
            child?.stdin?.write(`${JSON.stringify({ id, type: "embed", text })}\n`);
        });
    };

    /** One `--build` child for one job file; the child writes its shards and reports progress. */
    const spawnBuild = (
        jobFile: string,
        threads: number,
        onProgress: (done: number, total: number) => void,
        signal?: AbortSignal,
        onShard?: (shard: BuildShard) => void,
    ): Promise<BuildShard[]> => {
        const spawned = spawn(process.execPath, [WORKER_SCRIPT, "--build", jobFile], {
            env: workerEnv(options.modelDir, threads),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let jobStderr = "";

        spawned.stderr?.on("data", (chunk: Buffer) => {
            jobStderr = `${jobStderr}${chunk.toString()}`.slice(-2_000);
        });

        const onAbort = (): void => {
            spawned.kill();
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        return new Promise<BuildShard[]>((resolve, reject) => {
            const settle = (): void => {
                signal?.removeEventListener("abort", onAbort);
            };
            const lines = readline.createInterface({ input: spawned.stdout });

            lines.on("line", (line) => {
                let message: Record<string, unknown>;

                try {
                    message = JSON.parse(line) as Record<string, unknown>;
                } catch {
                    return;
                }

                if (message.type === "shard") {
                    onShard?.({
                        shard: String(message.shard),
                        keys: message.keys as string[],
                    });

                    return;
                }

                if (message.type === "progress") {
                    onProgress(Number(message.done), Number(message.total));

                    return;
                }

                if (message.type === "done") {
                    settle();
                    resolve(message.shards as BuildShard[]);

                    return;
                }

                if (message.type === "error") {
                    settle();
                    reject(new Error(`semantic: ${String(message.message)}`));
                }
            });

            spawned.on("error", (error) => {
                settle();
                reject(error);
            });
            spawned.on("exit", (code) => {
                settle();

                if (code !== 0) {
                    reject(
                        new Error(
                            `semantic: build exited (${code ?? "signal"})${jobStderr.length > 0 ? `: ${jobStderr.trim().split("\n").at(-1)}` : ""}`,
                        ),
                    );
                }
            });
        });
    };

    /**
     * Embed the jobs across `buildWorkerCount()` children, or fewer when `maxWorkers` caps them.
     *
     * A job line is the unit a worker takes, and lines are assigned to the least-loaded worker, so no line can make
     * a worker finish long after the others. Shard names already carry the file hash and a part suffix, so parallel
     * children never collide; the manifest is written once by the caller after every child finished.
     */
    const build = async (
        indexDir: string,
        sourceFiles: BuildFile[],
        onProgress: (done: number, total: number) => void,
        signal?: AbortSignal,
        onShard?: (shard: BuildShard) => void,
        maxWorkers?: number,
    ): Promise<BuildShard[]> => {
        if (broken) {
            throw new Error("semantic: runtime unavailable");
        }

        signal?.throwIfAborted();
        fs.mkdirSync(indexDir, { recursive: true });

        const files = sourceFiles;
        const total = files.reduce((sum, file) => sum + file.entries.length, 0);
        const native = nativeRuntimePresent(options.modelDir);
        // Native threads live inside the process, so the split is few processes × several threads. The wasm runtime is
        // single-threaded, so there it stays one process per ~8 declarations: a refresh of three edited functions must
        // not load four model copies.
        const plan = native
            ? nativeBuildPlan({
                  declarations: total,
                  // A refresh passes maxWorkers, and its budget is a share of the machine: four threads in the one
                  // process, so an unattended build leaves the rest of the machine to the user's queries.
                  maxThreads: maxWorkers,
              })
            : {
                  processes: Math.max(
                      1,
                      Math.min(
                          maxWorkers ?? buildWorkerCount(),
                          files.length,
                          Math.ceil(total / 8),
                      ),
                  ),
                  threads: 1,
              };
        const workers = plan.processes;
        const batches: BuildFile[][] = Array.from({ length: workers }, () => []);
        const loads = new Array<number>(workers).fill(0);

        for (const file of files) {
            let target = 0;

            for (let index = 1; index < workers; index += 1) {
                if (loads[index] < loads[target]) {
                    target = index;
                }
            }

            batches[target].push(file);
            loads[target] += file.entries.length;
        }

        const done = new Array<number>(workers).fill(0);
        const shards: BuildShard[] = [];

        await Promise.all(
            batches.map(async (batchFiles, index) => {
                if (batchFiles.length === 0) {
                    return;
                }

                const jobFile = path.join(indexDir, `job-${index}.jsonl`);
                const lines = [
                    JSON.stringify({ indexDir, dims: MODEL_DIMS }),
                    ...batchFiles.map((file) => JSON.stringify(file)),
                ];

                fs.writeFileSync(jobFile, `${lines.join("\n")}\n`);

                shards.push(
                    ...(await spawnBuild(
                        jobFile,
                        plan.threads,
                        (value) => {
                            done[index] = value;
                            onProgress(
                                done.reduce((sum, count) => sum + count, 0),
                                total,
                            );
                        },
                        signal,
                        onShard,
                    )),
                );
            }),
        );

        return shards;
    };

    return {
        embedQuery,
        build,
        dispose() {
            broken = true;
            close();
        },
    };
}
