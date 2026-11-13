import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

import { modelProfile } from "./profiles";

/**
 * The embedding server: one `llama-server` child, spoken to over loopback HTTP.
 *
 * This replaces the ORT worker, and it is where the model actually lives. llama.cpp offers no in-process binding we
 * could use without shipping a compiler or a third-party dependency, and its server already speaks OpenAI's
 * `/v1/embeddings` shape, so a child process is not a workaround here — it is the supported interface.
 *
 * Two consequences drive the rest of the design. The model is loaded once per runtime instead of once per build
 * worker, so a build no longer multiplies resident memory by the core count. And the server serialises embedding
 * requests, so `build()` sends several at once and lets the queue absorb them: measured 1.38x over sequential at 257
 * tokens on a Vulkan device, 1.00x on CPU.
 */
export interface EmbedServer {
    embed(text: string, signal?: AbortSignal): Promise<Float32Array>;
    dispose(): void;
}

export interface ServerOptions {
    binary: string;
    modelFile: string;
    /** GPU layers: every layer on a Vulkan device, none for the CPU bundle. */
    gpuLayers: number;
    threads?: number;
    /** Diagnostics hook: llama-server's own log, line by line. */
    onOutput?: (text: string) => void;
}

const READY_TIMEOUT_MS = 120_000;

/**
 * Context and batch geometry, fixed rather than configured.
 *
 * 8k context is well beyond what the build sends (the text is capped below it), and `-b`/`-ub` must be at least as
 * large as one document: llama-server rejects an input longer than the physical batch with "increase the physical
 * batch size", which reads like a context error and is not one — measured at 4,096 against a 5,147-token section.
 */
const CONTEXT_TOKENS = 8_192;
const BATCH_TOKENS = 4_096;

/** One free loopback port. Racy by nature; a lost race fails the start, which the runtime treats as fatal. */
async function freePort(): Promise<number> {
    const probe = net.createServer();

    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));

    const address = probe.address();

    await new Promise<void>((resolve) => probe.close(() => resolve()));

    return typeof address === "object" && address !== null ? address.port : 0;
}

function threadCount(): number {
    const configured = Number.parseInt((process.env.PI_CODER_OUTLINE_THREADS ?? "").trim(), 10);
    const cores = Math.max(1, os.availableParallelism());

    if (Number.isFinite(configured) && configured > 0) {
        return Math.min(configured, cores);
    }

    // Eight is the measured knee for llama.cpp prefill on this hardware, and a query is one short sequence that does
    // not benefit from more threads than that.
    return Math.max(1, Math.min(8, cores));
}

/**
 * One embedding request.
 *
 * The server L2-normalises what it returns (`--embd-normalize` defaults to 2), which is what the store and the cosine
 * ranking assume. A width mismatch is a hard error rather than a silent mis-ranking: `cosine` truncates at the
 * shorter vector, so a 768-wide vector against a 1024-wide query would score plausibly and wrongly.
 */
async function requestEmbedding(
    endpoint: string,
    text: string,
    signal: AbortSignal | undefined,
): Promise<Float32Array> {
    const response = await fetch(`${endpoint}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text }),
        signal: signal as RequestInit["signal"],
    });

    if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        const error = new Error(`semantic: embedding failed (${response.status}): ${detail}`);

        (error as Error & { tooLarge?: boolean }).tooLarge =
            response.status === 500 && detail.includes("too large");

        throw error;
    }

    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const raw = body.data?.[0]?.embedding;

    if (!Array.isArray(raw)) {
        throw new Error("semantic: embedding response carried no vector");
    }

    const { dims, id } = modelProfile();

    if (raw.length !== dims) {
        throw new Error(`semantic: ${id} returned width ${raw.length}, expected ${dims}`);
    }

    return Float32Array.from(raw);
}

/**
 * Start the server and wait until it answers `/health`.
 *
 * The child is killed on `process.exit` as well as by `dispose()`. An orphan here is not a leaked handle: it is a
 * process still holding several hundred MB of VRAM while the user's own GPU work fails to fit, which is exactly what
 * happened the first time this was driven by hand.
 */
export async function startEmbedServer(options: ServerOptions): Promise<EmbedServer> {
    fs.accessSync(options.binary, fs.constants.X_OK);

    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const args = [
        "-m",
        options.modelFile,
        "--embeddings",
        "-c",
        String(CONTEXT_TOKENS),
        "-b",
        String(BATCH_TOKENS),
        "-ub",
        String(BATCH_TOKENS),
        "-t",
        String(options.threads ?? threadCount()),
        "-ngl",
        String(options.gpuLayers),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-webui",
    ];

    const child: ChildProcess = spawn(options.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let disposed = false;
    let failure: Error | undefined;

    const killOnExit = (): void => {
        child.kill("SIGKILL");
    };
    const stop = (): void => {
        if (disposed) {
            return;
        }

        disposed = true;
        process.removeListener("exit", killOnExit);
        child.kill("SIGKILL");
    };

    process.once("exit", killOnExit);

    const record = (chunk: Buffer): void => {
        const text = chunk.toString();

        log = `${log}${text}`.slice(-4_000);
        options.onOutput?.(text);
    };

    child.stderr?.on("data", record);
    child.stdout?.on("data", record);

    // Resolves (never rejects) when the child goes away, so the readiness loop can fail with the child's own words
    // instead of a timeout that says nothing. A rejection here would also be unhandled once ready wins the race.
    const exited = new Promise<void>((resolve) => {
        child.once("exit", (code, signal) => {
            if (!disposed) {
                failure = new Error(
                    `semantic: llama-server exited (${code ?? signal ?? "unknown"})` +
                        `${log.trim().length > 0 ? `: ${log.trim().split("\n").at(-1)}` : ""}`,
                );
            }

            resolve();
        });
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let up = false;

    while (!up && Date.now() < deadline) {
        const tick = await Promise.race([
            new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 100)),
            exited.then(() => "exit" as const),
        ]);

        if (tick === "exit") {
            stop();

            throw failure ?? new Error("semantic: llama-server exited before it was ready");
        }

        try {
            const response = await fetch(`${endpoint}/health`, {
                signal: AbortSignal.timeout(2_000),
            });

            up = response.ok;
        } catch {
            // Still loading the model.
        }
    }

    if (!up) {
        stop();

        throw new Error(
            `semantic: llama-server did not become ready in ${READY_TIMEOUT_MS / 1_000}s` +
                `${log.trim().length > 0 ? `: ${log.trim().split("\n").at(-1)}` : ""}`,
        );
    }

    return {
        async embed(text: string, signal?: AbortSignal): Promise<Float32Array> {
            try {
                return await requestEmbedding(endpoint, text, signal);
            } catch (error) {
                // A text over the physical batch is the one recoverable failure, and it recovers by itself: half of a
                // section still says what the section is about, and losing the vector would lose the row entirely.
                if ((error as { tooLarge?: boolean }).tooLarge === true) {
                    return requestEmbedding(
                        endpoint,
                        text.slice(0, Math.max(1, text.length >> 1)),
                        signal,
                    );
                }

                throw error;
            }
        },
        dispose: stop,
    };
}
