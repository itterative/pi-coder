import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
    bodyTokens,
    correctAcrossFolds,
    estimatedShare,
    foldNet,
    foldNets,
    headAt,
    MAX_LEDGER_ESTIMATED_SHARE,
    measureEntries,
    spanBodyTokens,
    spanSizer,
    type BodyHead,
} from "../../../src/modules/compaction/ledger";
import { countBoundary } from "../../../src/modules/compaction/native-request";
import { segmentSummaryInstruction } from "../../../src/modules/compaction/prompt";
import { previousFoldWindowStart } from "../../../src/modules/compaction/span-session";
import { estimateTextTokens } from "../../../src/modules/compaction/text";
import { estimateEntryTokens, rowPromptTokens } from "../../../src/modules/compaction/usage";
import { countedUsage } from "../../helpers/agent-doubles";
import {
    assistantMessage,
    bashExecutionMessage,
    compactionMarker,
    compactionPreparation,
    customEntry,
    customMessageEntry,
    messageChain,
    messageEntry,
    modelChangeMarker,
    thinkingLevelMarker,
    userMessage,
} from "../../helpers/compaction-doubles";
import {
    chainRequests,
    fixturePath,
    loadCapture,
    nativeAttempts,
    openTraceLog,
    prefixRecords,
    providerPromptTokens,
    requireAttemptForFold,
} from "../../helpers/compaction-trace";

/**
 * Can a session answer for the part of a request no row owns?
 *
 * Every body pi sends is `[system prompt][tool definitions][checkpoint(s)][rows...]`. The tail is the only part
 * the session stores, and it is also the part a provider's own `usage` already counts - so the head, which is in
 * every request and in no row, is the one term sizing used to guess at. `ledger.ts` claims it falls out of the
 * counts anyway: the first reply counted under a head was charged for exactly `head + rows`, and two replies on
 * the same basis bracket everything between them exactly. Taken separately `P` and `K` stay estimates; together
 * they are a difference of provider numbers.
 *
 * This file checks that claim against a capture rather than against the module's own arithmetic, which is the
 * mistake the first version of it made. Its second route - `fold.usage.output` minus the stage-1 span - disagreed
 * with the ledger by 5.5% and 11.5% and read as a defect in the ledger. It was not: that route forgot the
 * instruction stage 1 appends (474 and 511 provider tokens, measured below), took the checkpoint's size from the
 * reduce stage's model text instead of the summary that was persisted, and did not know that fold 2 of this
 * session kept fold 1's checkpoint riding in the body. Three terms, all real, all absent from the ledger's own
 * algebra - which came out right.
 *
 * ## The capture
 *
 * `hosted-head-ledger.jsonl` and its trace are one live hosted session (qwen3.8-flash, 1M window), 216 branch
 * rows and three folds, recorded 2026-09-06 by the first build carrying the `stageOneSpanEntries` ordering fix.
 * Every number asserted here is a measurement of that pair; the bands are those measurements plus room to move,
 * and each says where it came from. The first describe block is the gate that earns the rest: a capture whose
 * request shape moved, or whose rebuild the provider had not already served, cannot vouch for anybody's
 * arithmetic. The trace fixture also keeps four `chain_request` rows of a *second* session on purpose, so the
 * session filter below is a tested property of the pair rather than an assumption about it.
 */
const SESSION_FIXTURE = fixturePath("session", "hosted-head-ledger.jsonl");
const TRACE_FIXTURE = fixturePath("compaction-trace.hosted-head-ledger.jsonl");

const CAPTURE = loadCapture({ sessionFile: SESSION_FIXTURE, traceFile: TRACE_FIXTURE });
const BRANCH = CAPTURE.branch;

/** A second capture, whose third fold is the misbuilt one `stageOneSpanEntries` was written for. */
const THREE_FOLDS = SessionManager.open(
    fixturePath("session", "hosted-three-folds.jsonl"),
).getBranch();

/**
 * The capture that first fired the tier live: three folds in one session, the last two sized by `head-ledger`
 * rather than by a count of their own, and the only fixture whose trace carries real `ledger` fields - so it is
 * what the report's ledger output is pinned against instead of a synthetic record.
 *
 * It also holds the two shapes the first capture does not: a reply the user **cancelled** (`stopReason:
 * "aborted"`, all-zero usage, which no tier may anchor on), and a fold at the very tip whose head is therefore
 * unsolvable. Its third window is six messages long, which is what made the trailing-stretch estimate visible.
 */
const LIVE = loadCapture({
    sessionFile: fixturePath("session", "hosted-live-ledger.jsonl"),
    traceFile: fixturePath("compaction-trace.hosted-live-ledger.jsonl"),
});
const LIVE_BRANCH = LIVE.branch;

type Fold = Extract<SessionEntry, { type: "compaction" }>;

function foldPositions(branch: readonly SessionEntry[]): Array<{ fold: Fold; index: number }> {
    return branch.flatMap((entry, index) =>
        entry.type === "compaction" ? [{ fold: entry, index }] : [],
    );
}

function indexOfId(branch: readonly SessionEntry[], id: string | undefined): number {
    if (id === undefined) {
        return -1;
    }

    return branch.findIndex((entry) => entry.id === id);
}

/**
 * Where the body a head describes begins: its own fold's boundary, or the branch start when the head is the bare
 * prefix. Everything before that was folded away, so charging it would size a body the provider never saw.
 */
function windowStartOf(branch: readonly SessionEntry[], head: BodyHead): number {
    if (head.foldId === undefined) {
        return 0;
    }

    const fold = branch.find((entry) => entry.id === head.foldId) as Fold | undefined;

    return indexOfId(branch, fold?.firstKeptEntryId);
}

/** The instruction stage 1 appends, rebuilt the way the handler builds it: only `previousSummary` varies. */
function instructionTokens(hasPreviousSummary: boolean): number {
    const text = segmentSummaryInstruction({
        preparation: compactionPreparation({
            previousSummary: hasPreviousSummary ? "an earlier checkpoint" : undefined,
        }),
    });

    return estimateTextTokens(text);
}

