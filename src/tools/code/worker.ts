import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { PI_CODER_EXTENSION_DIR } from "../../common/constants";
import type { SupportedLanguage } from "./languages";
import type { ParsedFile } from "./types";
import type { UsageIndex } from "./usages";

/** Files at or above this size use the worker; smaller parsing is faster inline than a worker round trip. */
export const WORKER_PARSE_THRESHOLD_BYTES = 256 * 1024;

const WORKER_SCRIPT = path.join(PI_CODER_EXTENSION_DIR, "src/tools/code/parse-worker.mjs");
const CODE_MODULE = path.join(PI_CODER_EXTENSION_DIR, "src/tools/code/parse.ts");
const USAGE_MODULE = path.join(PI_CODER_EXTENSION_DIR, "src/tools/code/usages.ts");

interface WorkerResultMap {
    parse: ParsedFile;
    usageIndex: UsageIndex;
}

type WorkerResult = {
    [K in keyof WorkerResultMap]: { kind: K; value: WorkerResultMap[K] };
}[keyof WorkerResultMap];

type WorkerRequest =
    | { kind: "parse"; source: string; path: string; language: SupportedLanguage }
    | { kind: "usageIndex"; file: ParsedFile };

interface PendingRequest {
    resolve: (result: WorkerResult | undefined) => void;
    reject: (error: unknown) => void;
    removeAbort: () => void;
}

let worker: Worker | undefined;
let workerUnavailable = false;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();

/**
 * Parse a large file off the extension's main thread.
 *
 * The worker is lazy and one per process. A missing TypeScript loader, a failed worker start, or a worker
 * failure all return `undefined`, which lets the caller fall back to inline parsing without changing the
 * tool's result. Cancellation terminates the worker, so the caller's abort reaches the next file promptly.
 */
export async function parseFileInWorker(
    source: string,
    filePath: string,
    language: SupportedLanguage,
    signal?: AbortSignal,
): Promise<ParsedFile | undefined> {
    const result = await requestWorker({ kind: "parse", source, path: filePath, language }, signal);

    return result?.kind === "parse" ? result.value : undefined;
}

/** Build a `usages` identifier index for a large cached file outside the main thread. */
export async function buildUsageIndexInWorker(
    file: ParsedFile,
    signal?: AbortSignal,
): Promise<UsageIndex | undefined> {
    const result = await requestWorker({ kind: "usageIndex", file }, signal);

    return result?.kind === "usageIndex" ? result.value : undefined;
}

async function requestWorker(
    request: WorkerRequest,
    signal?: AbortSignal,
): Promise<WorkerResult | undefined> {
    if (signal?.aborted) {
        throw abortReason(signal);
    }

    const activeWorker = getWorker();

    if (activeWorker === undefined) {
        return undefined;
    }

    const id = nextRequestId;
    nextRequestId += 1;

    return await new Promise<WorkerResult | undefined>((resolve, reject) => {
        const onAbort = (): void => {
            const entry = pending.get(id);

            if (entry === undefined) {
                return;
            }

            pending.delete(id);
            entry.removeAbort();
            terminateWorker();
            reject(abortReason(signal));
        };
        const entry: PendingRequest = {
            resolve,
            reject,
            removeAbort: () => signal?.removeEventListener("abort", onAbort),
        };

        pending.set(id, entry);
        signal?.addEventListener("abort", onAbort, { once: true });
        activeWorker.ref();

        try {
            activeWorker.postMessage({ id, ...request });
        } catch {
            pending.delete(id);
            entry.removeAbort();
            settleIdle();
            resolve(undefined);
        }
    });
}

function getWorker(): Worker | undefined {
    if (workerUnavailable) {
        return undefined;
    }

    if (worker !== undefined) {
        return worker;
    }

    const jitiPath = resolveJitiPath();

    if (jitiPath === undefined) {
        workerUnavailable = true;

        return undefined;
    }

    try {
        const created = new Worker(WORKER_SCRIPT, {
            workerData: {
                jitiPath,
                codeModulePath: CODE_MODULE,
                usageModulePath: USAGE_MODULE,
            },
        });

        created.unref();
        created.on("message", onWorkerMessage);
        created.on("error", onWorkerFailure);
        created.on("exit", onWorkerExit);
        worker = created;

        return created;
    } catch {
        workerUnavailable = true;

        return undefined;
    }
}

function onWorkerMessage(message: unknown): void {
    if (!isWorkerMessage(message)) {
        return;
    }

    const entry = pending.get(message.id);

    if (entry === undefined) {
        return;
    }

    pending.delete(message.id);
    entry.removeAbort();
    settleIdle();

    if (!message.ok) {
        entry.resolve(undefined);

        return;
    }

    const result = asWorkerResult(message.result);

    if (result === undefined) {
        entry.resolve(undefined);

        return;
    }

    entry.resolve(result);
}

function onWorkerFailure(): void {
    workerUnavailable = true;
    stopWorker();
}

function onWorkerExit(): void {
    if (worker === undefined) {
        return;
    }

    workerUnavailable = true;
    stopWorker();
}

function terminateWorker(): void {
    stopWorker();
}

function stopWorker(): void {
    const current = worker;

    worker = undefined;

    if (current !== undefined) {
        current.removeAllListeners();
        void current.terminate();
    }

    for (const entry of pending.values()) {
        entry.removeAbort();
        entry.resolve(undefined);
    }

    pending.clear();
}

function settleIdle(): void {
    if (pending.size === 0) {
        worker?.unref();
    }
}

function resolveJitiPath(): string | undefined {
    try {
        const extensionRequire = createRequire(path.join(PI_CODER_EXTENSION_DIR, "package.json"));

        try {
            return extensionRequire.resolve("jiti");
        } catch {
            const piEntry = extensionRequire.resolve("@earendil-works/pi-coding-agent");
            const piRequire = createRequire(piEntry);

            return piRequire.resolve("jiti");
        }
    } catch {
        return undefined;
    }
}

function abortReason(signal: AbortSignal | undefined): unknown {
    return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isWorkerMessage(value: unknown): value is {
    id: number;
    ok: boolean;
    result?: unknown;
} {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;

    return typeof record.id === "number" && typeof record.ok === "boolean";
}

function asWorkerResult(value: unknown): WorkerResult | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const record = value as Record<string, unknown>;

    if (record.kind === "parse" && "value" in record) {
        return { kind: "parse", value: record.value as ParsedFile };
    }

    if (record.kind === "usageIndex" && "value" in record) {
        return { kind: "usageIndex", value: record.value as UsageIndex };
    }

    return undefined;
}
