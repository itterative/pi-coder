import fs from "node:fs";

import { createJsonlRecordLog, type EnvelopeRecord, type RecordLog } from "../../common/record-log";
import { PROCESS_INSTANCE } from "../../common/trace";
import {
    shapeKey,
    type ChainObservation,
    type ChainRecorded,
    type ChainShape,
    type RestoredLadder,
} from "./chain";
import type { CompactionConfig } from "./config";
import { compactionTraceTarget } from "./trace";

/**
 * The durable half of the request chain, written into the compaction trace file.
 *
 * `chain.ts` answers whether a rebuilt stage-1 request shares the prefix the provider already has, and it can
 * only answer for requests it has seen in this process. That made the first compaction after a restart, a
 * reload, or a resume report an empty chain - indistinguishable, in the record, from a chain whose entries had
 * all been filtered out. Persisting the observations fixes the ambiguity, and the records carry no conversation
 * content: a head is eight bytes of hex, and a ladder is an array of them.
 *
 * Two kinds of row go out. `chain_request` is one per observed provider request and carries the head at its own
 * depth. `chain_ladder` carries the heads at every depth of one request, and it is what makes a truncated span
 * checkable: per-request end heads all sit at depth N or deeper, so a span cut to 64 messages would meet nothing
 * in them. Ladders therefore follow a growth cadence instead of arriving with every request.
 *
 * Sharing the trace file means sharing its rotation and its location, which is the point: one store, one reader,
 * one thing to delete. The cost is that the big body records push the small hash records out of the live file
 * sooner than they would on their own budget, and that is why reading them back filters before parsing.
 */

const RECORD_VERSION = 1;

/** Depth growth that justifies rewriting a ladder. Amortizes the big row to a few hundred bytes per message. */
const LADDER_DEPTH_GROWTH = 32;

/** A ceiling on one row, so a pathological session cannot write an unbounded line. */
const MAX_LADDER_HEADS = 4000;

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

const REQUEST_STAGE = "chain_request";
const LADDER_STAGE = "chain_ladder";

export interface ChainRequestRecord extends EnvelopeRecord {
    v: number;
    stage: typeof REQUEST_STAGE;
    /** The load that observed the request, which is not necessarily the load reading it back. */
    instance: string;
    cwd: string;
    session: string;
    leafId: string | null;
    depth: number;
    head: string;
    systemHash: string;
    toolsHash: string;
    systemChars: number;
    model: string;
    keys: string[];
    ts: string;
}

export interface ChainLadderRecord extends EnvelopeRecord {
    v: number;
    stage: typeof LADDER_STAGE;
    instance: string;
    cwd: string;
    session: string;
    leafId: string | null;
    depth: number;
    shapeKey: string;
    /** Heads for depths 1..depth in order: index 0 is the head after the first message. */
    heads: string[];
    ts: string;
}

export type ChainRecord = ChainRequestRecord | ChainLadderRecord;

export interface ChainTraceTarget {
    enabled: boolean;
    filePath: string;
    maxBytes: number;
    generations: number;
}

/**
 * Where the chain persists and whether it does.
 *
 * Location and rotation are the trace's, so there is one file to reason about. The switch is its own for a
 * narrower reason than independence: chain rows carry no conversation content, so a user who turns bodies off
 * can still let history accumulate for the next time they look - the prefix verdict itself is only recorded
 * while the trace is on, and this does not change that.
 */
export function chainTraceTarget(config: CompactionConfig): ChainTraceTarget {
    const trace = compactionTraceTarget(config);
    const envSwitch = process.env.COMPACTION_CHAIN_TRACE?.trim().toLowerCase();
    const enabled =
        envSwitch !== undefined && envSwitch !== ""
            ? config.enabled && !DISABLED_VALUES.has(envSwitch)
            : config.enabled && config.chainTraceEnabled;

    return {
        enabled,
        filePath: trace.filePath,
        maxBytes: trace.maxBytes,
        generations: trace.generations,
    };
}

const logs = new Map<string, RecordLog<ChainRecord>>();

function chainLog(target: ChainTraceTarget): RecordLog<ChainRecord> {
    const key = `${target.filePath}|${String(target.maxBytes)}|${String(target.generations)}`;
    const existing = logs.get(key);
    if (existing !== undefined) {
        return existing;
    }

    const created = createJsonlRecordLog<ChainRecord>({
        filePath: target.filePath,
        maxBytes: target.maxBytes,
        generations: target.generations,
    });
    logs.set(key, created);
    return created;
}