describe("the capture is one the arithmetic can be trusted on", () => {
    it("reads its own session's records out of a file that holds two sessions", () => {
        // The fixture keeps four rows of another session, so this is a property of the pair and not a tautology:
        // an unfiltered read of the same file sees more chain rows, and a shape gate built on it would be
        // describing a session it was never given.
        const unfiltered = openTraceLog(TRACE_FIXTURE).read();

        expect(CAPTURE.sessionId).toBe("01a078c2-c55b-7f46-b6b1-90ab9ae31903");
        expect(CAPTURE.foreignRecords.length).toBe(4);
        expect(chainRequests(unfiltered).length).toBeGreaterThan(
            chainRequests(CAPTURE.records).length,
        );
        expect(CAPTURE.records.every((record) => record.session === CAPTURE.sessionId)).toBe(true);
        expect(chainRequests(CAPTURE.records).length).toBe(63);
    });

    it("held one request shape for the whole session", () => {
        const rows = chainRequests(CAPTURE.records);

        // A derived head is a property of a shape. Two system prompts in one session would make every head
        // below a blend of both, and nothing in the session file would say so - pi records a model or thinking
        // change, not its own base-versus-override prompt flip.
        expect(rows.length).toBeGreaterThan(50);
        expect(new Set(rows.map((row) => row.systemChars))).toEqual(new Set([25_975]));
        expect(new Set(rows.map((row) => row.toolsHash)).size).toBe(1);
        expect(new Set(rows.map((row) => row.model))).toEqual(new Set(["qwen3.8-flash"]));
    });

    it("verified every stage-1 rebuild against a request the provider had already served", () => {
        const prefixes = prefixRecords(CAPTURE.records);

        expect(prefixes.length).toBe(3);
        for (const record of prefixes) {
            const prefix = record.prefix;
            expect(prefix, `run ${record.id}`).toBeDefined();
            // Message-level agreement, which is what makes the provider's count of that request a statement
            // about ours. `otherDisagreements` is not asserted: it counts *other* comparable references, mostly
            // stale pre-compaction ladders, and this session has 0, 12 and 26 of them across its three runs.
            expect(prefix?.prefixUsable, `run ${record.id}`).toBe(true);
            expect(prefix?.firstDivergence, `run ${record.id}`).toBe("verified");
            expect(prefix?.firstMismatchDepth, `run ${record.id}`).toBeNull();
            expect(prefix?.divergences, `run ${record.id}`).toEqual([]);
            expect(prefix?.parameters, `run ${record.id}`).toEqual([]);
        }
    });

    it("cut and copied every span cleanly", () => {
        const attempts = nativeAttempts(CAPTURE.records);

        expect(attempts.length).toBe(3);
        for (const attempt of attempts) {
            expect(attempt.attempt?.cutFound, `run ${attempt.id}`).toBe(true);
            // A row stage 1 could not append makes our span smaller than the body the provider counted, which
            // would put the error in the fixture rather than in the ledger.
            expect(attempt.attempt?.skippedEntries, `run ${attempt.id}`).toBe(0);
            expect(providerPromptTokens(attempt), `run ${attempt.id}`).not.toBeNull();
        }
    });
});

