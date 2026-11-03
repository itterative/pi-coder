/**
 * Scratchpad store policy: how long a scratchpad survives and how much space the store may keep.
 *
 * Scratchpads live under the agent dir rather than `os.tmpdir()`, so the host OS no longer reclaims them and
 * pi-coder owns cleanup. Two bounds keep the store finite without touching the runtime that is using it:
 *
 * - age: a scratchpad untouched for `retentionMs` is removed;
 * - size: once the store holds more than `totalBudgetBytes`, the oldest scratchpad that is not the active one
 *   and has been idle for at least `minimumEvictionAgeMs` is removed until the store fits again.
 *
 * A single scratchpad is bounded softly. `perScratchpadBytes` is a warning threshold, not a write-time quota:
 * a command can write into the directory without passing through a pi-coder hook, so a hard per-directory cap
 * would be a promise a redirect or `dd` could break. The runtime is warned once instead, and the prompt names
 * the threshold so an agent can stay under it.
 *
 * Measurement is bounded by `maxEntries` so a pathological tree cannot stall a session start: a truncated scan
 * reports a lower bound and never drives size eviction, because evicting on a partial total is worse than
 * leaving the store over budget until the next pass.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const SCRATCHPAD_PREFIX = "pi-coder-scratchpad-";

const DAY_MS = 24 * 60 * 60 * 1000;
const MEGABYTE = 1024 * 1024;

export interface ScratchpadPolicy {
    /** A scratchpad whose directory has not changed for this long is removed. */
    retentionMs: number;
    /** Size the whole store is evicted down to, oldest idle scratchpads first. */
    totalBudgetBytes: number;
    /** Warning threshold for one active scratchpad. */
    perScratchpadBytes: number;
    /**
     * Idle floor before size eviction may remove a scratchpad the age rule kept. It keeps a session that
     * started moments ago from being evicted because a burst of siblings arrived after it.
     */
    minimumEvictionAgeMs: number;
    /** Upper bound on entries one store pass may inspect, across every scratchpad in it. */
    maxEntries: number;
    /** Minimum gap between two size measurements of the same active scratchpad. */
    measureIntervalMs: number;
}

export const DEFAULT_SCRATCHPAD_POLICY: ScratchpadPolicy = {
    retentionMs: 7 * DAY_MS,
    totalBudgetBytes: 1024 * MEGABYTE,
    perScratchpadBytes: 256 * MEGABYTE,
    minimumEvictionAgeMs: DAY_MS,
    maxEntries: 50_000,
    measureIntervalMs: 30_000,
};

export interface ScratchpadMeasurement {
    bytes: number;
    /** False when the entry budget ran out; `bytes` is then a lower bound. */
    complete: boolean;
}

export interface ScratchpadStoreReport {
    removed: readonly string[];
    /** Size of the scratchpads left in the store; a lower bound when the scan was truncated. */
    retainedBytes: number;
    /** True when the store is still over budget after the pass, so nothing else could be evicted. */
    overBudget: boolean;
}

interface StoreEntry {
    path: string;
    modifiedAt: number;
    bytes: number;
}

interface MeasurementBudget {
    remaining: number;
}

/**
 * One bounded recursive measurement. Symlinks are never followed: a scratchpad file that points outside the
 * store must not make its target look like store usage, and a loop must not hang the pass.
 */
export async function measureScratchpad(
    directory: string,
    maxEntries: number,
): Promise<ScratchpadMeasurement> {
    const budget: MeasurementBudget = { remaining: maxEntries };
    return walk(directory, budget);
}

async function walk(directory: string, budget: MeasurementBudget): Promise<ScratchpadMeasurement> {
    let bytes = 0;
    const pending = [directory];

    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined) {
            break;
        }

        const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined);
        if (entries === undefined) {
            return { bytes, complete: false };
        }

        for (const entry of entries) {
            if (budget.remaining <= 0) {
                return { bytes, complete: false };
            }
            budget.remaining -= 1;

            const child = path.join(current, entry.name);
            const info = await lstat(child).catch(() => undefined);
            if (info === undefined) {
                continue;
            }
            if (info.isDirectory()) {
                pending.push(child);
                continue;
            }
            if (info.isFile()) {
                bytes += info.size;
            }
        }
    }

    return { bytes, complete: true };
}

/**
 * Remove idle scratchpads from one store.
 *
 * `activePath` is the scratchpad the calling runtime is using, so it is never removed even when it is the
 * oldest or the largest thing in the store. A candidate whose name is not a scratchpad name, or that is not a
 * real directory, is left alone: the store root is a user directory, and a stray entry there is not ours.
 */
export async function pruneScratchpads(
    root: string,
    options: { activePath?: string; policy: ScratchpadPolicy; now?: number },
): Promise<ScratchpadStoreReport> {
    const { policy } = options;
    const now = options.now ?? Date.now();
    const activePath =
        options.activePath === undefined ? undefined : path.resolve(options.activePath);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const budget: MeasurementBudget = { remaining: policy.maxEntries };
    const removed: string[] = [];
    const retained: StoreEntry[] = [];
    let complete = true;

    for (const entry of entries) {
        if (!entry.name.startsWith(SCRATCHPAD_PREFIX)) {
            continue;
        }

        const candidate = path.join(root, entry.name);
        if (activePath !== undefined && path.resolve(candidate) === activePath) {
            continue;
        }

        const info = await lstat(candidate).catch(() => undefined);
        if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
            continue;
        }

        if (now - info.mtimeMs > policy.retentionMs) {
            if (await removeDirectory(candidate)) {
                removed.push(candidate);
            }
            continue;
        }

        // The age rule keeps working after the measurement budget runs out; only the size half needs it.
        if (budget.remaining <= 0) {
            complete = false;
            continue;
        }

        const measurement = await walk(candidate, budget);
        if (!measurement.complete) {
            complete = false;
        }
        retained.push({ path: candidate, modifiedAt: info.mtimeMs, bytes: measurement.bytes });
    }

    let retainedBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
    let overBudget = false;

    if (complete && retainedBytes > policy.totalBudgetBytes) {
        const evictable = retained
            .filter((entry) => now - entry.modifiedAt >= policy.minimumEvictionAgeMs)
            .toSorted((left, right) => left.modifiedAt - right.modifiedAt);

        // Repeat until the store fits: an entry may have been removed concurrently, so a failed removal must
        // not stop the pass with a total that is still over budget.
        for (const entry of evictable) {
            if (retainedBytes <= policy.totalBudgetBytes) {
                break;
            }
            if (!(await removeDirectory(entry.path))) {
                continue;
            }
            retainedBytes -= entry.bytes;
            removed.push(entry.path);
        }

        overBudget = retainedBytes > policy.totalBudgetBytes;
    }

    return { removed, retainedBytes, overBudget };
}

export function formatStorageSize(bytes: number): string {
    if (bytes >= 1024 * MEGABYTE) {
        return `${Math.round(bytes / (1024 * MEGABYTE))} GB`;
    }
    return `${Math.round(bytes / MEGABYTE)} MB`;
}

export function formatRetention(retentionMs: number): string {
    const days = Math.max(1, Math.round(retentionMs / DAY_MS));
    return days === 1 ? "1 day" : `${days} days`;
}

async function removeDirectory(directory: string): Promise<boolean> {
    try {
        await rm(directory, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}
