import fs from "node:fs";
import path from "node:path";

/**
 * One append-only record store, shared by every producer that writes development evidence to `.state/`.
 *
 * Producers keep their own record shapes: the only thing a log insists on is a `ts` to order by and a `v` to
 * migrate by. Rotation, generation naming, and torn-line tolerance live here rather than in each module because
 * two of them had already drifted the same way - the compaction trace and the sandbox decision log each renamed
 * the live file to `.1` unconditionally, so every rotation silently destroyed the previous generation, and each
 * kept its own copy of the size check that decides when to do it.
 *
 * The interface is storage-shaped on purpose. `append` takes a record and not a line, `read` takes a filter
 * struct rather than a path, and nothing in the contract mentions files or generations. Swapping in another
 * engine replaces `createJsonlRecordLog` and moves no caller, which is the reason for the seam: the alternative
 * was to discover its shape during a migration.
 */

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;

/** The minimum a record must offer. Every other field belongs to the producer. */
export interface EnvelopeRecord {
    /** Missing in logs written before records carried versions; readers normalize it to 0. */
    v?: number;
    /** ISO timestamp, which is what makes ordering across generations possible. */
    ts: string;
}

export interface RecordFilter<R> {
    /** Skip records strictly older than this, as an ISO string or epoch milliseconds. */
    since?: string | number;
    /** Keep only the newest N records. Applied after the other filters. */
    limit?: number;
    /**
     * Producer-specific predicates stay here rather than becoming named fields, because `session` means
     * nothing to the sandbox decision log and `blocked` means nothing to the compaction trace. An engine that
     * can push this down will; until then it is evaluated in the reader.
     */
    where?: (record: R) => boolean;
}

export interface RecordLogStats {
    /**
     * Display and diagnosis only. No caller may treat these as the contract, because a non-file engine has no
     * answer for them.
     */
    files: string[];
    bytes: number;
    /** Unparseable lines seen during the last read. A gap is allowed; a distortion is not. */
    malformed: number;
    /** Appends that failed. A record log explains a feature and must never gate it, so failures are counted here. */
    writeFailures: number;
}

export interface RecordLog<R extends EnvelopeRecord> {
    append(record: R): void;
    /** Chronological order, oldest first, across every retained generation. */
    read(filter?: RecordFilter<R>): R[];
    stats(): RecordLogStats;
    /**
     * Currently a no-op. It exists so a buffered or database-backed implementation can flush without any
     * caller changing, which is the specific way this one is likely to be replaced.
     */
    close(): void;
}

export interface JsonlRecordLogOptions {
    filePath: string;
    /** Rotate once the live file grows past this many bytes. Zero or less disables rotation. */
    maxBytes: number;
    /**
     * Rotated copies kept, the live file excluded: `generations: 10` means `file`, `file.1` ... `file.10`.
     * `.1` is the newest rotated segment, following the logrotate convention so the numbering needs no lookup.
     */
    generations: number;
    fileMode?: number;
    dirMode?: number;
}

