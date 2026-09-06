import {
    SessionManager,
    buildContextEntries as piBuildContextEntries,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
    countBoundary,
    countSpanTokens,
    estimateAnchoredSpanTokens,
    promptAndTotalTokens,
} from "../../../src/modules/compaction/native-request";
import { spanContextEntries } from "../../../src/modules/compaction/span-session";
import {
    fixturePath,
    nativeAttempts,
    openTraceLog,
    providerPromptTokens,
    sessionIdOf,
} from "../../helpers/compaction-trace";

/**
 * Three chained compactions, recorded from one live session - and the fold guard measured against them.
 *
 * Every other fixture here describes a session that folded once. That is enough to test that a boundary
 * resolves and that a count matches, but not the case the guard exists for: what a session looks like when it
 * folds *again*, with rows from before the first fold still sitting in the retained tail carrying the counts of
 * bodies that no longer exist. Nothing on this box had that shape as data until a session folded three times in a
 * row while the new sizing was live - so the recorded trace beside it is the check, and this file's job is to
 * reproduce the recorded fields from the session alone. If they disagree, one of the two artifacts is lying.
 *
 * Provider and model strings are kept raw, as in the paired fixtures: this file is read, never replayed, so no
 * test depends on a machine's provider config, and rewriting the strings would hide which route reported what.
 */
const SESSION_FIXTURE = fixturePath("session", "hosted-three-folds.jsonl");

const TRACE_FIXTURE = fixturePath("compaction-trace.hosted-three-folds.jsonl");

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

interface RecordedAttempt {
    ts: string;
    outcome: string;
    stopReason?: string;
    estimatedTokens?: number;
    estimateSource?: string;
    staleAnchors?: number;
    providerPromptTokens: number | null;
    chosenFirstKeptEntryId?: string;
    proposedFirstKeptEntryId?: string;
    cutFound?: boolean;
    skippedEntries?: number;
}

/**
 * The stage-1 attempts this fixture's session recorded, read through the log the recorder writes and scoped to
 * the session the paired file names.
 *
 * A field the fixture does not carry reads as `undefined` off the record's own type, which is how "predates the
 * field" and "the build wrote a different value" stay distinguishable in the assertions below - the reason this
 * used to coerce every field out of a `Record<string, unknown>` parsed by hand.
 */
function traceAttempts(): RecordedAttempt[] {
    const session = sessionIdOf(SESSION_FIXTURE);
    const records = openTraceLog(TRACE_FIXTURE).read({
        where: (record) => record.session === session,
    });

    return nativeAttempts(records).map((record) => ({
        ts: record.ts,
        outcome: String(record.outcome),
        stopReason: record.stopReason,
        estimatedTokens: record.attempt?.estimatedTokens,
        estimateSource: record.attempt?.estimateSource,
        staleAnchors: record.attempt?.staleAnchors,
        providerPromptTokens: providerPromptTokens(record),
        chosenFirstKeptEntryId: record.attempt?.chosenFirstKeptEntryId,
        proposedFirstKeptEntryId: record.attempt?.proposedFirstKeptEntryId,
        cutFound: record.attempt?.cutFound,
        skippedEntries: record.attempt?.skippedEntries,
    }));
}

/**
 * The live context as it stood when each fold was decided: the rows before it, resolved through pi's own
 * compaction-aware view along the parent chain the fold was appended to.
 */
/** Narrowing predicate: `firstKeptEntryId` only exists on the compaction variant of the entry union. */
function isCompaction(entry: SessionEntry): entry is Extract<SessionEntry, { type: "compaction" }> {
    return entry.type === "compaction";
}