describe("the head no row owns", () => {
    it("solves the bare prefix from the first counted reply, and P+K from the first reply after each fold", () => {
        const folds = foldPositions(BRANCH);
        const bare = headAt(BRANCH, folds[0]?.index ?? BRANCH.length);

        // Measured, and the reason the whole construction is worth having: 96 tokens of chars/4 against a 7,628
        // answer, because the first counted reply has only seven rows in front of it.
        expect(bare?.source).toBe("first-reply");
        expect(bare?.tokens).toBe(7_628);
        expect(bare?.estimatedTokens).toBe(96);
        expect(bare !== null && bare.estimatedTokens / bare.tokens).toBeLessThan(0.02);

        // Each fold's head is the bare prefix plus a checkpoint, and each is solved from that fold's own first
        // counted reply. The second is smaller than the first even though it carries two checkpoints' worth of
        // history, because a checkpoint is what the fold wrote: fold 2's summary is 3,888 chars against fold 1's
        // 6,281. The heads are not monotone, and a test that assumed they were would pass on a broken walk.
        const heads = folds.map(({ index }) => headAt(BRANCH, index + 1));
        expect(heads.map((head) => head?.tokens)).toEqual([9_379, 8_746, 10_056]);
        expect(heads.map((head) => head?.foldId)).toEqual(folds.map(({ fold }) => fold.id));
        expect(heads.every((head) => head !== null && head.tokens > (bare?.tokens ?? 0))).toBe(
            true,
        );
    });

    it("reproduces every counted reply's own provider count from the head plus the rows it carries", () => {
        const predicted: number[] = [];
        const skipped: number[] = [];

        for (const [index, entry] of BRANCH.entries()) {
            const actual = rowPromptTokens(entry);
            if (actual === null) {
                continue;
            }

            const head = headAt(BRANCH, index);
            const body =
                head === null
                    ? null
                    : bodyTokens(BRANCH, {
                          atIndex: index,
                          from: windowStartOf(BRANCH, head),
                          to: index,
                      });
            if (body === null) {
                // The reply the bare head was solved from has no head before itself; nothing else may skip.
                skipped.push(index);
                continue;
            }

            expect(body.tokens, `reply at ${String(index)}`).toBe(actual);
            predicted.push(index);
        }

        // 62 of the session's 63 counted replies, reproduced exactly. Exact **by construction**, not by accuracy,
        // and that is what the assertion is for: the head subtracts a measured range from its anchor's count and
        // the body adds a range starting in the same place, so the one estimated term they share - the leading
        // stretch no pair of counts brackets - cancels, and since both ranges close on a counted entry there is
        // nothing left to guess at their ends either. What equality therefore pins is *symmetry*: that the walk
        // restarts at the same fold rows in both ranges, charges the head's own checkpoint once, and applies the
        // closing bracket to both. It is not a weak test - it caught a missing flush of a counted reply at a fold
        // restart, and a head's fold row dropped from the range instead of charged nothing, each as a token-level
        // difference here. Accuracy is the next test's question, where the body sized is a different body from
        // the one the head was solved from.
        expect(skipped).toEqual([7]);
        expect(predicted.length).toBe(62);
    });

    it("sizes a stage-1 request as head + window + instruction", () => {
        const folds = foldPositions(BRANCH);
        const measured: number[] = [];
        const recorded: number[] = [];

        for (const { fold, index } of folds) {
            const attempt = requireAttemptForFold(CAPTURE.records, fold);
            const provider = providerPromptTokens(attempt);
            expect(provider, `fold ${fold.id}`).not.toBeNull();

            // The branch as it stood when the request went out, which is what the handler passes: this fold's own
            // row did not exist yet, so the newest row is the previous fold and `atIndex` is the branch length.
            const branchThen = BRANCH.slice(0, index);
            const startId = previousFoldWindowStart(branchThen);
            const body = spanBodyTokens(branchThen, {
                windowStartId: startId,
                cutId: attempt.attempt?.chosenFirstKeptEntryId ?? "",
                extraTokens: instructionTokens(startId !== undefined),
                boundary: countBoundary(branchThen),
            });

            expect(body, `fold ${fold.id}`).not.toBeNull();
            const error = Math.abs((body?.tokens ?? 0) - (provider ?? 0)) / (provider ?? 1);
            measured.push(error);
            recorded.push(
                Math.abs((attempt.attempt?.estimatedTokens ?? 0) - (provider ?? 0)) /
                    (provider ?? 1),
            );

            // Where this fold's checkpoint sits is the whole subtlety of the split. Fold 2's cut is *below*
            // fold 1's row, so fold 1's checkpoint is in the head the request was sized with (`stageOneSpanEntries`
            // appends the newest fold row when the window lacks it, and pi hoists it to the front) and its window
            // holds no fold row at all. Fold 3's window reaches below both earlier folds: its own checkpoint is
            // paid by the head, and fold 1's still rides inline as a row, charged as the text it now is.
            if (fold.id === "7cd77f1c") {
                expect(body?.head.foldId).toBe(folds[0]?.fold.id);
                expect(body?.rows.restarts).toBe(0);
                expect(body?.rows.checkpoints).toBe(0);
            }
            if (fold.id === "df47d0eb") {
                expect(body?.head.foldId).toBe(folds[1]?.fold.id);
                // Two fold rows in the window: the head's own, which restarts the walk and costs nothing, and
                // fold 1's 1,631-token checkpoint, which nothing else in the body accounts for.
                expect(body?.rows.restarts).toBe(2);
                expect(body?.rows.checkpoints).toBeGreaterThan(1_000);
                expect(body?.rows.checkpoints).toBeLessThan(2_000);
            }
        }

        // Measured 0.05%, 0.01% and 0.03%, against the tiers that shipped at the time recording 0.18%, 8.81% and
        // 0.08% for the same three requests. Two things make this the accuracy check and the reply test above a
        // consistency one: the body sized here is not the body the head was solved from, and the provider counted
        // the request that actually went out. On the middle run the ledger now beats `exact-cut` too, whose error
        // is entirely the instruction estimate (512 charged for 474 real tokens on a 21k body).
        expect(measured.every((error) => error < 0.005)).toBe(true);

        // The point of the module, on the one run that needed it: fold 2 expired every count in its span
        // (`staleAnchors: 14`), so the shipped tiers fell back to chars/4 over the whole body and overshot by
        // 8.8%, while the head plus measured rows landed within 0.01%. On the two `exact-cut` runs the recorded
        // number is a provider count of that very body and stays the better answer - the ledger is not a
        // replacement for a count, it is what remains usable when every count in the span has expired.
        const chars4Run = nativeAttempts(CAPTURE.records).findIndex(
            (attempt) => attempt.attempt?.estimateSource === "chars4",
        );
        expect(chars4Run).toBe(1);
        expect(recorded[chars4Run]).toBeGreaterThan(0.08);
        expect(measured[chars4Run]).toBeLessThan(recorded[chars4Run] / 8);
    });

    it("measures the instruction the trace never recorded, from two provider counts", () => {
        for (const { fold } of foldPositions(BRANCH)) {
            const attempt = requireAttemptForFold(CAPTURE.records, fold);
            // `exact-cut` sizes the request from the count of the reply sitting at the cut, so the record's own
            // estimate is that count plus chars/4 of the instruction - and the provider's count of the request is
            // the same count plus the instruction as the model's tokenizer saw it. Their two differences from the
            // kept entry's count isolate the instruction, which nothing in the trace stores.
            if (attempt.attempt?.estimateSource !== "exact-cut") {
                continue;
            }

            const kept = indexOfId(BRANCH, attempt.attempt.chosenFirstKeptEntryId);
            const keptPrompt = rowPromptTokens(BRANCH[kept] as SessionEntry);
            const provider = providerPromptTokens(attempt);
            expect(keptPrompt, `fold ${fold.id}`).not.toBeNull();
            expect(provider, `fold ${fold.id}`).not.toBeNull();

            const charged = (provider ?? 0) - (keptPrompt ?? 0);
            const estimated = (attempt.attempt.estimatedTokens ?? 0) - (keptPrompt ?? 0);

            // 474 and 511 tokens charged, against 512 and 561 estimated: chars/4 of one instruction is within
            // 10% of what the provider counted, which is the whole error the `exact-cut` band carries.
            expect(charged).toBeGreaterThan(400);
            expect(charged).toBeLessThan(600);
            expect(Math.abs(estimated - charged) / charged).toBeLessThan(0.1);
        }
    });
});

