import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in `llama-server` for tests: the same CLI surface, `/health` and `/v1/embeddings`, and no model.
 *
 * The real binary is a 639 MB download plus a GPU probe, so tests spawn this instead and point the runtime at it with
 * `PI_CODER_OUTLINE_LLAMA_SERVER`. Vectors are a deterministic function of the text, which is enough to prove that a
 * shard holds the vectors for the keys beside it, and the served texts are logged so a test can assert the prefix a
 * profile applies without depending on a specific model.
 */
const FAKE = `import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const dims = Number(process.env.FAKE_LLAMA_DIMS ?? "1024");
const log = process.env.FAKE_LLAMA_LOG;

// A start line makes "how many servers did this run spawn" observable, which is what the transient-GPU rule is about.
if (log !== undefined) {
    fs.appendFileSync(log, JSON.stringify({ start: true }) + "\\n");
}

if (process.env.FAKE_LLAMA_FAIL_START === "1") {
    process.stderr.write("fake llama-server: refusing to start\\n");
    process.exit(1);
}

// A GPU that cannot allocate is simulated with the flag the runtime actually passes to a Vulkan server.
if (process.env.FAKE_LLAMA_FAIL_GPU === "1" && Number(args[args.indexOf("-ngl") + 1]) > 0) {
    process.stderr.write("fake llama-server: failed to allocate Vulkan buffer\\n");
    process.exit(1);
}

function vectorOf(text) {
    const out = new Float32Array(dims);
    const digest = createHash("sha256").update(text).digest();
    let seed = 0;

    for (let index = 0; index < dims; index += 1) {
        if (index % digest.length === 0) {
            seed += 1;
        }

        const byte = digest[index % digest.length];
        out[index] = (byte / 255 - 0.5) * (1 + seed / 16);
    }

    let norm = 0;

    for (const value of out) {
        norm += value * value;
    }

    norm = Math.sqrt(norm) || 1;

    for (let index = 0; index < dims; index += 1) {
        out[index] /= norm;
    }

    return Array.from(out);
}

const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        return;
    }

    if (request.method === "POST" && request.url === "/v1/embeddings") {
        let body = "";

        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            const input = JSON.parse(body).input;

            if (log !== undefined) {
                fs.appendFileSync(log, JSON.stringify({ input }) + "\\n");
            }

            if (process.env.FAKE_LLAMA_FAIL_EMBED === "1") {
                response.writeHead(500, { "content-type": "text/plain" });
                response.end("fake failure");
                return;
            }

            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ embedding: vectorOf(input) }] }));
        });
        return;
    }

    response.writeHead(404);
    response.end();
});

server.listen(port, "127.0.0.1");
`;

export interface LlamaDouble {
    /** Pass as `PI_CODER_OUTLINE_LLAMA_SERVER`. */
    binary: string;
    /** Pass as `PI_CODER_OUTLINE_MODEL_FILE`; the fake never reads it. */
    modelFile: string;
    /** Every text the fake was asked to embed, in order. */
    served(): string[];
    /** How many server processes were started: one per request batch would mean a leak or a restart loop. */
    starts(): number;
    /** Raw log lines, including the start markers. */
    lines(): string[];
    dir: string;
    cleanup(): void;
}

export function createLlamaDouble(options: { dir?: string } = {}): LlamaDouble {
    const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-llama-double-"));
    const script = path.join(dir, "fake-llama-server.mjs");
    const binary = path.join(dir, "llama-server");
    const modelFile = path.join(dir, "model.gguf");
    const log = path.join(dir, "served.jsonl");

    fs.writeFileSync(script, FAKE);
    // The runtime spawns the path directly, so it has to be executable and name its interpreter: this is the shim the
    // real release tarball provides by shipping a real binary.
    fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(modelFile, "not a model\n");

    return {
        binary,
        modelFile,
        lines(): string[] {
            if (!fs.existsSync(log)) {
                return [];
            }

            return fs
                .readFileSync(log, "utf8")
                .split("\n")
                .filter((line) => line.trim().length > 0);
        },
        starts(): number {
            return this.lines().filter(
                (line) => (JSON.parse(line) as { start?: boolean }).start === true,
            ).length;
        },
        served(): string[] {
            if (!fs.existsSync(log)) {
                return [];
            }

            return this.lines()
                .map((line) => (JSON.parse(line) as { input?: string }).input)
                .filter((input): input is string => input !== undefined);
        },
        dir,
        cleanup(): void {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Environment for a runtime pointed at the double, restoring nothing: callers use `withEnv` or set these themselves. */
export function llamaDoubleEnv(double: LlamaDouble, dims: number): NodeJS.ProcessEnv {
    return {
        PI_CODER_OUTLINE_LLAMA_SERVER: double.binary,
        PI_CODER_OUTLINE_MODEL_FILE: double.modelFile,
        FAKE_LLAMA_DIMS: String(dims),
        FAKE_LLAMA_LOG: path.join(double.dir, "served.jsonl"),
    };
}
