import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where one embedding lives: a shard file plus a record offset inside it. */
export interface StoredEntry {
    shard: string;
    offset: number;
}

/**
 * A namespace's index: content-keyed vectors plus the shards that hold them.
 *
 * Entries are keyed by the hash of the embedded text, never by path or mtime, so an edited declaration misses
 * its key and gets re-embedded while every untouched neighbour keeps its vector.
 */
export interface IndexManifest {
    version: 1;
    modelId: string;
    dims: number;
    textVersion: string;
    entries: Record<string, StoredEntry>;
    shards: Record<string, { count: number }>;
    /** ISO time of the last manifest write; reporting only, never part of a key. */
    builtAt?: string;
    /** Filesystem view the vectors were built from; lets a subdirectory search find an ancestor build. */
    sourceKind?: string;
    /** Absolute build root. Absent in indexes written before this field existed. */
    root?: string;
}

export function hashKey(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/**
 * Index namespace: a different filesystem view or model must not share vectors.
 *
 * A container session reads the container's files, so its declarations and paths differ from the host's even
 * for the same project; the source kind plus root keep the two apart.
 */
export function namespaceFor(
    sourceKind: string,
    root: string,
    modelId: string,
    textVersion: string,
): string {
    return createHash("sha256")
        .update(`${sourceKind}\u0000${root}\u0000${modelId}\u0000${textVersion}`)
        .digest("hex")
        .slice(0, 24);
}

export function indexDir(root: string, namespace: string): string {
    return path.join(root, "index", namespace);
}

export function emptyManifest(modelId: string, dims: number, textVersion: string): IndexManifest {
    return { version: 1, modelId, dims, textVersion, entries: {}, shards: {} };
}

const MANIFEST_FILE = "manifest.jsonl";
const LEGACY_MANIFEST_FILE = "manifest.json";
const LEGACY_JOURNAL_FILE = "journal.jsonl";

function manifestPath(dir: string): string {
    return path.join(dir, MANIFEST_FILE);
}

function headerLine(manifest: IndexManifest): string {
    return JSON.stringify({
        version: 1,
        modelId: manifest.modelId,
        dims: manifest.dims,
        textVersion: manifest.textVersion,
        ...(manifest.builtAt === undefined ? {} : { builtAt: manifest.builtAt }),
        ...(manifest.sourceKind === undefined ? {} : { sourceKind: manifest.sourceKind }),
        ...(manifest.root === undefined ? {} : { root: manifest.root }),
    });
}

/**
 * Read the index: `manifest.jsonl` is the manifest.
 *
 * The first line carries the metadata; every following line is one finished shard (`{ shard, keys }`) in
 * append order. A killed build therefore keeps every shard it wrote, and a later shard for the same key
 * overrides the earlier one, which is exactly what a rebuild does. The legacy `manifest.json` +
 * `journal.jsonl` pair is replayed first so an index written by the previous format still opens; the first
 * pruning build compacts it away.
 *
 * The parsed result is cached per directory and invalidated by a stat of every file it was built from, because
 * `resolveIndex` reads it once per semantic search. The index only ever appends (or is compacted through a
 * rename, which changes the inode), so size, mtime, and inode are enough to notice a change. The returned
 * manifest is shared: treat it as read-only.
 */
export function readManifest(dir: string): IndexManifest | undefined {
    const stamps = manifestStamps(dir);
    const cached = manifestCache.get(dir);

    if (cached !== undefined && sameStamps(cached.stamps, stamps)) {
        return cached.manifest;
    }

    const manifest = readManifestFiles(dir);

    rememberManifest(dir, { stamps, manifest });

    return manifest;
}

/** One entry per index directory; the cache only exists to make repeated searches cheap. */
const manifestCache = new Map<string, ManifestCacheEntry>();
const MANIFEST_CACHE_LIMIT = 8;
/** A huge index is not worth holding: the replay of it is linear now, so reading it again is cheap. */
const MANIFEST_CACHE_MAX_ENTRIES = 100_000;

interface ManifestCacheEntry {
    stamps: readonly ManifestStamp[];
    manifest: IndexManifest | undefined;
}

/** What a stat says about one manifest input; `exists: false` also has to invalidate, so it is stamped too. */
interface ManifestStamp {
    exists: boolean;
    size: number;
    mtimeMs: number;
    ino: number;
}

/** Every file `readManifestFiles` reads, in the order it reads them. */
function manifestFiles(dir: string): string[] {
    return [
        path.join(dir, LEGACY_MANIFEST_FILE),
        path.join(dir, LEGACY_JOURNAL_FILE),
        manifestPath(dir),
    ];
}

function manifestStamps(dir: string): ManifestStamp[] {
    return manifestFiles(dir).map((file) => {
        try {
            const stat = fs.statSync(file);

            return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
        } catch {
            return { exists: false, size: 0, mtimeMs: 0, ino: 0 };
        }
    });
}

function sameStamps(left: readonly ManifestStamp[], right: readonly ManifestStamp[]): boolean {
    return (
        left.length === right.length &&
        left.every((stamp, index) => {
            const other = right[index];

            return (
                other !== undefined &&
                stamp.exists === other.exists &&
                stamp.size === other.size &&
                stamp.mtimeMs === other.mtimeMs &&
                stamp.ino === other.ino
            );
        })
    );
}

/** Keeps the newest entry per directory, and bounds how many manifests stay in memory. */
function rememberManifest(dir: string, entry: ManifestCacheEntry): void {
    manifestCache.delete(dir);

    const entries = Object.keys(entry.manifest?.entries ?? {}).length;

    if (entries > MANIFEST_CACHE_MAX_ENTRIES) {
        return;
    }

    manifestCache.set(dir, entry);

    while (manifestCache.size > MANIFEST_CACHE_LIMIT) {
        const oldest = manifestCache.keys().next().value;

        if (oldest === undefined) {
            return;
        }

        manifestCache.delete(oldest);
    }
}

/** Read from disk without the cache. The result is mutated by the replay, so it must be a fresh object. */
function readManifestFiles(dir: string): IndexManifest | undefined {
    let manifest = readLegacyManifest(dir);

    manifest = replayManifestFile(path.join(dir, LEGACY_JOURNAL_FILE), manifest);
    manifest = replayManifestFile(manifestPath(dir), manifest);

    return manifest;
}

function readLegacyManifest(dir: string): IndexManifest | undefined {
    try {
        const parsed: unknown = JSON.parse(
            fs.readFileSync(path.join(dir, LEGACY_MANIFEST_FILE), "utf8"),
        );

        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }

        const manifest = parsed as Partial<IndexManifest>;

        if (
            manifest.version !== 1 ||
            typeof manifest.modelId !== "string" ||
            typeof manifest.dims !== "number" ||
            typeof manifest.textVersion !== "string" ||
            typeof manifest.entries !== "object" ||
            typeof manifest.shards !== "object"
        ) {
            return undefined;
        }

        return manifest as IndexManifest;
    } catch {
        return undefined;
    }
}