describe("what a fold did to the body", () => {
    it("derives a net for every fold it can bracket, and refuses the ones it cannot", () => {
        const nets = foldNets(BRANCH);

        // All three folds of the capture, from a session that kept running after each. Measured -11,494, -19,178
        // and -54,643: what each fold put in, less what it took out.
        expect(nets.map((net) => net.foldId)).toEqual(
            foldPositions(BRANCH).map(({ fold }) => fold.id),
        );
        expect(nets.map((net) => net.net)).toEqual([-11_494, -19_178, -54_643]);

        // The second capture brackets all three of its folds too, and its third is the one `stageOneSpanEntries`
        // was written for: a misbuilt request changes what the provider counted, not what the session stored, so
        // the ledger reads it like any other fold. What it must never do is answer for a fold whose only
        // bracketing reply predates the previous fold - see the synthetic case below.
        const threeFolds = foldPositions(THREE_FOLDS);
        const bracketed = foldNets(THREE_FOLDS);
        expect(threeFolds.length).toBe(3);
        expect(bracketed.length).toBe(3);
        for (const net of bracketed) {
            expect(threeFolds.some(({ fold }) => fold.id === net.foldId)).toBe(true);
        }
    });

    it("refuses a fold whose only bracketing reply was counted under an earlier head", () => {
        // Two folds, and no reply counted between them: the second fold's boundary reaches below the first fold's
        // row, so the only reply that could bracket its start was charged a body the first fold has since
        // rewritten. Using it would fold that fold's net into this one - twice, once `foldNets` sums them - so
        // both refuse, and the caller keeps whatever fallback it had.
        const counted = (id: string, text: string, input: number, output: number) => ({
            id,
            message: assistantMessage({ text, usage: countedUsage(input, output) }),
        });
        const entries = [
            ...messageChain([
                { id: "u1", message: userMessage("the ask") },
                counted("a1", "y".repeat(40), 5_000, 100),
            ]),
            compactionMarker("f1", {
                at: "1970-01-01T00:00:01.000Z",
                firstKeptEntryId: "u1",
                summaryTokens: 500,
            }),
            ...messageChain([{ id: "u2", message: userMessage("and again") }]),
            compactionMarker("f2", {
                at: "1970-01-01T00:00:02.000Z",
                firstKeptEntryId: "u1",
                summaryTokens: 400,
            }),
            ...messageChain([counted("a2", "w".repeat(40), 1_500, 40)]),
        ];

        // Indexes: u1 0, a1 1, f1 2, u2 3, f2 4, a2 5.
        expect(entries.map((entry) => entry.id)).toEqual(["u1", "a1", "f1", "u2", "f2", "a2"]);
        // f1 has no counted reply before the next fold moved the head again.
        expect(foldNet(entries, 2)).toBeNull();
        // f2's boundary is u1, so an unrestricted search would bracket it with a1 - counted before f1 existed.
        expect(foldNet(entries, 4)).toBeNull();
        expect(foldNets(entries)).toEqual([]);

        // The positive control: one counted reply between the folds brackets both, and each net is then a
        // difference of counts taken under a single head.
        const bracketed = [
            ...entries.slice(0, 3),
            ...messageChain([counted("a1b", "v".repeat(40), 2_000, 60)]),
            ...entries.slice(3),
        ];
        const nets = foldNets(bracketed);
        expect(nets.length).toBe(2);
        expect(nets.every((net) => net.net < 0)).toBe(true);
        // u1 0, a1 1, f1 2, a1b 3, u2 4, f2 5, a2 6: each fold now brackets against a reply counted under its
        // own head, so each net is a difference of two counts on one basis.
        expect(foldNet(bracketed, 2)?.foldId).toBe("f1");
        expect(foldNet(bracketed, 5)?.foldId).toBe("f2");
    });

    it("never derives a positive net, and never estimates more than one turn of it", () => {
        for (const branch of [BRANCH, THREE_FOLDS]) {
            for (const net of foldNets(branch)) {
                expect(net.net).toBeLessThan(0);
                // The only estimated term is the gap between two counted replies: the earlier reply's own output,
                // which is counted, plus the rows behind it. Measured 88-95 tokens here against nets of 11k-54k,
                // so the bound is stated in absolute tokens - a fold that barely compressed anything would make a
                // relative bound meaningless.
                expect(net.estimatedTokens).toBeLessThan(200);
                // And the estimate never dominates the answer. Not a ratio: the second capture holds a fold that
                // compressed almost nothing (a net of 2,105 against 119 estimated), and a proportional bound
                // would either fail on it or be too loose to mean anything on the others.
                expect(Math.abs(net.net)).toBeGreaterThan(net.estimatedTokens);
            }
        }
    });

    it("corrects a stale count to the body the direct route measures", () => {
        const folds = foldPositions(BRANCH);
        const newest = folds.at(-1);
        expect(newest).toBeDefined();

        const head = headAt(BRANCH, BRANCH.length);
        const from = windowStartOf(BRANCH, head as BodyHead);
        expect(head?.foldId).toBe(newest?.fold.id);

        // Two independent routes to one number. `correctAcrossFolds` walks a stale count forward through every
        // fold after it; the direct route sizes the same body from the head in force now plus the rows that
        // survived. They share no arithmetic: one sums fold deltas, the other solves a head from a later reply.
        let checked = 0;
        for (const [index, entry] of BRANCH.entries()) {
            const stale = rowPromptTokens(entry);
            const survivesTheNewestFold = index >= from && index < (newest?.index ?? 0);
            if (stale === null || !survivesTheNewestFold) {
                continue;
            }

            const corrected = correctAcrossFolds(BRANCH, stale, index);
            if (corrected === null) {
                continue;
            }

            const direct =
                (head?.tokens ?? 0) +
                measureEntries(BRANCH.slice(from, index), { headFoldId: head?.foldId }).tokens;
            expect(Math.abs(corrected.tokens - direct) / direct).toBeLessThan(0.02);
            expect(corrected.folds).toBeGreaterThan(0);
            checked += 1;
        }

        // One reply in this capture is both stale and still inside the newest fold's retained stretch; a
        // cross-check that silently found none would be a cross-check that ran never.
        expect(checked).toBeGreaterThan(0);
    });
});