function sizeOf(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

function exists(filePath: string): boolean {
    try {
        fs.statSync(filePath);
        return true;
    } catch {
        return false;
    }
}

/** Newest first: the live file, then `.1` through `.N`. */
function segmentOrder(filePath: string, generations: number): string[] {
    const files = [filePath];

    for (let generation = 1; generation <= generations; generation++) {
        files.push(`${filePath}.${String(generation)}`);
    }

    return files;
}

/** Oldest first, existing segments only, which is the order a reader must emit records in. */
function chronologicalOrder(filePath: string, generations: number): string[] {
    return segmentOrder(filePath, generations).filter(exists).reverse();
}

/**
 * Shift each generation one step older, then retire the live file.
 *
 * The order is the crash-safety story: the oldest copy goes first, so an interruption can lose history but can
 * never leave two segments claiming the same slot. Renames are the only movement, which on a copy-on-write
 * filesystem is a metadata update rather than a copy of the data.
 */
function rotate(filePath: string, generations: number): void {
    if (generations < 1) {
        fs.rmSync(filePath, { force: true });
        return;
    }

    fs.rmSync(`${filePath}.${String(generations)}`, { force: true });

    for (let generation = generations - 1; generation >= 1; generation--) {
        const from = `${filePath}.${String(generation)}`;
        if (exists(from)) {
            fs.renameSync(from, `${filePath}.${String(generation + 1)}`);
        }
    }

    fs.renameSync(filePath, `${filePath}.1`);
}

/**
 * How many rotated segments exist, without knowing the writer's budget.
 *
 * A reader that has to be configured with the same number as its writer drifts the moment one side changes, and
 * a log with no readers is worse than one that scanned a few absent slots. Stops at the first gap, because a
 * missing `.2` means `.3` can only be left over from a smaller budget.
 */
export function discoverGenerations(filePath: string, ceiling = 64): number {
    let found = 0;

    for (let generation = 1; generation <= ceiling; generation++) {
        if (!exists(`${filePath}.${String(generation)}`)) {
            break;
        }
        found = generation;
    }

    return found;
}

function normalize(raw: Record<string, unknown>): void {
    if (typeof raw.v !== "number") {
        raw.v = 0;
    }
}

/** Parse one line, reporting null for anything unreadable so the caller can count the gap. */
function parseLine(line: string): EnvelopeRecord | null {
    if (line.length === 0) {
        return null;
    }

    try {
        const raw = JSON.parse(line) as unknown;
        if (
            typeof raw !== "object" ||
            raw === null ||
            typeof (raw as EnvelopeRecord).ts !== "string"
        ) {
            return null;
        }

        const record = raw as Record<string, unknown>;
        normalize(record);
        return record as unknown as EnvelopeRecord;
    } catch {
        return null;
    }
}

function sinceMillis(since: string | number): number {
    const millis = typeof since === "number" ? since : Date.parse(since);
    return Number.isNaN(millis) ? 0 : millis;
}

export function createJsonlRecordLog<R extends EnvelopeRecord>(
    options: JsonlRecordLogOptions,
): RecordLog<R> {
    const fileMode = options.fileMode ?? DEFAULT_FILE_MODE;
    const dirMode = options.dirMode ?? DEFAULT_DIR_MODE;
    let writeFailures = 0;
    let malformed = 0;

    return {
        append(record: R): void {
            try {
                fs.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: dirMode });

                if (options.maxBytes > 0 && sizeOf(options.filePath) > options.maxBytes) {
                    rotate(options.filePath, options.generations);
                }

                fs.appendFileSync(options.filePath, `${JSON.stringify(record)}\n`, {
                    mode: fileMode,
                });
            } catch {
                writeFailures += 1;
            }
        },

        read(filter: RecordFilter<R> = {}): R[] {
            const out: R[] = [];
            const since = filter.since === undefined ? undefined : sinceMillis(filter.since);
            malformed = 0;

            for (const file of chronologicalOrder(options.filePath, options.generations)) {
                let content: string;
                try {
                    content = fs.readFileSync(file, "utf8");
                } catch {
                    continue;
                }

                for (const line of content.split("\n")) {
                    if (line.length === 0) {
                        continue;
                    }

                    const record = parseLine(line) as R | null;
                    if (record === null) {
                        // Includes a torn final line after an interrupted write, which is the one failure mode
                        // of an append-only log worth naming out loud.
                        malformed += 1;
                        continue;
                    }

                    if (since !== undefined && Date.parse(record.ts) < since) {
                        continue;
                    }

                    if (filter.where !== undefined && !filter.where(record)) {
                        continue;
                    }

                    out.push(record);
                }
            }

            if (
                typeof filter.limit === "number" &&
                filter.limit >= 0 &&
                filter.limit < out.length
            ) {
                return out.slice(out.length - filter.limit);
            }

            return out;
        },

        stats(): RecordLogStats {
            const files = chronologicalOrder(options.filePath, options.generations);

            return {
                files,
                bytes: files.reduce((sum, file) => sum + sizeOf(file), 0),
                malformed,
                writeFailures,
            };
        },

        close(): void {
            // Nothing is buffered while writes go straight to the file.
        },
    };
}