/** What has already been written per session, so persistence does not repeat itself every request. */
const written = new Map<string, { depth: number; shapeKey: string }>();

function ladderWarranted(
    state: { depth: number; shapeKey: string } | undefined,
    shape: ChainShape,
    depth: number,
): boolean {
    if (state === undefined) {
        return true;
    }

    // A new shape retires the old ladder for comparison purposes, so the first request under it earns a full
    // row however little depth has moved.
    if (shapeKey(shape) !== state.shapeKey) {
        return true;
    }

    // The interval grows with depth rather than staying fixed. A ladder at depth N already carries a head at
    // every depth below it, so rewriting one every 32 messages costs about 0.6 bytes per message per message of
    // growth - quadratically, roughly a megabyte of rows by depth 2000, where a long session's own hash history
    // starts evicting itself. Growing the interval keeps the total linear in depth without losing resolution:
    // the newest ladder still answers any shallower span.
    return depth - state.depth >= Math.max(LADDER_DEPTH_GROWTH, Math.floor(state.depth / 8));
}

/**
 * Record what was just sent, plus a ladder when the cadence says so.
 *
 * Called from `before_provider_request`, so it stays cheap and never throws: a few hundred bytes appended with
 * no flush, and any store failure is swallowed because this explains compaction rather than gating it.
 */
export function recordChainRequest(
    target: ChainTraceTarget,
    context: { cwd: string; session: string; shape: ChainShape },
    recorded: ChainRecorded,
): void {
    if (!target.enabled) {
        return;
    }

    const log = chainLog(target);
    const now = new Date().toISOString();
    const { observation, heads } = recorded;
    const key = `${context.session}|${context.cwd}`;
    const shape = shapeKey(context.shape);
    const writeLadder = ladderWarranted(written.get(key), context.shape, observation.depth);

    if (writeLadder) {
        const ladder: ChainLadderRecord = {
            v: RECORD_VERSION,
            stage: LADDER_STAGE,
            instance: PROCESS_INSTANCE,
            cwd: context.cwd,
            session: context.session,
            leafId: observation.leafId,
            depth: observation.depth,
            shapeKey: shape,
            heads: heads.slice(0, MAX_LADDER_HEADS),
            ts: now,
        };
        log.append(ladder);
    }

    const request: ChainRequestRecord = {
        v: RECORD_VERSION,
        stage: REQUEST_STAGE,
        instance: PROCESS_INSTANCE,
        cwd: context.cwd,
        session: context.session,
        leafId: observation.leafId,
        depth: observation.depth,
        head: observation.head,
        systemHash: observation.systemHash,
        toolsHash: observation.toolsHash,
        systemChars: observation.systemChars,
        model: observation.model,
        keys: observation.keys,
        ts: now,
    };
    log.append(request);

    // Cadence state advances only once the rows are through. Setting it beforehand would let a swallowed write
    // failure postpone the next ladder by up to 32 requests, quietly widening the blind spot.
    written.set(key, { depth: observation.depth, shapeKey: shape });
}

/** Cheap line needles so a reader after hash rows never decodes the body records sharing the file. */
const REQUEST_NEEDLE = `"${REQUEST_STAGE}"`;
const LADDER_NEEDLE = `"${LADDER_STAGE}"`;

function isChainLine(line: string): boolean {
    return line.includes(REQUEST_NEEDLE) || line.includes(LADDER_NEEDLE);
}

/** Enough rows to rebuild a useful chain: one ladder plus a run of recent requests. */
const HYDRATION_OBSERVATIONS = 32;

function statOf(filePath: string): fs.Stats | undefined {
    try {
        return fs.statSync(filePath);
    } catch {
        return undefined;
    }
}

/** Chain rows in one segment, oldest first, skipping every record that is not ours to read. */
function readChainRecords(filePath: string): { records: ChainRecord[]; malformed: number } {
    const records: ChainRecord[] = [];
    let malformed = 0;

    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        if (!isChainLine(line)) {
            continue;
        }

        try {
            records.push(JSON.parse(line) as ChainRecord);
        } catch {
            // A torn line is a gap, not a crash. Counted, because an unreadable ladder otherwise looks exactly
            // like a session that never had one.
            malformed += 1;
        }
    }

    return { records, malformed };
}