export interface ManifestHeader {
    modelId: string;
    dims: number;
    textVersion: string;
    builtAt?: string;
    sourceKind?: string;
    root?: string;
}

/** First line of a manifest, without reading the whole (multi-megabyte) file. */
export function readManifestHeader(dir: string): ManifestHeader | undefined {
    let fd: number | undefined;

    try {
        fd = fs.openSync(path.join(dir, MANIFEST_FILE), "r");

        const buffer = Buffer.alloc(4096);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const line = buffer.subarray(0, read).toString("utf8").split("\n")[0];
        const parsed: unknown = JSON.parse(line ?? "");

        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }

        const fields = parsed as Record<string, unknown>;

        if (
            typeof fields.modelId !== "string" ||
            typeof fields.dims !== "number" ||
            typeof fields.textVersion !== "string"
        ) {
            return undefined;
        }

        return {
            modelId: fields.modelId,
            dims: fields.dims,
            textVersion: fields.textVersion,
            ...(typeof fields.builtAt === "string" ? { builtAt: fields.builtAt } : {}),
            ...(typeof fields.sourceKind === "string" ? { sourceKind: fields.sourceKind } : {}),
            ...(typeof fields.root === "string" ? { root: fields.root } : {}),
        };
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

function replayManifestFile(
    file: string,
    base: IndexManifest | undefined,
): IndexManifest | undefined {
    let text: string;

    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return base;
    }

    let manifest = base;
    // The keys each shard owns right now, so a replayed shard drops its earlier keys without scanning every
    // entry. `replaceShard` cannot be used here: it rebuilds the whole entries object per line, which made this
    // replay quadratic (664 lines over 11k entries measured 1.5 s, against 2 ms in place).
    const shardKeys = keyListsOf(base);

    for (const line of text.split("\n")) {
        if (line.trim().length === 0) {
            continue;
        }

        let record: unknown;

        try {
            record = JSON.parse(line);
        } catch {
            // A kill can leave a truncated final line; every complete line before it is still valid.
            continue;
        }

        if (typeof record !== "object" || record === null) {
            continue;
        }

        const fields = record as Record<string, unknown>;

        if (manifest === undefined) {
            if (
                fields.version === 1 &&
                typeof fields.modelId === "string" &&
                typeof fields.dims === "number" &&
                typeof fields.textVersion === "string"
            ) {
                manifest = {
                    version: 1,
                    modelId: fields.modelId,
                    dims: fields.dims,
                    textVersion: fields.textVersion,
                    entries: {},
                    shards: {},
                    ...(typeof fields.builtAt === "string" ? { builtAt: fields.builtAt } : {}),
                    ...(typeof fields.sourceKind === "string"
                        ? { sourceKind: fields.sourceKind }
                        : {}),
                    ...(typeof fields.root === "string" ? { root: fields.root } : {}),
                };
            }

            continue;
        }

        if (typeof fields.shard !== "string" || !Array.isArray(fields.keys)) {
            continue;
        }

        applyShardRecord(
            manifest,
            shardKeys,
            fields.shard,
            fields.keys.filter((key): key is string => typeof key === "string"),
        );
    }

    return manifest;
}

