import path from "node:path";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { PI_CODER_EXTENSION_DIR } from "../../src/common/constants";
import {
    createJsonlRecordLog,
    discoverGenerations,
    type RecordLog,
} from "../../src/common/record-log";
import type { ChainRecord, ChainRequestRecord } from "../../src/modules/compaction/chain-store";
import type { CompactionTraceRecord } from "../../src/modules/compaction/trace";
import { promptTokensOf } from "../../src/modules/compaction/usage";

/**
 * Reading a captured compaction trace the way its recorder writes it.
 *
 * Two defects this exists to end, both of which produced a test that could not fail for the right reason:
 *
 * - **Read through the record log.** `createJsonlRecordLog` owns segment naming, oldest-first ordering across
 *   rotations, torn-line tolerance and the `v` normalization; a `readFileSync().split("\n")` in a test reads only
 *   the live segment, so a capture that rotated silently lost its oldest runs, and a hand-rolled `JSON.parse`
 *   turned one torn line into a thrown test instead of a counted gap. `scripts/compaction-report.ts` shares the
 *   same reader for the same reason: a report that disagrees with its recorder about which files hold history is
 *   worse than no report.
 * - **Filter by session.** `.state/compaction-trace.jsonl` accumulates across every session of a checkout - the
 *   capture this was written against sat in a file holding five - so an unfiltered read matches a fold's
 *   `firstKeptEntryId` against attempts from sessions that never saw it. Fixtures keep that property on purpose
 *   (see `loadCapture.foreignRecords`): a filter nobody tests is a filter nobody has.
 */

/** One line of a trace file: a compaction run's record, or a persisted chain row. */
export type TraceRecord = CompactionTraceRecord | ChainRecord;

/** A file under `test/fixtures/`, resolved from the extension root so a suite never hardcodes a machine path. */
export function fixturePath(...parts: string[]): string {
    return path.join(PI_CODER_EXTENSION_DIR, "test", "fixtures", ...parts);
}

/** Every retained generation of a trace file. `maxBytes: 0` because reading is never a reason to rotate. */
export function openTraceLog(filePath: string): RecordLog<TraceRecord> {
    return createJsonlRecordLog<TraceRecord>({
        filePath,
        maxBytes: 0,
        generations: discoverGenerations(filePath),
    });
}

/** The session a pi session file belongs to, asked of the file rather than parsed out of its name. */
export function sessionIdOf(sessionFile: string): string {
    return SessionManager.open(sessionFile).getSessionId();
}

export interface Capture {
    /** The session both halves of the pair describe. */
    sessionId: string;
    manager: SessionManager;
    /** The branch pi would resolve, which is what every sizing route walks. */
    branch: SessionEntry[];
    /** The trace file's records for `sessionId`, oldest first. */
    records: TraceRecord[];
    /**
     * Records in the same file that belong to another session. A fixture with none cannot show that the filter
     * ran, so a capture meant to pin session scoping keeps a few rows of a second session on purpose.
     */
    foreignRecords: TraceRecord[];
}

/** A paired capture: one session file, and the trace records written while it ran. */
export function loadCapture(input: { sessionFile: string; traceFile: string }): Capture {
    const manager = SessionManager.open(input.sessionFile);
    const sessionId = manager.getSessionId();
    const all = openTraceLog(input.traceFile).read();

    return {
        sessionId,
        manager,
        branch: manager.getBranch(),
        records: all.filter((record) => record.session === sessionId),
        foreignRecords: all.filter((record) => record.session !== sessionId),
    };
}

/** Stage-1 attempts, oldest first: one per fold whose native request the build actually sent. */
export function nativeAttempts(records: readonly TraceRecord[]): CompactionTraceRecord[] {
    return records.filter(
        (record): record is CompactionTraceRecord =>
            record.stage === "attempt" && record.strategy === "native",
    );
}

/** The persisted per-request chain rows, which carry the shape a session file cannot: prompt and tool hashes. */
export function chainRequests(records: readonly TraceRecord[]): ChainRequestRecord[] {
    return records.filter(
        (record): record is ChainRequestRecord => record.stage === "chain_request",
    );
}

/** The prefix verdicts, one per compaction run that reached stage 1. */
export function prefixRecords(records: readonly TraceRecord[]): CompactionTraceRecord[] {
    return records.filter((record): record is CompactionTraceRecord => record.stage === "prefix");
}

/**
 * The stage-1 attempt that produced one fold row, matched by the boundary it cut at.
 *
 * A repaired cut names a different boundary than core proposed (`cut.ts` only ever moves it earlier), so either
 * id can be the one the fold row persisted. Throws on zero or several matches rather than returning `undefined`:
 * an unmatched fold means the pair does not describe one another, which is a fixture defect, and a silent
 * `undefined` would let a test assert nothing about that fold at all.
 */
export function requireAttemptForFold(
    records: readonly TraceRecord[],
    fold: Extract<SessionEntry, { type: "compaction" }>,
): CompactionTraceRecord {
    const matches = nativeAttempts(records).filter(
        (record) =>
            record.attempt?.chosenFirstKeptEntryId === fold.firstKeptEntryId ||
            record.attempt?.proposedFirstKeptEntryId === fold.firstKeptEntryId,
    );

    if (matches.length !== 1) {
        throw new Error(
            `expected exactly one stage-1 attempt for fold ${fold.id} ` +
                `(firstKeptEntryId ${fold.firstKeptEntryId}), found ${String(matches.length)}`,
        );
    }

    return matches[0] as CompactionTraceRecord;
}

/**
 * What the provider charged for the request an attempt record describes - the ground truth a sizing tier is
 * measured against. Null when the attempt never received a reply (skipped, or rejected before a response).
 */
export function providerPromptTokens(record: CompactionTraceRecord): number | null {
    return promptTokensOf(record.usage, record.stopReason);
}