function foldWindows(): { fold: CompactionEntry; resolved: SessionEntry[] }[] {
    const entries = SessionManager.open(SESSION_FIXTURE).getEntries() as SessionEntry[];
    const folds = entries.filter(isCompaction);

    return folds.map((fold) => {
        const index = entries.indexOf(fold);
        const prior = entries.slice(0, index);
        // The fold's own parent is the leaf that was current when compaction ran. Reconstructing the path any
        // other way would silently follow a branch this session navigated away from, which it did several times.
        const resolved = piBuildContextEntries(
            prior,
            (fold as { parentId?: string | null }).parentId ?? null,
        );

        return { fold, resolved };
    });
}

describe("recorded three-fold session", () => {
    it("holds three compactions in one branch, each naming a boundary that resolves", () => {
        const windows = foldWindows();
        const attempts = traceAttempts();

        expect(windows).toHaveLength(3);
        expect(attempts).toHaveLength(3);

        for (const [index, window] of windows.entries()) {
            const cut = spanContextEntries(window.resolved, window.fold.firstKeptEntryId);
            // `cutFound` on every fold, matching the recorded field: a boundary that named no row would read as
            // a merely long span everywhere else, which is the gap 8 failure.
            expect(cut.cutFound, `fold ${String(index)}`).toBe(true);
            expect(attempts[index]?.cutFound).toBe(true);
        }
    });

    it("reproduces the recorded estimate and source for the folds that had a live count", () => {
        const windows = foldWindows();
        const attempts = traceAttempts();

        for (const index of [0, 2]) {
            const { fold, resolved } = windows[index];
            const recorded = attempts[index];
            const boundary = countBoundary(resolved);
            const counted = countSpanTokens({
                spanEntries: spanContextEntries(resolved, fold.firstKeptEntryId).entries,
                keptEntry: resolved.find((entry) => entry.id === fold.firstKeptEntryId),
                boundary,
                extraTokens: 0,
            });

            expect(counted.source, `fold ${String(index)} source`).toBe(recorded.estimateSource);
            expect(counted.source).toBe("exact-cut");
            // The recorded provider count for the request that went out, against the number this module sized
            // it with. Within the 5% band the report gives a count - and measured, far inside it.
            expect(recorded.providerPromptTokens).not.toBeNull();
            const provider = recorded.providerPromptTokens as number;
            expect(Math.abs(((counted.tokens as number) - provider) / provider)).toBeLessThan(0.05);
        }
    });

    it("reproduces the fold the guard saved: five expired counts, and a 3.8x error if they had been believed", () => {
        const [first, second] = foldWindows();
        const recorded = traceAttempts()[1];
        const { fold, resolved } = second;
        const span = spanContextEntries(resolved, fold.firstKeptEntryId).entries;

        // With the guard: nothing in this window is usable, so sizing falls to the heuristic and says so.
        const guarded = countSpanTokens({
            spanEntries: span,
            keptEntry: resolved.find((entry) => entry.id === fold.firstKeptEntryId),
            boundary: countBoundary(resolved),
            extraTokens: 0,
        });
        expect(guarded.tokens).toBeNull();
        // The recorded `stale=` value, reproduced from the session file alone.
        expect(guarded.staleAnchors).toBe(recorded.staleAnchors);
        expect(guarded.staleAnchors).toBe(5);
        expect(recorded.estimateSource).toBe("chars4");

        // Without it: the boundary row is an assistant kept across the first fold, whose `totalTokens` counts a
        // body that fold replaced with a summary.
        const unguarded = estimateAnchoredSpanTokens(span, 0) as number;
        const provider = recorded.providerPromptTokens as number;
        expect(unguarded).toBeGreaterThan(50_000);
        // 3.8x the truth, in the direction that reads as a provider clip (15% band) and, on a window small
        // enough, as "does not fit". This is the number the guard is worth rejecting a session's counts for.
        expect((unguarded - provider) / provider).toBeGreaterThan(2.5);
        // And what was actually charged, against what the heuristic then estimated: the fallback is not exact,
        // but it is inside its own band, which is why falling to it is survivable.
        expect(recorded.estimatedTokens).toBeDefined();
        expect(Math.abs(((recorded.estimatedTokens as number) - provider) / provider)).toBeLessThan(
            0.5,
        );
        expect(first.fold.id).not.toBe(second.fold.id);
    });

    it("reports stale counts beside a working exact count, so the field cannot read as a failure", () => {
        const windows = foldWindows();
        const recorded = traceAttempts()[2];

        // The third fold: 22 rows rejected as pre-boundary, and the sizing still came out exact to 0.09%,
        // because the boundary row itself was a post-fold reply. `stale=` therefore counts rejections, never
        // trouble - a reader who took it as a failure signal would chase the wrong thing.
        const { fold, resolved } = windows[2];
        const counted = countSpanTokens({
            spanEntries: spanContextEntries(resolved, fold.firstKeptEntryId).entries,
            keptEntry: resolved.find((entry) => entry.id === fold.firstKeptEntryId),
            boundary: countBoundary(resolved),
            extraTokens: 0,
        });

        expect(counted.source).toBe("exact-cut");
        expect(counted.staleAnchors).toBe(recorded.staleAnchors);
        expect(counted.staleAnchors).toBe(22);
    });

    it("records the boundary it used, and every fold here used core's", () => {
        const attempts = traceAttempts();

        // Three live folds produced no move. That is the honest baseline for a feature whose repair path has not
        // yet been exercised in the wild: `cutMoved` is real in the data, and still untested against a window
        // that actually forces it.
        for (const attempt of attempts) {
            expect(attempt.cutFound).toBe(true);
            expect(attempt.chosenFirstKeptEntryId).toBe(attempt.proposedFirstKeptEntryId);
            expect(attempt.skippedEntries).toBe(0);
        }
    });

    it("persists the pi-coder details shape on every fold, under pi's own key names", () => {
        const entries = SessionManager.open(SESSION_FIXTURE).getEntries() as SessionEntry[];
        const folds = entries.filter(isCompaction);

        for (const fold of folds) {
            const details = (fold.details ?? {}) as Record<string, unknown>;
            expect(details.version).toBe(1);
            expect(["two-stage", "native", "serialized"]).toContain(details.route);
            expect(typeof details.summarizedMessages).toBe("number");
            // These two names are load-bearing beyond our reader: core lifts them off the previous entry to
            // accumulate the session's file lists, and a rename fails silently rather than loudly.
            expect(Array.isArray(details.readFiles)).toBe(true);
            expect(Array.isArray(details.modifiedFiles)).toBe(true);
        }
    });

    it("falls to the heuristic exactly when the span holds no live count, not when the session does", () => {
        // The distinction that decides whether the fold-count rescue is worth building. The second fold's
        // *session* had three counted replies after the first fold, so "a live count exists" was true there -
        // but all three sat **below** the boundary, in the retained tail, while the span above it held only rows
        // whose counts predated the fold. Nothing in the body being sent was ever measured. The window is the
        // wrong scope; the span is the right one.
        const windows = foldWindows();

        for (const [index, window] of windows.entries()) {
            const span = spanContextEntries(window.resolved, window.fold.firstKeptEntryId).entries;
            const boundary = countBoundary(window.resolved);
            const liveInSpan = span.filter((entry) => {
                const { total } = promptAndTotalTokens(entry);

                return (
                    total !== null &&
                    !Number.isNaN(Date.parse(entry.timestamp)) &&
                    Date.parse(entry.timestamp) > boundary
                );
            }).length;
            const counted = countSpanTokens({
                spanEntries: span,
                boundary,
                extraTokens: 0,
            });

            expect(counted.tokens !== null, `fold ${String(index)}`).toBe(liveInSpan > 0);
            if (index === 1) {
                // Proves the scope matters: this fold has counts in the session and none in the span.
                expect(liveInSpan).toBe(0);
                expect(window.resolved.length).toBeGreaterThan(span.length);
            }
        }
    });
});