/** The keys each shard owns, for a manifest that is about to be replayed in place. */
function keyListsOf(manifest: IndexManifest | undefined): Map<string, string[]> {
    const lists = new Map<string, string[]>();

    if (manifest === undefined) {
        return lists;
    }

    for (const [key, entry] of Object.entries(manifest.entries)) {
        const existing = lists.get(entry.shard);

        if (existing === undefined) {
            lists.set(entry.shard, [key]);
        } else {
            existing.push(key);
        }
    }

    return lists;
}

/**
 * Apply one `{ shard, keys }` record in place.
 *
 * This is `replaceShard` without the copy: replayed manifests are freshly read and owned by this module, and a
 * long-lived index appends one line per shard per build, so the copying version is quadratic in the file length.
 */
function applyShardRecord(
    manifest: IndexManifest,
    shardKeys: Map<string, string[]>,
    shard: string,
    keys: readonly string[],
): void {
    for (const key of shardKeys.get(shard) ?? []) {
        delete manifest.entries[key];
    }

    for (const [offset, key] of keys.entries()) {
        manifest.entries[key] = { shard, offset };
    }

    shardKeys.set(shard, [...keys]);
    manifest.shards[shard] = { count: keys.length };
}

/**
 * Append one finished shard: one line when the shard file is already durable.
 *
 * This is the only per-shard write. Nothing is rewritten, so the cost does not grow with the index.
 */
export function appendManifestShard(
    dir: string,
    manifest: IndexManifest,
    shard: string,
    keys: readonly string[],
): void {
    const file = manifestPath(dir);

    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `${headerLine(manifest)}\n`);
    }

    fs.appendFileSync(file, `${JSON.stringify({ shard, keys })}\n`);
}

/**
 * Compact the manifest into its canonical form: header plus one line per live shard, keys ordered by offset.
 *
 * Called once when a build prunes (or when an empty build needs to fold the legacy files away), never by an
 * incremental refresh: those only append.
 */
export function writeManifest(dir: string, manifest: IndexManifest): void {
    const file = manifestPath(dir);
    const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
    const byShard = new Map<string, Array<{ key: string; offset: number }>>();

    for (const [key, entry] of Object.entries(manifest.entries)) {
        const keys = byShard.get(entry.shard);

        if (keys === undefined) {
            byShard.set(entry.shard, [{ key, offset: entry.offset }]);
        } else {
            keys.push({ key, offset: entry.offset });
        }
    }

    const lines = [headerLine(manifest)];

    for (const [shard, entries] of byShard) {
        entries.sort((left, right) => left.offset - right.offset);
        lines.push(JSON.stringify({ shard, keys: entries.map((entry) => entry.key) }));
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temporary, `${lines.join("\n")}\n`);
    fs.renameSync(temporary, file);
    fs.rmSync(path.join(dir, LEGACY_MANIFEST_FILE), { force: true });
    fs.rmSync(path.join(dir, LEGACY_JOURNAL_FILE), { force: true });
}

