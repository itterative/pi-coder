import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A lock file older than this is assumed abandoned even when its pid still looks alive.
 *
 * A recycled pid is the only way a dead build can look live, so age is the backstop. It has to outlast the longest
 * legitimate build: a full repo build is measured at ~1 h at the refresh cap, so two hours leaves headroom rather
 * than turning a slow build into a stolen lock.
 */
const STALE_MS = 2 * 60 * 60_000;

const LOCK_FILE = "build.lock";

export interface IndexLock {
    release(): void;
}

interface LockHolder {
    pid: number;
    /** Ownership token: a pid can be recycled, so only the writer that created the file may delete it. */
    token: string;
    startedAt: number;
}

/**
 * Take the build lock for one index namespace, or report that another build holds it.
 *
 * Several writers share a namespace directory: a search-triggered refresh, a foreground `/outline build`, and
 * another pi session on the same root. Each build reads the manifest once at the start and publishes its whole
 * in-memory view at the end, so two overlapping builds lose each other's shard records — and a pruning build
 * deletes shard files the other one just wrote. Serializing the read-modify-write window is what keeps the
 * manifest a complete description of the index.
 *
 * Readers never take this: `writeManifest` publishes with a temp file and a rename, so a search always sees either
 * the previous manifest or the new one.
 */
export function acquireIndexLock(dir: string): IndexLock | undefined {
    const file = path.join(dir, LOCK_FILE);
    const token = randomUUID();

    fs.mkdirSync(dir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = fs.openSync(file, "wx");

            try {
                fs.writeFileSync(
                    handle,
                    JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }),
                );
            } finally {
                fs.closeSync(handle);
            }

            return {
                release: () => {
                    const holder = readHolder(file);

                    if (holder?.token === token) {
                        fs.rmSync(file, { force: true });
                    }
                },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            const holder = readHolder(file);

            if (holder !== undefined && !isStale(holder)) {
                return undefined;
            }

            // Abandoned: a killed build, or an unreadable lock. Take it over and try once more.
            fs.rmSync(file, { force: true });
        }
    }

    return undefined;
}

/** Whether the lock file at `dir` is held right now. Used by tests and diagnostics, never by a build. */
export function indexLockHeld(dir: string): boolean {
    const holder = readHolder(path.join(dir, LOCK_FILE));

    return holder !== undefined && !isStale(holder);
}

function readHolder(file: string): LockHolder | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }

    const fields = parsed as Record<string, unknown>;

    if (
        typeof fields.pid !== "number" ||
        typeof fields.token !== "string" ||
        typeof fields.startedAt !== "number"
    ) {
        return undefined;
    }

    return { pid: fields.pid, token: fields.token, startedAt: fields.startedAt };
}

function isStale(holder: LockHolder): boolean {
    return Date.now() - holder.startedAt > STALE_MS || !isAlive(holder.pid);
}

/** `EPERM` means the pid exists under another user, so it counts as alive. */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}
