import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    messageLadder,
    RequestChain,
    type ChainShape,
} from "../../../src/modules/compaction/chain";
import {
    chainTraceTarget,
    loadChain,
    recordChainRequest,
    resetChainWritesForTesting,
    type ChainTraceTarget,
} from "../../../src/modules/compaction/chain-store";
import { DEFAULT_COMPACTION_CONFIG } from "../../../src/modules/compaction/config";
import { compactionTraceTarget } from "../../../src/modules/compaction/trace";
import { chainMessages, chainShape } from "../../helpers/compaction-doubles";

/**
 * The persisted chain exists to answer one question honestly: was there a reference to compare against, or did
 * this process simply never see one? So the load-bearing case here is not serialization - it is that a chain in
 * a fresh process restores enough to verify a truncated span, and that a span it cannot verify says so.
 */

const SESSION = "01a070e0-8e0a-798c-bb63-f41491eb5e39";

describe("compaction chain store", () => {
    let root = "";
    let file = "";
    let target: ChainTraceTarget;

    beforeEach(() => {
        resetChainWritesForTesting();
        root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coder-chain-"));
        file = path.join(root, "compaction-trace.jsonl");
        target = { enabled: true, filePath: file, maxBytes: 1024 * 1024, generations: 3 };
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
    });

    function record(input: {
        leafId: string | null;
        depth: number;
        shape?: ChainShape;
        session?: string;
        chain?: RequestChain;
    }): RequestChain {
        const chain = input.chain ?? new RequestChain();
        const shape = input.shape ?? chainShape();
        const recorded = chain.observe({
            leafId: input.leafId,
            messages: chainMessages(input.depth),
            shape,
        });

        recordChainRequest(
            target,
            { cwd: root, session: input.session ?? SESSION, shape },
            recorded,
        );

        return chain;
    }

    function stages(): string[] {
        if (!fs.existsSync(file)) {
            return [];
        }

        return fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => String((JSON.parse(line) as Record<string, unknown>).stage));
    }

    it("follows its own switch while sharing the trace location and rotation", () => {
        const config = { ...DEFAULT_COMPACTION_CONFIG, enabled: true, tracePath: file };

        // test/setup.ts turns this off for the whole suite so no test can write this checkout's real trace, so
        // the on-case has to ask for it explicitly - which is itself the proof the switch works.
        vi.stubEnv("COMPACTION_CHAIN_TRACE", "1");
        expect(chainTraceTarget(config)).toMatchObject({ enabled: true, filePath: file });

        vi.stubEnv("COMPACTION_CHAIN_TRACE", "0");
        expect(chainTraceTarget(config).enabled).toBe(false);

        // Compaction itself off means there is nothing to observe, whatever the chain switch says.
        vi.stubEnv("COMPACTION_CHAIN_TRACE", "1");
        expect(chainTraceTarget({ ...config, enabled: false }).enabled).toBe(false);
        vi.unstubAllEnvs();
    });

    it("shares the trace file and its rotation budget rather than opening a store of its own", () => {
        const config = {
            ...DEFAULT_COMPACTION_CONFIG,
            tracePath: file,
            traceMaxBytes: 4096,
            traceGenerations: 7,
        };

        const chain = chainTraceTarget(config);
        const trace = compactionTraceTarget(config);

        expect(chain.filePath).toBe(trace.filePath);
        expect(chain.maxBytes).toBe(trace.maxBytes);
        expect(chain.generations).toBe(trace.generations);
    });

    it("writes one request row per call and a ladder on the growth cadence", () => {
        record({ leafId: "leaf-1", depth: 5 });
        expect(stages()).toEqual(["chain_ladder", "chain_request"]);

        // Nine messages of growth is inside the cadence: the row that matters stays a request row.
        record({ leafId: "leaf-2", depth: 14 });
        expect(stages()).toEqual(["chain_ladder", "chain_request", "chain_request"]);

        record({ leafId: "leaf-3", depth: 60 });
        expect(stages().filter((stage) => stage === "chain_ladder")).toHaveLength(2);
    });

    it("rewrites a ladder as soon as the shape changes", () => {
        // A ladder is only comparable to a rebuild under the same prompt and tool set, so keeping the old one
        // any longer would buy nothing.
        record({ leafId: "leaf-1", depth: 5 });
        record({ leafId: "leaf-2", depth: 7, shape: chainShape({ systemHash: "sys-2" }) });

        expect(stages()).toEqual([
            "chain_ladder",
            "chain_request",
            "chain_ladder",
            "chain_request",
        ]);
    });

    it("restores enough in a fresh process to verify a span truncated above the deepest request", () => {
        // The case the whole store exists for: a compaction right after a restart whose span is shorter than
        // every request head. Without the ladder this reads as "no comparable reference"; with it, the prefix
        // is verified at the depth the span actually carries.
        record({ leafId: "leaf-9", depth: 24 });

        const restored = new RequestChain();
        restored.restore(loadChain(target, SESSION));

        const verdict = restored.match({
            spanLadder: messageLadder(chainMessages(9)),
            pathIds: new Set(["leaf-9"]),
            shape: chainShape(),
        });

        expect(verdict.reference).toBe("chain");
        expect(verdict.comparableDepth).toBe(9);
        expect(verdict.verifiedTo).toBe(9);
    });

    it("cannot verify a truncated span from request heads alone, which is why ladders exist", () => {
        const restored = new RequestChain();
        const source = new RequestChain();
        source.observe({ leafId: "leaf-9", messages: chainMessages(24), shape: chainShape() });

        restored.restore({
            observations: source.branchObservations(new Set(["leaf-9"])),
            ladders: [],
        });

        const verdict = restored.match({
            spanLadder: messageLadder(chainMessages(9)),
            pathIds: new Set(["leaf-9"]),
            shape: chainShape(),
        });

        // Comparable in principle - the leaf is on the branch - but nothing reaches the depth being asked about.
        expect(verdict.compared).toBe(1);
        expect(verdict.comparableDepth).toBe(-1);
    });

    it("stops at a segment written before the session began", () => {
        record({ leafId: "leaf-1", depth: 5 });

        // A file whose last write predates the session cannot hold rows for it, so the walk ends on a stat.
        expect(loadChain(target, SESSION, Date.now() + 60_000).observations).toEqual([]);
        expect(loadChain(target, SESSION).observations).toHaveLength(1);
    });

    it("keeps another session's rows out of the restore", () => {
        record({ leafId: "leaf-1", depth: 5 });
        record({ leafId: "leaf-2", depth: 50, session: "01a0714f-0000-7000-8000-000000000000" });

        const restored = loadChain(target, SESSION);
        expect(restored.observations).toHaveLength(1);
        expect(restored.observations[0]?.depth).toBe(5);
        expect(restored.ladders).toHaveLength(1);
    });

    it("restores persisted rows ahead of the ones this process observed itself", () => {
        // Load-bearing rather than cosmetic: `matchObservations` walks forward and lets the newest row win, so a
        // restored row - older by definition - must not land behind what this process recorded afterwards.
        record({ leafId: "leaf-old", depth: 5 });

        const chain = new RequestChain();
        chain.observe({ leafId: "leaf-new", messages: chainMessages(40), shape: chainShape() });
        chain.restore(loadChain(target, SESSION));

        const rows = chain.branchObservations(new Set(["leaf-old", "leaf-new"]));
        expect(rows.map((row) => row.leafId)).toEqual(["leaf-old", "leaf-new"]);
    });

    it("reports a scan that stopped early, so the counts read as a floor", () => {
        for (let index = 0; index < 40; index++) {
            record({ leafId: `leaf-${String(index)}`, depth: index + 1 });
        }

        const loaded = loadChain(target, SESSION);
        // The walk ends once it holds a ladder and enough requests; that is not the same as having seen all rows.
        expect(loaded.scanComplete).toBe(false);
        expect(loaded.loadFailed).toBe(false);
        expect(loaded.observations.length).toBeGreaterThanOrEqual(32);
    });

    it("writes nothing while the switch is off", () => {
        const off: ChainTraceTarget = { ...target, enabled: false };
        const chain = new RequestChain();
        const recorded = chain.observe({
            leafId: "leaf-1",
            messages: chainMessages(3),
            shape: chainShape(),
        });

        recordChainRequest(off, { cwd: root, session: SESSION, shape: chainShape() }, recorded);

        expect(fs.existsSync(file)).toBe(false);
        expect(loadChain(off, SESSION)).toMatchObject({
            observations: [],
            ladders: [],
            scanComplete: true,
            loadFailed: false,
            malformed: 0,
        });
    });

    it("persists hashes and ids only, never the messages or the prompt", () => {
        record({ leafId: "leaf-1", depth: 6 });

        const raw = fs.readFileSync(file, "utf8");
        // What must never appear is the content the hashes were taken over; the hashes themselves are the point.
        expect(raw).toContain('"systemHash":"sys-1"');
        expect(raw).not.toContain('"content"');
        expect(raw).not.toContain("m0");
        expect(raw).toContain("chain_request");
    });
});
