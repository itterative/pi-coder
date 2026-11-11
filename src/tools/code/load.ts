import { yieldToEventLoop } from "../../common/async";
import { TwoQueueCache } from "./cache";
import { parseCodeFile } from "./parse";
import { WORKER_PARSE_THRESHOLD_BYTES, parseFileInWorker } from "./worker";
import { MAX_FILE_BYTES, languageForPath } from "./languages";
import type { CodeFileStat, CodeSource } from "./source";
import type { ParsedFile } from "./types";

interface CacheEntry {
    mtimeMs: number;
    size: number;
    parsed: ParsedFile;
}

const CACHE_ENTRY_LIMIT = 2_000;
const CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const cache = new TwoQueueCache<string, CacheEntry>({
    entryLimit: CACHE_ENTRY_LIMIT,
    byteLimit: CACHE_BYTE_LIMIT,
});

export type LoadResult =
    | { kind: "parsed"; parsed: ParsedFile; fromCache: boolean }
    | { kind: "skipped"; reason: "unsupported" | "too-large" | "directory" }
    | { kind: "error"; message: string };

/** Tests use this between cases; production code relies on mtime/size validation. */
export function clearCodeCache(): void {
    cache.clear();
}

export async function loadParsedFile(
    source: CodeSource,
    target: string,
    signal?: AbortSignal,
): Promise<LoadResult> {
    signal?.throwIfAborted();

    const language = languageForPath(target);

    if (language === undefined) {
        return { kind: "skipped", reason: "unsupported" };
    }

    let stat: CodeFileStat;

    // Confinement is checked per file, not just for the requested root: a symlink below the root must not
    // become a read path the `read` gate would have refused.
    try {
        await source.assertReadable(target);
        stat = await source.stat(target);
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }

        return { kind: "error", message: messageOf(error) };
    }

    if (stat.isDirectory) {
        return { kind: "skipped", reason: "directory" };
    }

    if (stat.size > MAX_FILE_BYTES) {
        return { kind: "skipped", reason: "too-large" };
    }

    const key = `${source.kind}\u0000${target}`;
    const cached = cache.get(key);

    if (cached !== undefined) {
        if (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return { kind: "parsed", parsed: cached.parsed, fromCache: true };
        }

        // Do not leave a known-stale value in the cache while the replacement is being read and parsed.
        cache.delete(key);
    }

    signal?.throwIfAborted();

    let content: string;

    try {
        content = await source.readFile(target);
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }

        return { kind: "error", message: messageOf(error) };
    }

    signal?.throwIfAborted();

    try {
        const parsed =
            stat.size >= WORKER_PARSE_THRESHOLD_BYTES
                ? ((await parseFileInWorker(content, target, language, signal)) ??
                  (await parseCodeFile(content, target, language)))
                : await parseCodeFile(content, target, language);

        cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, parsed }, parsed.size);

        return { kind: "parsed", parsed, fromCache: false };
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }

        return { kind: "error", message: messageOf(error) };
    }
}

export interface LoadBatch {
    parsed: ParsedFile[];
    tooLarge: number;
    errors: string[];
    /** Files served from the parse cache, and files read and parsed in this call. */
    cached: number;
    fresh: number;
}

export async function loadParsedFiles(
    source: CodeSource,
    targets: readonly string[],
    signal?: AbortSignal,
    concurrency = 8,
): Promise<LoadBatch> {
    const parsed: ParsedFile[] = [];
    const errors: string[] = [];
    let tooLarge = 0;
    let cached = 0;
    let fresh = 0;
    let next = 0;

    const worker = async (): Promise<void> => {
        while (next < targets.length) {
            const index = next;
            next += 1;
            const target = targets[index];

            if (target === undefined) {
                continue;
            }

            const result = await loadParsedFile(source, target, signal);

            switch (result.kind) {
                case "parsed":
                    parsed.push(result.parsed);

                    if (result.fromCache) {
                        cached += 1;
                    } else {
                        fresh += 1;

                        await yieldToEventLoop(0, signal);
                    }

                    break;
                case "skipped":
                    if (result.reason === "too-large") {
                        tooLarge += 1;
                    }

                    break;
                case "error":
                    errors.push(`${source.displayPath(target)}: ${result.message}`);

                    break;
            }
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());

    await Promise.all(workers);

    return { parsed, tooLarge, errors, cached, fresh };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
