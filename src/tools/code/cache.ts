interface CacheEntry<T> {
    value: T;
    bytes: number;
}

export interface TwoQueueCacheOptions {
    /** Maximum number of values retained. */
    entryLimit: number;
    /** Approximate maximum payload bytes retained. */
    byteLimit: number;
}

/**
 * A small 2Q cache: new entries start in a probationary FIFO, and a second access promotes them to a
 * protected LRU.
 *
 * The access pattern here is mostly sequential scans of a tree with occasional repeated symbols. A plain
 * LRU lets a one-off scan evict the hot files it has no reason to keep; the probation segment absorbs that
 * scan instead. Values live in either segment, so the total entry and byte bounds still apply.
 */
export class TwoQueueCache<K, V> {
    private readonly probation = new Map<K, CacheEntry<V>>();
    private readonly protectedEntries = new Map<K, CacheEntry<V>>();
    private bytes = 0;

    constructor(private readonly options: TwoQueueCacheOptions) {}

    get size(): number {
        return this.probation.size + this.protectedEntries.size;
    }

    get byteSize(): number {
        return this.bytes;
    }

    get(key: K): V | undefined {
        const protectedEntry = this.protectedEntries.get(key);

        if (protectedEntry !== undefined) {
            // Refresh the protected segment's insertion order so the oldest access is evicted first.
            this.protectedEntries.delete(key);
            this.protectedEntries.set(key, protectedEntry);

            return protectedEntry.value;
        }

        const probationEntry = this.probation.get(key);

        if (probationEntry === undefined) {
            return undefined;
        }

        this.probation.delete(key);
        this.protectedEntries.set(key, probationEntry);

        return probationEntry.value;
    }

    set(key: K, value: V, bytes: number): void {
        this.remove(key);

        this.probation.set(key, { value, bytes });
        this.bytes += bytes;
        this.trim(key);
    }

    delete(key: K): void {
        this.remove(key);
    }

    clear(): void {
        this.probation.clear();
        this.protectedEntries.clear();
        this.bytes = 0;
    }

    private remove(key: K): void {
        const probationEntry = this.probation.get(key);

        if (probationEntry !== undefined) {
            this.probation.delete(key);
            this.bytes -= probationEntry.bytes;

            return;
        }

        const protectedEntry = this.protectedEntries.get(key);

        if (protectedEntry !== undefined) {
            this.protectedEntries.delete(key);
            this.bytes -= protectedEntry.bytes;
        }
    }

    private trim(exemptKey: K): void {
        while (this.size > this.options.entryLimit || this.bytes > this.options.byteLimit) {
            if (!this.evictOne(exemptKey)) {
                return;
            }
        }
    }

    private evictOne(exemptKey: K): boolean {
        const probationKey = firstKey(this.probation);

        if (probationKey !== undefined && probationKey !== exemptKey) {
            this.remove(probationKey);

            return true;
        }

        const protectedKey = firstKey(this.protectedEntries);

        if (protectedKey !== undefined) {
            this.remove(protectedKey);

            return true;
        }

        // Only the newly inserted entry remains; dropping it is the only way to satisfy a zero or tiny bound.
        if (probationKey !== undefined) {
            this.remove(probationKey);

            return true;
        }

        return false;
    }
}

function firstKey<K, V>(entries: ReadonlyMap<K, V>): K | undefined {
    return entries.keys().next().value;
}
