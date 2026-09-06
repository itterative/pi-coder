import path from "node:path";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../../src/common/constants";
import {
    countBoundary,
    countSpanTokens,
    estimateAnchoredSpanTokens,
} from "../../../src/modules/compaction/native-request";
import { spanContextEntries } from "../../../src/modules/compaction/span-session";

/**
 * Sizing measured against a real provider's numbers, not against fixtures' claims about them.
 *
 * Every assistant row in `llamacpp-post-compaction.jsonl` carries the usage of the request that produced it, and
 * that request covered the system prompt, the tool definitions and every message before it. So each row is an
 * exact measurement of a body this module knows how to rebuild - which makes the file the only place in this
 * suite where a sizing change can be checked against a tokenizer rather than against our own arithmetic. The
 * synthetic cases in `native-sizing.test.ts` pin which row gets believed; these pin whether believing it is
 * actually right, on 200k-window llama.cpp traffic captured from a live session.
 */
const FIXTURE = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "session",
    "llamacpp-post-compaction.jsonl",
);

const TRACE_FIXTURE = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "compaction-trace.healthy.jsonl",
);

/** The cut point pi chose for the recorded compaction - and the number the provider charged for that body. */
const FIRST_KEPT = "3162e48e";
const RECORDED_SPAN_PROMPT_TOKENS = 32_308;

/** The band `scripts/compaction-report.ts` enforces for an anchored count. */
const ANCHORED_BAND = 0.15;

/** What the provider charged for one request's prompt: the cached and fresh halves of the same body. */
function promptTokens(entry: SessionEntry): number | null {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
        return null;
    }

    const usage = entry.message.usage;
    if (usage === undefined) {
        return null;
    }

    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

    return prompt > 0 ? prompt : null;
}

/** The context through one reply, which is what the anchored tier reads from its anchor. */
function contextTokens(entry: SessionEntry): number | null {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
        return null;
    }

    const usage = entry.message.usage;

    return usage && usage.totalTokens > 0 ? usage.totalTokens : null;
}

/** chars/4 over a row exactly as the session stores it - the retired heuristic, for comparison only. */
function storedTokens(entries: SessionEntry[]): number {
    return entries.reduce((sum, entry) => {
        if (entry.type !== "message") {
            return sum;
        }

        return sum + Math.ceil((JSON.stringify(entry.message) ?? "").length / 4);
    }, 0);
}

/** The span the recorded run read: everything before the cut, sliced the way the module slices it. */
function recordedSpan(entries: SessionEntry[]): SessionEntry[] {
    const cut = spanContextEntries(entries, FIRST_KEPT);
    // `cutFound` is the whole difference between a long span and an uncut one, so a fixture that lost the cut
    // would silently size a body nobody sent.
    expect(cut.cutFound).toBe(true);

    return cut.entries;
}

function branch(): SessionEntry[] {
    return SessionManager.open(FIXTURE).getBranch();
}

/**
 * The branch as the handler saw it: pi appends the `compaction` row after the callback returns, so the fold
 * this session recorded was not yet on the branch while it was being decided.
 */
function branchBeforeTheFold(): { entries: SessionEntry[]; fold: SessionEntry | undefined } {
    const entries = branch();
    const index = entries.findIndex((entry) => entry.type === "compaction");

    return {
        entries: index < 0 ? entries : entries.slice(0, index),
        fold: index < 0 ? undefined : entries[index],
    };
}

