/**
 * In-memory parse cache for `/stats` scans.
 *
 * The scan must always discover every transcript, so this cache never filters discovery: it only
 * lets a scan reuse the parse of a file whose bytes are provably unchanged. Entries are validated
 * against `(mtimeMs, size)` and the source root that produced them, and nothing is written to
 * disk, so a process restart or extension reload starts clean without any cache-format versioning.
 */

import type { FileScan, StatsSource } from "./types";

/** The two `fs.Stats` fields that identify a file's content revision. */
export interface FileStamp {
    mtimeMs: number;
    size: number;
}

interface CacheEntry extends FileStamp {
    source: StatsSource;
    scan: FileScan;
}

function matches(entry: CacheEntry, source: StatsSource, stamp: FileStamp): boolean {
    return entry.source === source && entry.mtimeMs === stamp.mtimeMs && entry.size === stamp.size;
}

export class TranscriptCache {
    private readonly entries = new Map<string, CacheEntry>();

    /** The cached parse for `path`, or null when any part of the stamp changed. */
    get(path: string, source: StatsSource, stamp: FileStamp): FileScan | null {
        const entry = this.entries.get(path);
        if (!entry || !matches(entry, source, stamp)) {
            return null;
        }

        return entry.scan;
    }

    set(path: string, source: StatsSource, stamp: FileStamp, scan: FileScan): void {
        this.entries.set(path, { source, mtimeMs: stamp.mtimeMs, size: stamp.size, scan });
    }

    /** Drop entries whose path discovery did not produce, keeping the cache bounded to live files. */
    retain(paths: ReadonlySet<string>): void {
        for (const path of this.entries.keys()) {
            if (!paths.has(path)) {
                this.entries.delete(path);
            }
        }
    }

    get size(): number {
        return this.entries.size;
    }
}