/** Shard id for a source file: stable across runs, independent of its declarations. */
export function shardForFile(filePath: string): string {
    return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function shardPath(dir: string, shard: string): string {
    return path.join(dir, "shards", `${shard}.bin`);
}

/** Write one shard from in-memory vectors, atomically. Used by tests and by callers that embed in-process. */
export function writeShard(
    dir: string,
    shard: string,
    vectors: readonly Float32Array[],
    dims: number,
): void {
    const file = shardPath(dir, shard);
    const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
    const buffer = Buffer.alloc(vectors.length * dims * Float32Array.BYTES_PER_ELEMENT);
    let offset = 0;

    for (const vector of vectors) {
        for (const value of vector) {
            buffer.writeFloatLE(value, offset);
            offset += Float32Array.BYTES_PER_ELEMENT;
        }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, file);
}

/** Point a shard's keys at its records, replacing whatever the manifest had for that shard. */
export function replaceShard(
    manifest: IndexManifest,
    shard: string,
    keys: readonly string[],
): IndexManifest {
    const entries: Record<string, StoredEntry> = {};

    for (const [key, entry] of Object.entries(manifest.entries)) {
        if (entry.shard !== shard) {
            entries[key] = entry;
        }
    }

    for (const [offset, key] of keys.entries()) {
        entries[key] = { shard, offset };
    }

    return {
        ...manifest,
        entries,
        shards: { ...manifest.shards, [shard]: { count: keys.length } },
    };
}

/** Load the vectors for the given keys, reading each shard at most once. */
export function readVectors(
    dir: string,
    manifest: IndexManifest,
    keys: Iterable<string>,
): Map<string, Float32Array> {
    const byShard = new Map<string, Array<{ key: string; offset: number }>>();
    const vectors = new Map<string, Float32Array>();

    for (const key of keys) {
        const entry = manifest.entries[key];

        if (entry === undefined) {
            continue;
        }

        const bucket = byShard.get(entry.shard) ?? [];
        bucket.push({ key, offset: entry.offset });
        byShard.set(entry.shard, bucket);
    }

    for (const [shard, wanted] of byShard) {
        let floats: Float32Array;

        try {
            const buffer = fs.readFileSync(shardPath(dir, shard));
            const copy = buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength,
            );
            floats = new Float32Array(copy);
        } catch {
            // A missing or truncated shard is treated as absent vectors; the next build rewrites it.
            continue;
        }

        for (const { key, offset } of wanted) {
            const start = offset * manifest.dims;
            const end = start + manifest.dims;

            if (end <= floats.length) {
                vectors.set(key, floats.slice(start, end));
            }
        }
    }

    return vectors;
}

/**
 * Stale entries worth a manifest rewrite on their own: both an absolute and a relative floor.
 *
 * Dead vectors are only bytes (they can never match: the lookup key is recomputed from current text), so
 * compaction is housekeeping. The floor keeps a tiny index from being rewritten over a handful of strays, and the
 * ratio keeps a large healthy index from being rewritten over a few edits.
 */
export const COMPACT_MIN_DEAD = 64;
export const COMPACT_DEAD_RATIO = 0.1;

export function shouldCompact(dead: number, live: number): boolean {
    return dead >= COMPACT_MIN_DEAD && dead >= live * COMPACT_DEAD_RATIO;
}

/** Drop entries whose declaration no longer exists, and delete the shards that became empty. */
export function pruneManifest(
    dir: string,
    manifest: IndexManifest,
    liveKeys: ReadonlySet<string>,
): IndexManifest {
    const entries: Record<string, StoredEntry> = {};

    for (const [key, entry] of Object.entries(manifest.entries)) {
        if (liveKeys.has(key)) {
            entries[key] = entry;
        }
    }

    const used = new Set(Object.values(entries).map((entry) => entry.shard));
    const shards: IndexManifest["shards"] = {};

    for (const shard of used) {
        shards[shard] = { count: manifest.shards[shard]?.count ?? 0 };
    }

    for (const shard of Object.keys(manifest.shards)) {
        if (!used.has(shard)) {
            fs.rmSync(shardPath(dir, shard), { force: true });
        }
    }

    return { ...manifest, entries, shards };
}

/** Cosine similarity for already-normalized vectors; a plain dot product. */
export function cosine(left: Float32Array, right: Float32Array): number {
    let sum = 0;
    const length = Math.min(left.length, right.length);

    for (let index = 0; index < length; index += 1) {
        sum += left[index] * right[index];
    }

    return sum;
}

/** L2-normalize in place so every later comparison is a dot product. */
export function normalizeVector(vector: Float32Array): Float32Array {
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