describe("real-session span sizing", () => {
    it("sizes the recorded span from a count, because the kept reply measured exactly that body", () => {
        const { entries } = branchBeforeTheFold();
        const kept = entries.find((entry) => entry.id === FIRST_KEPT);

        // pi snapped the cut to an assistant row, which is what makes the count available: mid-turn crossings
        // cannot cut at a toolResult, so the first valid cut point forward is the reply that consumed it.
        expect(kept?.type).toBe("message");
        const counted = countSpanTokens({
            spanEntries: recordedSpan(entries),
            keptEntry: kept,
            boundary: countBoundary(entries),
            extraTokens: 0,
        });

        expect(counted.source).toBe("exact-cut");
        expect(counted.tokens).toBe(RECORDED_SPAN_PROMPT_TOKENS);
        expect(counted.staleAnchors).toBe(0);
    });

    it("a fold later than the kept reply expires that count, on pi's own on-disk shape", () => {
        const { entries, fold } = branchBeforeTheFold();
        const kept = entries.find((entry) => entry.id === FIRST_KEPT);
        expect(fold, "fixture must carry the compaction this session recorded").toBeDefined();

        const full = [...entries, fold as SessionEntry];
        const afterTheFold = countSpanTokens({
            spanEntries: recordedSpan(entries),
            keptEntry: kept,
            boundary: countBoundary(full),
            extraTokens: 0,
        });

        // The reclaim this fold performed is exactly what the count still includes, so believing it here would
        // size the request by a body that no longer exists. Every counted row in the window ages out with it.
        expect(afterTheFold.tokens).toBeNull();
        expect(afterTheFold.source).toBe("none");
        expect(afterTheFold.staleAnchors).toBeGreaterThan(1);
    });

    it("keeps every anchored turn inside the band the report enforces, across 11 real requests", () => {
        const { entries } = branchBeforeTheFold();
        const boundary = countBoundary(entries);
        const counted = entries.filter((entry) => promptTokens(entry) !== null);
        const errors: number[] = [];

        for (const target of counted) {
            const index = entries.indexOf(target);
            const truth = promptTokens(target);
            // Tier 1 is exact by definition, so the interesting measurement is the tier below it: the newest
            // count *inside* the prefix, plus whatever had to be estimated after it.
            const anchored = estimateAnchoredSpanTokens(entries.slice(0, index), 0, boundary);
            if (anchored === null || truth === null) {
                continue;
            }

            errors.push((anchored - truth) / truth);
        }

        // A first reply has no row behind it to anchor on, so the walk starts at the second counted turn.
        expect(errors.length).toBeGreaterThanOrEqual(10);
        const worst = Math.max(...errors.map((error) => Math.abs(error)));
        expect(worst).toBeLessThanOrEqual(ANCHORED_BAND);
        // Tripwire, not a claim about providers: the errors measured here sat under 2%, and a change that
        // pushed them past that has stopped describing this body rather than gotten luckier about it.
        expect(worst).toBeLessThan(0.05);
    });

    it("charges the trailing rows as they are sent, which is what kept that band", () => {
        const { entries } = branchBeforeTheFold();
        const boundary = countBoundary(entries);
        const second = entries.filter((entry) => promptTokens(entry) !== null)[1];
        const index = entries.indexOf(second);
        const prefix = entries.slice(0, index);
        const truth = promptTokens(second) as number;

        // The anchored tier's only guess is what followed its anchor, and this is the turn where that guess was
        // one huge tool result: pi keeps a truncated `read`'s full output a second time under
        // `details.truncation.content`, so sizing the stored row charges that file twice. Reading the wire
        // shape instead is what took this turn from +62% to -0.2% against the provider's own number.
        let anchorIndex = -1;
        for (let i = prefix.length - 1; i >= 0; i -= 1) {
            if (contextTokens(prefix[i]) !== null) {
                anchorIndex = i;
                break;
            }
        }
        expect(anchorIndex).toBeGreaterThan(-1);
        const anchor = contextTokens(prefix[anchorIndex]) as number;
        const tail = prefix.slice(anchorIndex + 1);
        const storedSized = anchor + storedTokens(tail);
        const shipped = estimateAnchoredSpanTokens(prefix, 0, boundary) as number;

        // Same span, same ground truth, one difference: the projection. This is the assertion that fails if
        // `details` finds its way back into what sizing reads.
        expect(Math.abs((storedSized - truth) / truth)).toBeGreaterThan(ANCHORED_BAND);
        expect(Math.abs((shipped - truth) / truth)).toBeLessThanOrEqual(ANCHORED_BAND);
    });

    it("agrees with the trace fixture recorded from the same run", () => {
        const { entries } = branchBeforeTheFold();
        const sized = estimateAnchoredSpanTokens(recordedSpan(entries), 0, countBoundary(entries));

        const native = readFileSync(TRACE_FIXTURE, "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((record) => record.stage === "attempt" && record.strategy === "native");
        expect(native).toBeDefined();
        const usage = native?.usage as { input: number; cacheRead: number; cacheWrite: number };
        const charged = usage.input + usage.cacheRead + usage.cacheWrite;

        // Two independently recorded artifacts of one provider answer: what the live run was charged for the
        // request it sent, against what sizing says that same body costs. The live request carried the
        // instruction as well, so a small under-count is the expected shape of agreement here.
        expect(sized).not.toBeNull();
        expect(Math.abs(((sized as number) - charged) / charged)).toBeLessThanOrEqual(
            ANCHORED_BAND,
        );
    });
});