function partition(records: ChainRecord[], session: string) {
    const mine = records.filter((record) => record.session === session);

    return {
        observations: mine.filter(isRequest).map(toObservation),
        // Newest first, matching how `observe` stacks ladders in memory.
        ladders: mine.filter(isLadder).map(toLadder).reverse(),
    };
}

/**
 * Read back what a previous process recorded for one session.
 *
 * Segments are walked newest first and the scan stops as soon as the chain is usable: one ladder covers every
 * shallow depth a truncated span compares against, and the requests that matter are the recent ones. A segment
 * last written before the session began cannot hold its rows, so it ends the walk on a stat instead of a parse -
 * which is why `startedMs` arrives from the branch the caller already holds rather than being looked up again
 * here: the alternative is walking the session's entries a second time to learn something the first walk had.
 *
 * This does not go through `RecordLog.read()`, unlike the reports: that reader walks every generation oldest
 * first and has no way to express "stop once satisfied" or "stop at a segment older than this session", which are
 * the two properties that bound the cost on a shared hot path. It does share the file, the rotation, and the
 * format contract with it.
 */
export function loadChain(
    target: ChainTraceTarget,
    session: string,
    startedMs?: number,
): {
    observations: ChainObservation[];
    ladders: RestoredLadder[];
    scanComplete: boolean;
    loadFailed: boolean;
    malformed: number;
} {
    const nothing = {
        observations: [],
        ladders: [],
        scanComplete: true,
        loadFailed: false,
        malformed: 0,
    };
    if (!target.enabled) {
        return nothing;
    }

    const collected: ChainRecord[] = [];
    // Stops meaning "complete" only when the satisfaction break fires. Breaking on the session's start time is a
    // sound bound: a segment last written before the session began cannot hold its rows.
    let scanComplete = true;
    let malformed = 0;

    try {
        for (let generation = 0; generation <= target.generations; generation++) {
            const segment =
                generation === 0 ? target.filePath : `${target.filePath}.${String(generation)}`;
            const stat = statOf(segment);
            if (stat === undefined) {
                continue;
            }

            if (startedMs !== undefined && stat.mtimeMs < startedMs) {
                break;
            }

            const slice = readChainRecords(segment);
            malformed += slice.malformed;
            collected.unshift(...slice.records);

            const harvest = partition(collected, session);
            if (
                harvest.ladders.length > 0 &&
                harvest.observations.length >= HYDRATION_OBSERVATIONS
            ) {
                scanComplete = false;
                break;
            }
        }
    } catch {
        // A failed read must not gate compaction: this runs on the request path and inside stage 1, where a throw
        // would reject the attempt and cascade to the serialized rung. Reported rather than swallowed silently,
        // because "I could not read the chain" and "the chain is empty" lead to opposite conclusions.
        return { ...nothing, scanComplete: false, loadFailed: true };
    }

    const harvest = partition(collected, session);

    return {
        observations: harvest.observations,
        ladders: harvest.ladders.slice(0, 2),
        scanComplete,
        loadFailed: false,
        malformed,
    };
}

/** Drop the write cadence memory, so a test or a session switch does not inherit another's state. */
export function resetChainWritesForTesting(): void {
    written.clear();
    logs.clear();
}

function isRequest(record: ChainRecord): record is ChainRequestRecord {
    return record.stage === REQUEST_STAGE;
}

function isLadder(record: ChainRecord): record is ChainLadderRecord {
    return record.stage === LADDER_STAGE;
}

function toObservation(record: ChainRequestRecord): ChainObservation {
    return {
        leafId: record.leafId,
        depth: record.depth,
        head: record.head,
        systemHash: record.systemHash,
        toolsHash: record.toolsHash,
        systemChars: record.systemChars,
        keys: record.keys,
        model: record.model,
        ts: Date.parse(record.ts),
    };
}

function toLadder(record: ChainLadderRecord): RestoredLadder {
    const heads = new Map<number, string>();
    for (let index = 0; index < record.heads.length; index++) {
        heads.set(index + 1, record.heads[index]);
    }

    return { leafId: record.leafId, heads, shapeKey: record.shapeKey };
}
