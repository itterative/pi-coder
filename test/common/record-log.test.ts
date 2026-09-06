import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createJsonlRecordLog,
    discoverGenerations,
    type EnvelopeRecord,
} from "../../src/common/record-log";

interface ProbeRecord extends EnvelopeRecord {
    v?: number;
    ts: string;
    session: string;
    note: string;
}

function record(ts: string, session: string, note: string): ProbeRecord {
    return { v: 1, ts, session, note };
}

/** A line long enough that a handful of writes cross a small byte cap. */
function padded(ts: string, index: number): ProbeRecord {
    return { v: 1, ts, session: `sess-${String(index % 2)}`, note: "x".repeat(200) };
}

describe("record log", () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-log-"));
        file = path.join(dir, "log.jsonl");
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function log(options: { maxBytes?: number; generations?: number } = {}) {
        return createJsonlRecordLog<ProbeRecord>({
            filePath: file,
            maxBytes: options.maxBytes ?? 1024,
            generations: options.generations ?? 3,
        });
    }

    it("creates the file and its directory with owner-only modes", () => {
        const nested = path.join(dir, "deeper", "log.jsonl");
        const store = createJsonlRecordLog<ProbeRecord>({
            filePath: nested,
            maxBytes: 1024,
            generations: 1,
        });

        store.append(record("2026-09-05T10:00:00.000Z", "sess-a", "first"));

        expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
        expect(store.read()).toHaveLength(1);
    });

    it("keeps records readable in the order they were written", () => {
        const store = log();
        store.append(record("2026-09-05T10:00:00.000Z", "sess-a", "first"));
        store.append(record("2026-09-05T10:00:01.000Z", "sess-a", "second"));

        expect(
            store
                .read()
                .map((entry) => entry.note)
                .join(","),
        ).toBe("first,second");
    });

    it("reads across every generation oldest first", () => {
        const store = log({ maxBytes: 500, generations: 3 });

        // Enough records to rotate several times: each segment holds two of them.
        for (let index = 0; index < 8; index++) {
            store.append(padded(`2026-09-05T10:00:${String(index).padStart(2, "0")}Z`, index));
        }

        const generations = [`${file}.3`, `${file}.2`, `${file}.1`, file].filter((candidate) =>
            fs.existsSync(candidate),
        );
        expect(generations.length).toBeGreaterThan(1);

        const read = store.read();
        expect(read.length).toBeLessThanOrEqual(8);
        expect(read.map((entry) => entry.ts)).toEqual([...read.map((entry) => entry.ts)].sort());
    });

    it("shifts generations instead of clobbering the previous one", () => {
        // The bug this replaced: renaming the live file to `.1` unconditionally destroyed the prior `.1` at
        // every rotation, so a cap could hold exactly one generation of history no matter the intent.
        const store = log({ maxBytes: 500, generations: 3 });
        for (let index = 0; index < 8; index++) {
            store.append(padded(`2026-09-05T10:00:${String(index).padStart(2, "0")}Z`, index));
        }

        expect(fs.existsSync(`${file}.2`)).toBe(true);
        expect(fs.existsSync(`${file}.3`)).toBe(true);
    });

    it("drops the oldest copy past the generation budget", () => {
        const store = log({ maxBytes: 500, generations: 1 });
        for (let index = 0; index < 12; index++) {
            store.append(padded(`2026-09-05T10:00:${String(index).padStart(2, "0")}Z`, index));
        }

        expect(fs.existsSync(`${file}.1`)).toBe(true);
        expect(fs.existsSync(`${file}.2`)).toBe(false);
        expect(store.read().length).toBeLessThan(12);
    });

    it("discards the live file when zero generations are kept", () => {
        const store = log({ maxBytes: 500, generations: 0 });
        for (let index = 0; index < 6; index++) {
            store.append(padded(`2026-09-05T10:00:${String(index).padStart(2, "0")}Z`, index));
        }

        expect(fs.existsSync(`${file}.1`)).toBe(false);
        expect(store.read().length).toBeLessThan(6);
    });

    it("counts an unreadable tail instead of failing the read", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            `${JSON.stringify(record("2026-09-05T10:00:00.000Z", "sess-a", "kept"))}\n{"ts":"2026-`,
        );
        const store = log();

        const read = store.read();
        expect(read).toHaveLength(1);
        expect(store.stats().malformed).toBe(1);
    });

    it("normalizes records written before versions existed", () => {
        fs.writeFileSync(
            file,
            `${JSON.stringify({ ts: "2026-09-05T10:00:00.000Z", session: "sess-a", note: "legacy" })}\n`,
        );

        expect(log().read()[0]?.v).toBe(0);
    });

    it("filters by time, by producer predicate, and by newest count", () => {
        const store = log();
        store.append(record("2026-09-05T09:00:00.000Z", "sess-a", "old"));
        store.append(record("2026-09-05T10:00:00.000Z", "sess-b", "new"));

        expect(
            store
                .read({ since: "2026-09-05T09:30:00.000Z" })
                .map((entry) => entry.note)
                .join(","),
        ).toBe("new");
        expect(
            store
                .read({ since: Date.parse("2026-09-05T09:30:00.000Z") })
                .map((entry) => entry.note)
                .join(","),
        ).toBe("new");
        expect(store.read({ where: (entry) => entry.session === "sess-a" })).toHaveLength(1);
        expect(store.read({ limit: 1 })[0]?.note).toBe("new");
    });

    it("survives a destination that cannot be written and reports it", () => {
        const blocker = path.join(dir, "blocker");
        fs.writeFileSync(blocker, "not a directory");
        const store = createJsonlRecordLog<ProbeRecord>({
            filePath: path.join(blocker, "log.jsonl"),
            maxBytes: 1024,
            generations: 1,
        });

        expect(() =>
            store.append(record("2026-09-05T10:00:00.000Z", "sess-a", "lost")),
        ).not.toThrow();
        expect(store.stats().writeFailures).toBe(1);
        expect(store.read()).toEqual([]);
    });

    it("reports the segments it read", () => {
        const store = log({ maxBytes: 500, generations: 2 });
        store.append(record("2026-09-05T10:00:00.000Z", "sess-a", "first"));

        const stats = store.stats();
        expect(stats.files).toContain(file);
        expect(stats.bytes).toBeGreaterThan(0);
        expect(() => store.close()).not.toThrow();
    });
});

describe("generation discovery", () => {
    let dir = "";
    let file = "";

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-log-discovery-"));
        file = path.join(dir, "log.jsonl");
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("counts zero when nothing has rotated", () => {
        fs.writeFileSync(file, "{}");
        expect(discoverGenerations(file)).toBe(0);
    });

    it("counts consecutive segments and stops at the first gap", () => {
        // A missing `.2` means `.3` can only be left over from a larger budget, and reading past the gap would
        // splice unrelated history into what a reader believes is this session's continuity.
        fs.writeFileSync(`${file}.1`, "{}");
        fs.writeFileSync(`${file}.3`, "{}");

        expect(discoverGenerations(file)).toBe(1);
    });

    it("respects the scan ceiling", () => {
        for (let generation = 1; generation <= 5; generation++) {
            fs.writeFileSync(`${file}.${String(generation)}`, "{}");
        }

        expect(discoverGenerations(file, 3)).toBe(3);
        expect(discoverGenerations(file)).toBe(5);
    });
});