describe("measuring a range of entries", () => {
    it("brackets everything between two counted replies, and guesses only the ends", () => {
        const entries = messageChain([
            { id: "u1", message: userMessage("x".repeat(400)) },
            {
                id: "a1",
                message: assistantMessage({ text: "y".repeat(40), usage: countedUsage(1_000, 50) }),
            },
            { id: "u2", message: userMessage("z".repeat(4_000)) },
            {
                id: "a2",
                message: assistantMessage({ text: "w".repeat(40), usage: countedUsage(2_200, 60) }),
            },
        ]);

        const measured = measureEntries(entries);

        // `u2` is a thousand tokens of text no chars/4 estimate has to touch: the difference of the two counts
        // covers it and `a1`'s own reply with it. Only `u1`, which nothing brackets, is estimated.
        expect(measured.counted).toBe(2_200 - 1_000 + 60);
        expect(measured.estimated).toBe(estimateEntryTokens([entries[0] as SessionEntry]));
        expect(measured.tokens).toBe(measured.counted + measured.estimated);
        expect(measured.restarts).toBe(0);
    });

    it("restarts at a fold row instead of differencing across the basis it changes", () => {
        const before = messageChain([
            {
                id: "a1",
                message: assistantMessage({
                    text: "y".repeat(40),
                    usage: countedUsage(5_000, 100),
                }),
            },
        ]);
        const fold = compactionMarker("f1", {
            at: "1970-01-01T00:00:01.000Z",
            firstKeptEntryId: "a1",
            summary: "s".repeat(400),
        });
        const after = messageChain([
            {
                id: "a2",
                message: assistantMessage({ text: "w".repeat(40), usage: countedUsage(2_000, 50) }),
            },
        ]);
        const entries = [...before, fold, ...after];

        const measured = measureEntries(entries);

        // 2,000 - 5,000 is not a row count: the second reply was charged a body the fold had already rewritten.
        // What survives the restart is each reply's own output, plus the checkpoint as the text it now is.
        expect(measured.restarts).toBe(1);
        expect(measured.counted).toBe(150);
        expect(measured.checkpoints).toBe(estimateEntryTokens([fold]));
        expect(measured.tokens).toBeGreaterThan(0);
    });

    it("restarts at a shape-change row inside the range, which is what the fold-only rule got wrong", () => {
        // Same arithmetic as the fold case above, and the same trap, but the row changes the basis instead of
        // reclaiming a span: a model change moves the tokenizer, a thinking-level change moves the templated
        // preamble. Either way `input(next) - input(prev)` is a difference of two bodies and is not a row count.
        // The post-change count is deliberately *larger* than the pre-change one: the old code then produced a
        // plausible-looking 3,150 counted tokens instead of a negative number, and a test that only fails on an
        // absurd value is a test that passes on a quiet one.
        const shapeRows: { label: string; row: SessionEntry }[] = [
            {
                label: "model_change",
                row: modelChangeMarker("m1", { at: "1970-01-01T00:00:01.000Z" }),
            },
            {
                label: "thinking_level_change",
                row: thinkingLevelMarker("t1", { at: "1970-01-01T00:00:01.000Z" }),
            },
        ];

        for (const { label, row } of shapeRows) {
            const before = messageChain([
                {
                    id: "a1",
                    message: assistantMessage({
                        text: "y".repeat(40),
                        usage: countedUsage(5_000, 100),
                    }),
                },
            ]);
            const after = messageChain([
                {
                    id: "a2",
                    message: assistantMessage({
                        text: "w".repeat(40),
                        usage: countedUsage(8_000, 50),
                    }),
                },
            ]);

            const measured = measureEntries([...before, row, ...after]);

            // Only the two replies' own outputs survive the restart.
            expect(measured, label).toMatchObject({ restarts: 1, counted: 150 });
            // Unlike a fold, a shape row produces no message, so it contributes nothing to the estimate either.
            expect(measured.checkpoints, label).toBe(0);
            expect(measured.estimated, label).toBe(0);
        }
    });

    it("charges the head's own checkpoint once, and still restarts at its row", () => {
        const before = messageChain([
            {
                id: "a1",
                message: assistantMessage({
                    text: "y".repeat(40),
                    usage: countedUsage(5_000, 100),
                }),
            },
        ]);
        const fold = compactionMarker("f1", {
            at: "1970-01-01T00:00:01.000Z",
            firstKeptEntryId: "a1",
            summary: "s".repeat(400),
        });
        const entries = [...before, fold];

        const paid = measureEntries(entries, { headFoldId: "f1" });

        // Dropping the row from the range instead would take `prompt` differences across the basis change it
        // marks, which is the bug this option exists to prevent: the walk must see the row and not charge it.
        expect(paid.restarts).toBe(1);
        expect(paid.checkpoints).toBe(0);
        expect(paid.counted).toBe(100);
        expect(paid.tokens).toBe(100);
        expect(measureEntries(entries).tokens).toBeGreaterThan(paid.tokens);
    });

    it("closes on the count past its end, which makes the trailing stretch exact", () => {
        const entries = messageChain([
            {
                id: "a1",
                message: assistantMessage({ text: "y".repeat(40), usage: countedUsage(1_000, 50) }),
            },
            { id: "u1", message: userMessage("z".repeat(4_000)) },
            {
                id: "a2",
                message: assistantMessage({ text: "w".repeat(40), usage: countedUsage(2_200, 60) }),
            },
        ]);
        const range = entries.slice(0, 2);

        // A cut lands on the reply that consumed a tool result, so the rows in front of it are uncounted and
        // open-ended they are a guess. The cut entry's own count brackets them: one difference covers the last
        // counted reply and every row behind it, and the cut entry's own reply is outside the range, so it is
        // walked for chaining and never charged.
        const open = measureEntries(range);
        const closed = measureEntries(range, { closing: entries[2] as SessionEntry });

        expect(open.counted).toBe(50);
        expect(open.estimated).toBe(estimateEntryTokens([entries[1] as SessionEntry]));
        expect(closed.counted).toBe(2_200 - 1_000);
        expect(closed.estimated).toBe(0);
        // The guess was 13% low on this row, which is the whole error the bracket removes.
        expect(closed.tokens).toBeGreaterThan(open.tokens);
    });

    it("declines the closing bracket when a fold row sits between, because the bases differ", () => {
        const countedReply = (id: string, input: number, output: number) =>
            messageChain([
                {
                    id,
                    message: assistantMessage({
                        text: "y".repeat(40),
                        usage: countedUsage(input, output),
                    }),
                },
            ]);
        const entries = [
            ...countedReply("a1", 5_000, 100),
            compactionMarker("f1", {
                at: "1970-01-01T00:00:01.000Z",
                firstKeptEntryId: "a1",
                summary: "s".repeat(400),
            }),
            ...messageChain([{ id: "u1", message: userMessage("z".repeat(400)) }]),
        ];
        const closing = countedReply("a2", 2_000, 60)[0] as SessionEntry;

        // 2,000 - 5,000 is not a row count: the fold between them changed the head, so the walk restarted and
        // has no basis to difference against. The rows stay a guess, which is the honest answer.
        const measured = measureEntries(entries, { closing });

        expect(measured.restarts).toBe(1);
        expect(measured.counted).toBe(100);
        expect(measured.estimated).toBeGreaterThan(0);
        expect(measured.tokens).toBe(measureEntries(entries).tokens);
    });

    it("declines the closing bracket when the entry past the range carries no count", () => {
        const entries = messageChain([
            {
                id: "a1",
                message: assistantMessage({ text: "y".repeat(40), usage: countedUsage(1_000, 50) }),
            },
            { id: "u1", message: userMessage("z".repeat(400)) },
        ]);
        const uncounted = messageChain([{ id: "u2", message: userMessage("and again") }])[0];

        expect(measureEntries(entries, { closing: uncounted as SessionEntry })).toEqual(
            measureEntries(entries),
        );
    });
});

