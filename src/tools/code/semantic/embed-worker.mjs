#!/usr/bin/env node
/**
 * Embedding worker: the only place the downloaded wasm runtime and model are loaded.
 *
 *   node embed-worker.mjs --serve                 JSON-lines query embeddings on stdin/stdout
 *   node embed-worker.mjs --build <job.json>      batch-embed a build job, writing shards
 *
 * It runs as a child process so a 200 MB wasm model never sits in the TUI's heap, and so a build can outlive
 * one tool call. `PI_OUTLINE_MODEL_DIR` points at a prepared artifact bundle (see artifacts.ts).
 *
 * Three constraints are load-bearing and were each verified against onnxruntime-web in Node:
 *  - the wasm build fetches its `.wasm` and the model, and Node's fetch rejects `file:` URLs, hence the shim;
 *  - worker threads bootstrap through a `blob:` module import, which Node's ESM loader refuses, hence
 *    `numThreads = 1`;
 *  - the q4 graph keeps its weights in `model_q4.onnx_data`, which the wasm backend only sees when it is
 *    mounted through `externalData`.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const QUERY_PREFIX = "task: code retrieval | query:";
const MODALITY_INPUTS = ["image_features", "video_features", "audio_features"];
const MODALITY_WIDTH = 512;
const MAX_TOKENS = 512;

const modelDir = process.env.PI_OUTLINE_MODEL_DIR;

if (modelDir === undefined) {
    fail("PI_OUTLINE_MODEL_DIR is not set");
}

const runtimeDir = path.join(modelDir, "runtime");
const graph = path.join(modelDir, "model", "model_q4.onnx");
const externalDataFile = path.join(modelDir, "model", "model_q4.onnx_data");

/** ort-web is a browser build: it calls fetch for both the wasm and the model. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith("file://")) {
        const data = await fsp.readFile(new URL(url));

        return new Response(data, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
        });
    }

    return realFetch(input, init);
};

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(message) {
    send({ type: "error", message });
    process.exit(1);
}

async function loadModel() {
    const ort = await import(pathToFileURL(path.join(runtimeDir, "ort.wasm.bundle.min.mjs")).href);

    ort.env.wasm.wasmPaths = `${pathToFileURL(runtimeDir).href}/`;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";

    const session = await ort.InferenceSession.create(pathToFileURL(graph).href, {
        executionProviders: ["wasm"],
        externalData: [
            {
                path: "model_q4.onnx_data",
                data: new Uint8Array(await fsp.readFile(externalDataFile)),
            },
        ],
    });
    const { Tokenizer } = await import(pathToFileURL(path.join(runtimeDir, "tokenizers.mjs")).href);
    const tokenizerJson = JSON.parse(
        await fsp.readFile(path.join(modelDir, "model", "tokenizer.json"), "utf8"),
    );
    const tokenizerConfig = JSON.parse(
        await fsp.readFile(path.join(modelDir, "model", "tokenizer_config.json"), "utf8"),
    );

    return { ort, session, tokenizer: new Tokenizer(tokenizerJson, tokenizerConfig) };
}

function normalize(vector) {
    let sum = 0;

    for (const value of vector) {
        sum += value * value;
    }

    const norm = Math.sqrt(sum);

    if (norm === 0) {
        return vector;
    }

    for (let index = 0; index < vector.length; index += 1) {
        vector[index] /= norm;
    }

    return vector;
}

function makeEmbedder({ ort, session, tokenizer }) {
    const inputs = new Set(session.inputNames);

    return async (text) => {
        const encoded = tokenizer.encode(text);
        // The model card recommends truncating at 512 tokens: longer docs dilute mean pooling and cost time
        // proportional to their length, and no declaration's doc comment needs more for retrieval.
        const ids = encoded.ids.slice(0, MAX_TOKENS);
        const mask = encoded.attention_mask.slice(0, MAX_TOKENS);
        const feed = {
            input_ids: new ort.Tensor(
                "int64",
                BigInt64Array.from(ids, (id) => BigInt(id)),
                [1, ids.length],
            ),
            attention_mask: new ort.Tensor(
                "int64",
                BigInt64Array.from(mask, (value) => BigInt(value)),
                [1, mask.length],
            ),
        };

        for (const name of MODALITY_INPUTS) {
            if (inputs.has(name)) {
                feed[name] = new ort.Tensor("float32", new Float32Array(0), [0, MODALITY_WIDTH]);
            }
        }

        const output = await session.run(feed);

        return normalize(Float32Array.from(output.sentence_embedding.data));
    };
}

async function serve() {
    const { ort, session, tokenizer } = await loadModel();
    const embed = makeEmbedder({ ort, session, tokenizer });

    send({ type: "ready" });

    const lines = readline.createInterface({ input: process.stdin });

    for await (const line of lines) {
        if (line.trim().length === 0) {
            continue;
        }

        let request;

        try {
            request = JSON.parse(line);
        } catch {
            continue;
        }

        if (request.type !== "embed") {
            continue;
        }

        try {
            const vector = await embed(`${QUERY_PREFIX} ${request.text}`);
            const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

            send({ id: request.id, type: "vector", vector: buffer.toString("base64") });
        } catch (error) {
            send({
                id: request.id,
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function writeShardFile(indexDir, shard, vectors, dims) {
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

async function build(jobFile) {
    // JSONL: one header line, then one line per source file. Stream-friendly and no giant array to parse.
    const lines = (await fsp.readFile(jobFile, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0);
    const header = JSON.parse(lines[0]);
    const files = lines.slice(1).map((line) => JSON.parse(line));
    const { ort, session, tokenizer } = await loadModel();
    const embed = makeEmbedder({ ort, session, tokenizer });
    const total = files.reduce((sum, file) => sum + file.entries.length, 0);
    const shards = [];
    let done = 0;

    fs.mkdirSync(header.indexDir, { recursive: true });

    for (const file of files) {
        const vectors = [];
        const keys = [];

        for (const entry of file.entries) {
            vectors.push(await embed(entry.text));
            keys.push(entry.key);
            done += 1;

            if (done % 5 === 0 || done === total) {
                send({ type: "progress", done, total });
            }
        }

        writeShardFile(header.indexDir, file.shard, vectors, header.dims);
        shards.push({ shard: file.shard, keys });
        // The parent writes the manifest as shards arrive, so a killed build keeps every finished shard.
        send({ type: "shard", shard: file.shard, keys });
    }

    send({ type: "done", shards });
    await fsp.rm(jobFile, { force: true }).catch(() => undefined);
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === "--serve") {
    await serve();
} else if (mode === "--build" && args[1] !== undefined) {
    await build(args[1]);
} else {
    fail(`unknown mode: ${mode ?? "(none)"}`);
}