describe("what the estimator charges for an entry", () => {
    it("charges a custom_message, which reaches the provider, and not the custom entry beside it", () => {
        const content = "k".repeat(400);
        const marker = customMessageEntry("c1", "pi-memory:memory-index", content, {
            details: { bytes: "d".repeat(4_000) },
        });
        const state = customEntry("c2", "pi-coder:scratchpad", { path: "/tmp/x" });

        // `buildContextEntries` turns one into a user message and returns nothing for the other, so one costs
        // what its content costs and the other costs zero. Measured on the capture: a 208-char pi-memory marker
        // the estimator used to answer 0 for, in a range whose whole estimate was 30 tokens.
        expect(estimateEntryTokens([state])).toBe(0);
        expect(estimateEntryTokens([marker])).toBeGreaterThan(estimateTextTokens(content));
        expect(estimateEntryTokens([marker])).toBeLessThan(estimateTextTokens(content) + 20);
        // The entry's `details` are extension metadata pi never sends, so a kilobyte of them costs nothing.
        expect(estimateEntryTokens([marker])).toBe(
            estimateEntryTokens([customMessageEntry("c3", "pi-memory:memory-index", content)]),
        );
    });

    it("charges a riding checkpoint with the wrapper pi renders it in", () => {
        const summary = "s".repeat(400);
        const fold = compactionMarker("f1", {
            at: "1970-01-01T00:00:01.000Z",
            firstKeptEntryId: "x",
            summary,
        });

        // `convertToLlm` wraps a summary in pi's `<summary>` preamble and `wireShaped` charges the JSON envelope
        // around it, so a checkpoint riding inside a retained stretch costs more than its text: 41 tokens over the
        // bare 100 here (26 of wrapper, 12 of envelope), against 1,631 for the capture's largest checkpoint.
        const charged = estimateEntryTokens([fold]);
        expect(charged).toBeGreaterThan(estimateTextTokens(summary));
        expect(charged).toBeLessThan(estimateTextTokens(summary) + 60);
    });

    it("charges a bash execution as the text pi derives, unless it was excluded from context", () => {
        const output = "o".repeat(400);
        const run = bashExecutionMessage({ command: "ls -la", output });
        const hidden = bashExecutionMessage({
            command: "ls -la",
            output,
            excludeFromContext: true,
        });

        // The stored row has no `content` field at all, so a projection of `{role, content}` charged it as
        // empty and dropped the output a provider really reads.
        expect(estimateEntryTokens([messageEntry("b1", run)])).toBeGreaterThan(
            estimateTextTokens(output),
        );
        expect(estimateEntryTokens([messageEntry("b2", hidden)])).toBe(0);
    });
});

describe("what the ledger declines to size", () => {
    /** A counted reply as a `messageChain` item, at the default entry timestamp unless one is given. */
    const counted = (id: string, input: number, output: number, at?: string) => ({
        id,
        message: assistantMessage({ text: "y".repeat(40), usage: countedUsage(input, output) }),
        ...(at === undefined ? {} : { at }),
    });

    it("declines a cut that names no row, and a window that starts after its cut", () => {
        const entries = messageChain([
            { id: "u1", message: userMessage("the ask") },
            counted("a1", 5_000, 100),
        ]);

        // A cut naming no row is `cutFound: false` territory, where the span came back as the whole transcript:
        // sizing that as a window would report the branch as a span and nobody could tell afterwards.
        expect(spanBodyTokens(entries, { cutId: "absent", extraTokens: 0 })).toBeNull();
        expect(
            spanBodyTokens(entries, { windowStartId: "a1", cutId: "u1", extraTokens: 0 }),
        ).toBeNull();
    });

    it("declines when nothing in the session was ever counted", () => {
        const entries = messageChain([
            { id: "u1", message: userMessage("the ask") },
            { id: "u2", message: userMessage("and again") },
        ]);

        expect(spanBodyTokens(entries, { cutId: "u2", extraTokens: 0 })).toBeNull();
    });

    it("declines a body too much of which is chars/4, and sizes one that is not", () => {
        // The same shape twice: a head solved from the first counted reply, and one row in front of it. Only the
        // row's size differs, which is what moves the estimated share across the refusal line.
        const heavy = messageChain([
            { id: "u1", message: userMessage("x".repeat(40_000)) },
            counted("a1", 12_000, 100),
        ]);
        const light = messageChain([
            { id: "u1", message: userMessage("x".repeat(400)) },
            counted("a1", 12_000, 100),
        ]);

        // 91%-style case: the answer would be a guess wearing a count's clothing, and it errs low, which is the
        // one direction a fit gate must not be wrong in. Named rather than inferred, so a future tightening of the
        // limit says which side of it this fixture sits on.
        const ungateable = bodyTokens(heavy, {
            atIndex: heavy.length,
            from: 0,
            to: 1,
            extraTokens: 0,
        });
        expect(ungateable).not.toBeNull();
        expect(estimatedShare(ungateable as NonNullable<typeof ungateable>)).toBeGreaterThan(
            MAX_LEDGER_ESTIMATED_SHARE,
        );
        expect(spanBodyTokens(heavy, { cutId: "a1", extraTokens: 0 })).toBeNull();

        // Where the window is exactly the range the head was solved from, the two measurements cancel and the
        // body reproduces that reply's own provider count - no estimate left in the total at all.
        const sized = spanBodyTokens(light, { cutId: "a1", extraTokens: 0 });
        expect(sized?.tokens).toBe(12_000);
        expect(sized?.head.source).toBe("first-reply");
        expect(estimatedShare(sized as NonNullable<typeof sized>)).toBeLessThan(
            MAX_LEDGER_ESTIMATED_SHARE,
        );
    });

    it("declines a head solved before a shape change, when the caller reports one", () => {
        const entries = [
            ...messageChain([
                { id: "u1", message: userMessage("the ask") },
                counted("a1", 5_000, 100),
            ]),
            modelChangeMarker("m1", { at: "1970-01-01T00:00:05.000Z" }),
            ...messageChain([
                {
                    id: "u2",
                    message: userMessage("after the switch"),
                    at: "1970-01-01T00:00:06.000Z",
                },
            ]),
        ];

        // The head was solved from a reply counted under the old model, so it describes a prompt and a tool set
        // that no longer exist. Nothing in the session says the *prompt* moved - only that the model did - which
        // is why the boundary is the caller's to supply and why this declines rather than sizes.
        expect(
            spanBodyTokens(entries, {
                cutId: "u2",
                extraTokens: 0,
                boundary: countBoundary(entries),
            }),
        ).toBeNull();

        // The same branch without a boundary is sized, so the guard is visibly the boundary's doing.
        expect(spanBodyTokens(entries, { cutId: "u2", extraTokens: 0 })).not.toBeNull();
    });
});

describe("the capture that fired the tier live", () => {
    it("is one the arithmetic can be trusted on, and carries real ledger fields", () => {
        const chains = chainRequests(LIVE.records);
        const prefixes = prefixRecords(LIVE.records);
        const attempts = nativeAttempts(LIVE.records);

        expect(LIVE.sessionId).toBe("01a07b63-995e-70c7-b15d-493f69e78243");
        expect(LIVE.foreignRecords.length).toBe(3);
        expect(new Set(chains.map((row) => row.systemChars))).toEqual(new Set([25_975]));
        expect(new Set(chains.map((row) => row.toolsHash)).size).toBe(1);
        expect(new Set(chains.map((row) => row.model))).toEqual(new Set(["qwen3.8-flash"]));
        expect(prefixes.map((record) => record.prefix?.prefixUsable)).toEqual([true, true, true]);
        expect(prefixes.map((record) => record.prefix?.firstMismatchDepth)).toEqual([
            null,
            null,
            null,
        ]);

        expect(attempts.length).toBe(3);
        for (const attempt of attempts) {
            expect(attempt.attempt?.cutFound, `run ${attempt.id}`).toBe(true);
            expect(attempt.attempt?.skippedEntries, `run ${attempt.id}`).toBe(0);
            // The only committed fixture whose trace was written by a build that had the fields, which is what
            // lets the report's ledger output be pinned against a real record instead of a synthetic one.
            expect(attempt.attempt?.ledger, `run ${attempt.id}`).toBeDefined();
        }
        // Two of the three were sized by the tier itself, not merely shadowed by it.
        expect(attempts.map((attempt) => attempt.attempt?.estimateSource)).toEqual([
            "exact-cut",
            "head-ledger",
            "head-ledger",
        ]);
        expect(attempts.map((attempt) => attempt.attempt?.staleAnchors)).toEqual([
            undefined,
            13,
            3,
        ]);
    });

    it("refuses a cancelled reply as an anchor, and solves the head from the count before it", () => {
        const aborted = LIVE_BRANCH.findIndex(
            (entry) =>
                entry.type === "message" &&
                entry.message.role === "assistant" &&
                entry.message.stopReason === "aborted",
        );

        // The user cancelled this turn, so its usage is all zeros: it is not a measurement of a context that
        // still exists, and every count reader in the module refuses it the same way.
        expect(aborted).toBe(133);
        expect(rowPromptTokens(LIVE_BRANCH[aborted] as SessionEntry)).toBeNull();

        const folds = foldPositions(LIVE_BRANCH);
        const second = headAt(LIVE_BRANCH, (folds[1]?.index ?? 0) + 1);
        expect(second?.replyIndex).toBe(130);
        expect(second?.tokens).toBe(11_613);
        expect(second?.replyIndex ?? 0).toBeLessThan(aborted);

        // The third fold wrote the tip and nothing has replied since, so its head is unsolvable - a refusal, not
        // a zero, and the window the persisted-fields rescue exists for.
        expect(headAt(LIVE_BRANCH, LIVE_BRANCH.length)).toBeNull();
    });

    it("derives what each checkpoint costs from the difference of two heads", () => {
        const folds = foldPositions(LIVE_BRANCH);
        const bare = headAt(LIVE_BRANCH, folds[0]?.index ?? LIVE_BRANCH.length);
        const heads = folds.map(({ index }) => headAt(LIVE_BRANCH, index + 1));

        expect(bare?.tokens).toBe(7_634);
        expect(bare?.estimatedTokens).toBe(95);
        // `undefined` and not `null`: the third fold wrote the tip, so it has no head at all.
        expect(heads.map((head) => head?.tokens)).toEqual([8_646, 11_613, undefined]);

        // K, which no row stores: the head after a fold less the bare prefix. Both are differences of provider
        // counts, so the checkpoint's cost in the next body is measured rather than estimated - and it is larger
        // than the stage's own `usage.output`, by exactly the part the harness appends after the model answers
        // (supplementary sections, pi's file lists, pi's `<summary>` wrapper).
        const derived = heads.slice(0, 2).map((head) => (head?.tokens ?? 0) - (bare?.tokens ?? 0));
        const stageOutputs = folds.slice(0, 2).map(({ fold }) => fold.usage?.output ?? 0);
        expect(derived).toEqual([1_012, 3_979]);
        expect(stageOutputs).toEqual([902, 3_740]);
        expect(derived.map((k, i) => k - (stageOutputs[i] ?? 0))).toEqual([110, 239]);
    });

    it("sizes all three stage-1 requests to within a tenth of a percent", () => {
        for (const { fold, index } of foldPositions(LIVE_BRANCH)) {
            const attempt = requireAttemptForFold(LIVE.records, fold);
            const provider = providerPromptTokens(attempt);
            const branchThen = LIVE_BRANCH.slice(0, index);
            const startId = previousFoldWindowStart(branchThen);
            const body = spanBodyTokens(branchThen, {
                windowStartId: startId,
                cutId: attempt.attempt?.chosenFirstKeptEntryId ?? "",
                extraTokens: instructionTokens(startId !== undefined),
                boundary: countBoundary(branchThen),
            });

            expect(provider, `fold ${fold.id}`).not.toBeNull();
            expect(body, `fold ${fold.id}`).not.toBeNull();
            const error = Math.abs((body?.tokens ?? 0) - (provider ?? 0)) / (provider ?? 1);
            // Measured 0.045%, 0.004% and 0.005% against the provider's own count of each request.
            expect(error, `fold ${fold.id}`).toBeLessThan(0.001);
        }
    });

    it("shows what the closing bracket was worth, on the run that needed it", () => {
        const folds = foldPositions(LIVE_BRANCH);
        const last = folds.at(-1);
        expect(last).toBeDefined();

        const attempt = requireAttemptForFold(LIVE.records, last?.fold as Fold);
        const provider = providerPromptTokens(attempt) ?? 0;
        const recorded = attempt.attempt?.ledger;
        const branchThen = LIVE_BRANCH.slice(0, last?.index ?? 0);
        const startId = previousFoldWindowStart(branchThen);
        const body = spanBodyTokens(branchThen, {
            windowStartId: startId,
            cutId: attempt.attempt?.chosenFirstKeptEntryId ?? "",
            extraTokens: instructionTokens(startId !== undefined),
            boundary: countBoundary(branchThen),
        });

        // This fixture's recorded fields were written by the build before the closing bracket existed, so the two
        // numbers in this test are a real before-and-after of one change on one request - not a model of it. The
        // window is six messages long and its cut lands on a reply that consumed two tool results, so the whole
        // trailing stretch was uncounted: 2,077 tokens of chars/4 where a difference of two counts says 1,770.
        expect(recorded?.rowsEstimated).toBe(2_967);
        expect(body?.rows.estimated).toBe(984);
        expect(body?.rows.counted).toBe((recorded?.rowsCounted ?? 0) + 1_770);
        // The over-read was the entire skew: +1.31% recorded, +0.005% now, against the same provider count.
        expect(Math.abs((recorded?.tokens ?? 0) - provider) / provider).toBeGreaterThan(0.013);
        expect(Math.abs((recorded?.tokens ?? 0) - provider) / provider).toBeLessThan(0.014);
        expect(Math.abs((body?.tokens ?? 0) - provider) / provider).toBeLessThan(0.0001);
        // And the share of the number that is chars/4 fell with it, which is what the refusal threshold reads.
        expect((recorded?.estimatedTokens ?? 0) / (recorded?.tokens ?? 1)).toBeGreaterThan(0.24);
        expect((body?.estimatedTokens ?? 0) / (body?.tokens ?? 1)).toBeLessThan(0.15);
        // What is left estimated is the one term no count can reach: an older checkpoint riding inline.
        expect(body?.rows.checkpoints).toBe(890);
    });
});

describe("sizing every candidate boundary in one pass", () => {
    it("agrees with spanBodyTokens at every position of the capture's window", () => {
        // Two routes to one number is the check the cut walk has to be allowed to use it: `spanSizer` answers a
        // prefix from a single walk, `spanBodyTokens` rescans the window per call, and they must agree on the
        // answer *and* on which positions to refuse. The capture arbitrates because its counts are a provider's.
        const windowStartId = previousFoldWindowStart(BRANCH);
        const boundary = countBoundary(BRANCH);
        const sizer = spanSizer(BRANCH, { windowStartId, boundary });
        if (sizer === null) {
            throw new Error(
                "the capture's head is solvable, so a sizer must exist to compare against",
            );
        }

        let answered = 0;
        for (let index = sizer.windowStartIndex; index < BRANCH.length; index += 1) {
            const sized = sizer.spanAt(index);
            const direct = spanBodyTokens(BRANCH, {
                windowStartId,
                cutId: BRANCH[index].id,
                extraTokens: 0,
                boundary,
            });
            const at = `position ${String(index)}`;

            if (!sized.ok) {
                expect(direct, `${at}: ${sized.why}`).toBeNull();
                continue;
            }

            expect(direct, at).not.toBeNull();
            expect(direct?.tokens, at).toBe(sized.body.tokens);
            expect(direct?.estimatedTokens, at).toBe(sized.body.estimatedTokens);
            expect(direct?.rows.counted, at).toBe(sized.body.rows.counted);
            expect(direct?.head.tokens, at).toBe(sized.body.head.tokens);
            answered += 1;
        }

        // A window this sizer refuses everywhere would pass the loop above vacuously, and there is no such
        // position on this capture: the tier answered two of its three runs exactly this way.
        expect(answered).toBeGreaterThan(50);

        // The prefix one past the tip is the live context, which is the number the keep budget compares against:
        // head plus every retained row, with nothing after the tip to close the last bracket.
        expect(sizer.live().tokens).toBe(
            bodyTokens(BRANCH, {
                atIndex: BRANCH.length,
                from: sizer.windowStartIndex,
                to: BRANCH.length,
            })?.tokens,
        );
    });

    it("refuses a candidate below the window rather than inventing a span the builder cannot make", () => {
        const windowStartId = previousFoldWindowStart(BRANCH);
        const sizer = spanSizer(BRANCH, { windowStartId, boundary: countBoundary(BRANCH) });
        if (sizer === null) {
            throw new Error("the capture's head is solvable, so a sizer must exist");
        }

        // `stageOneSpanEntries` builds its window from `previousFoldWindowStart` up to the cut, and
        // `spanBodyTokens` declines `from > to`. A candidate under the window start is therefore not a smaller
        // span: it is a body nobody can assemble, and the sizer has to say so instead of answering.
        expect(sizer.spanAt(sizer.windowStartIndex - 1)).toEqual({
            ok: false,
            why: "outside-window",
        });
        expect(sizer.spanAt(-1)).toEqual({ ok: false, why: "outside-window" });
        // At the window start the span is empty, and what remains is the head alone - the smallest body the
        // walk could choose, and the one position where "the span fits" says nothing about the rows.
        const atStart = sizer.spanAt(sizer.windowStartIndex);
        expect(atStart.ok).toBe(true);
        if (atStart.ok) {
            expect(atStart.body.rows.tokens).toBe(0);
            expect(atStart.body.tokens).toBe(sizer.live().head.tokens);
        }
        // Past the tip is the same refusal by the other end of the range.
        expect(sizer.spanAt(BRANCH.length + 1)).toEqual({ ok: false, why: "outside-window" });
    });
});
