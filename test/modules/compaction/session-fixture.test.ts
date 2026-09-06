import path from "node:path";

import {
    buildContextEntries,
    buildSessionContext,
    convertToLlm,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../../src/common/constants";
import { messageLadder } from "../../../src/modules/compaction/chain";
import {
    buildSpanSession,
    previousFoldWindowStart,
    skippedEntryCount,
    spanContextEntries,
    stageOneSpanEntries,
} from "../../../src/modules/compaction/span-session";

/**
 * A real llama.cpp session.
 *
 * It exists because every other compaction test builds its branch out of `compaction-doubles.ts`, which is our
 * model of what pi writes. A hand-built branch cannot disagree with a hand-built branch, so this file is the
 * only thing here that can notice pi's real on-disk shape moving.
 *
 * Captured 2026-09-06 from a fresh session on the local llama.cpp server. Provider names are normalized to
 * `llamacpp` in both fixtures, as they were in the pair these replaced: the alias a given machine's provider
 * config happens to use is not a fact about pi's on-disk shape, and pinning it would tie a golden value to one
 * person's config file. Everything else is raw - real entry ids, real timestamps, real message text.
 */
const FIXTURE = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "session",
    "llamacpp-post-compaction.jsonl",
);

/** The trace fixture is the same run's verdict, so the two artifacts must agree with each other. */
const TRACE_FIXTURE = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "compaction-trace.healthy.jsonl",
);

/** Ids as pi wrote them: short entry ids, the compaction that ran, and the retained-tail boundary it chose. */
const FIRST_KEPT = "3162e48e";

/**
 * Strip the fields a provider never sees.
 *
 * `buildSpanSession` re-appends each entry into an in-memory manager, and pi stamps a `custom_message` entry
 * with `Date.now()` as it goes - so a rebuilt Context carries a fresh timestamp that the stored entry never
 * had. The wire format drops it, which is why this run still verified its whole 18-message span, but hashing
 * the Context objects directly would make any golden value vary between runs. An adapter that forwarded unknown
 * fields would turn this same difference into a prefix break, so the projection is named rather than hidden.
 */
function requestShaped(messages: unknown[]): { role: string; content: unknown }[] {
    return (messages as { role?: string; content?: unknown }[]).map((message) => ({
        role: message.role ?? "?",
        content: message.content,
    }));
}

function replay() {
    const manager = SessionManager.open(FIXTURE);
    // Stage 1 saw the raw branch up to the cut point. `buildContextEntries()` answers with pi's own
    // post-compaction view, which has already folded that history into a summary, so a faithful replay of a
    // recorded compaction has to slice the tree rather than the resolved context.
    const branch = manager.getBranch();
    const cut = spanContextEntries(branch, FIRST_KEPT);
    const span = buildSpanSession(cut.entries, manager.getCwd());
    const messages = convertToLlm(span.sessionManager.buildSessionContext().messages);
    const ladder = messageLadder(requestShaped(messages));

    return { manager, branch, cut, span, messages, head: ladder.get(ladder.size) ?? "" };
}

function traceAttempt(strategy: string): Record<string, unknown> {
    const line = readFileSync(TRACE_FIXTURE, "utf8")
        .split("\n")
        .filter((text) => text.trim() !== "")
        .map((text) => JSON.parse(text) as { stage: string; strategy?: string; attempt?: unknown })
        .find((record) => record.stage === "attempt" && record.strategy === strategy);

    expect(line?.attempt, `no ${strategy} attempt record in the trace fixture`).toBeDefined();

    return line?.attempt as Record<string, unknown>;
}

/**
 * The third fold of a real hosted session - the case that broke stage 1's prefix cache.
 *
 * Two earlier summaries are inside this span window, and pi's resolved context orders them in a way that is
 * neither file order nor newest-first: the newest is hoisted to the front and the older one rides along inline.
 * Copying that already-hoisted list into a fresh session hoists a second time and promotes the *older* summary,
 * so the body stopped being a prefix of what the provider had cached at exactly its second message - the
 * `first=messages[2]` the recorded trace carries, reproduced here rather than inferred from it.
 */
const HOSTED = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "session",
    "hosted-three-folds.jsonl",
);
/** Fold three's retained-tail boundary, fold two's own entry, and fold two's boundary. */
const HOSTED_CUT = "934f4af4";
const HOSTED_NEWER_SUMMARY = "bfbcc08f";
const HOSTED_WINDOW_START = "883585c1";

function wireKey(messages: unknown[]): string[] {
    return requestShaped(messages).map((message) => JSON.stringify(message));
}

function summaryIndices(messages: unknown[]): number[] {
    return (messages as { content?: unknown }[]).flatMap((message, index) =>
        JSON.stringify(message.content).includes("compacted into the following summary")
            ? [index]
            : [],
    );
}

/**
 * Whether stage 1's messages appear in pi's live body in the same order.
 *
 * Order is the whole defect, and an index comparison would blame a benign difference: a `model_change` entry
 * carries no message, so the two lists are not the same length. A cursor answers the question that matters -
 * is this body drawn from that one, without shuffling.
 */
function orderAlignment(ours: unknown[], live: unknown[]): { ok: boolean; detail: string } {
    const ourKeys = wireKey(ours);
    const liveKeys = wireKey(live);
    let cursor = 0;
    for (const [index, key] of ourKeys.entries()) {
        const found = liveKeys.slice(cursor).indexOf(key);
        if (found < 0) {
            return {
                ok: false,
                detail: `ours[${String(index)}] not found at or after live[${String(cursor)}]`,
            };
        }
        cursor += found + 1;
    }

    return { ok: true, detail: `${String(ourKeys.length)} messages in live order` };
}

/** The entry fold three *wrote*, which did not exist while its stage-1 request was in flight. */
const HOSTED_RESULT = "d2c7b72e";

function foldThreeReplay() {
    const manager = SessionManager.open(HOSTED);
    const branch = manager.getBranch();
    const cutIndex = branch.findIndex((entry) => entry.id === HOSTED_CUT);
    // The branch as it stood when stage 1 ran: the retained-tail boundary is present (the slice needs to find it),
    // and the compaction this fold produced is not.
    const atRequest = branch.slice(
        0,
        branch.findIndex((entry) => entry.id === HOSTED_RESULT),
    );
    const leafId = String(atRequest[atRequest.length - 1].id);

    // pi's own live body at that leaf: the same entries, resolved once.
    const live = convertToLlm(buildSessionContext(atRequest, leafId).messages);

    // The same function production calls, window and all.
    const span = stageOneSpanEntries(atRequest, HOSTED_CUT);
    const windowStart = previousFoldWindowStart(atRequest);
    const built = buildSpanSession(span.entries, manager.getCwd());
    const ours = convertToLlm(built.sessionManager.buildSessionContext().messages);

    // The source this replaces: pi's already-hoisted resolved view, sliced at the cut and copied into a fresh
    // session, which hoists a second time. Built here so the fix has a counterfactual to be measured against.
    const resolvedSpan = spanContextEntries(buildContextEntries(atRequest, leafId), HOSTED_CUT);
    const unwindowed = spanContextEntries(atRequest, HOSTED_CUT);
    const resolvedBuilt = buildSpanSession(resolvedSpan.entries, manager.getCwd());
    const shuffled = convertToLlm(resolvedBuilt.sessionManager.buildSessionContext().messages);

    return {
        atRequest,
        branch,
        cutIndex,
        live,
        ours,
        shuffled,
        span,
        unwindowed,
        windowStart,
    };
}

describe("hosted three-fold fixture", () => {
    it("pairs the window with core's boundaryStart: the previous fold's first kept entry", () => {
        const { cutIndex, span, windowStart } = foldThreeReplay();

        expect(cutIndex).toBeGreaterThan(0);
        expect(windowStart).toBe(HOSTED_WINDOW_START);
        expect(span.cutFound).toBe(true);
    });

    it("keeps every summary pi's live body carries, and none it dropped", () => {
        const { live, ours } = foldThreeReplay();

        expect(summaryIndices(ours)).toHaveLength(2);
        expect(summaryIndices(live)).toHaveLength(2);
    });

    it("sends stage 1's body in the order the provider already read it", () => {
        const { live, ours } = foldThreeReplay();
        const alignment = orderAlignment(ours, live);

        expect(alignment.detail).toContain("in live order");
        expect(alignment.ok).toBe(true);

        // The specific shuffle: newest summary first, older one later, never the reverse.
        const oursSummaries = summaryIndices(ours);
        const liveSummaries = summaryIndices(live);
        expect(oursSummaries[0]).toBe(liveSummaries[0]);
        expect(oursSummaries[1]).toBeGreaterThan(oursSummaries[0] ?? 0);
    });

    it("is the difference between a prefix and a shuffle, measured against the old source", () => {
        const { live, ours, shuffled, span, unwindowed } = foldThreeReplay();

        expect(orderAlignment(ours, live).ok).toBe(true);
        // The witness: the same entries, taken from the resolved view, come out in an order pi never sent.
        expect(orderAlignment(shuffled, live).ok).toBe(false);
        // They lead with the *older* summary - a summary sits at index 0 either way, which is why position alone
        // says nothing and identity does.
        expect(wireKey(shuffled)[0]).not.toBe(wireKey(live)[0]);
        expect(wireKey(ours)[0]).toBe(wireKey(live)[0]);
        // And the window is load-bearing on its own, not just the ordering: without it the span reaches past the
        // last fold into text no provider ever cached.
        expect(unwindowed.entries.length).toBeGreaterThan(span.entries.length);
    });

    it("reads the window the way core walks it, oldest entry first", () => {
        const { branch, span } = foldThreeReplay();
        const summaries = span.entries.filter((entry) => entry.type === "compaction");

        // File order in, hoisted order out: the copy hands pi's builder chronological input, which is the only
        // way its single hoist lands the newest summary at the front.
        expect(summaries.map((entry) => entry.id)).toEqual(["15efdff2", HOSTED_NEWER_SUMMARY]);
        expect(branch.length).toBeGreaterThan(0);
        expect(span.cutFound).toBe(true);
    });
});

describe("recorded session fixture", () => {
    it("opens through pi's own loader and keeps its shape", () => {
        const manager = SessionManager.open(FIXTURE);
        const branch = manager.getBranch();

        expect(branch).toHaveLength(51);
        const compactions = branch.filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(1);
        expect(branch.some((entry) => entry.id === FIRST_KEPT)).toBe(true);

        // The mix pi actually wrote, which no hand-built branch in this suite covers. Pinned exactly rather than
        // as thresholds: this fixture is a snapshot of a real session, and a number moving means the shape moved.
        const kinds = new Map(branch.map((entry) => [entry.type, 0]));
        for (const entry of branch) {
            kinds.set(entry.type, (kinds.get(entry.type) ?? 0) + 1);
        }
        expect(kinds.get("message")).toBe(30);
        expect(kinds.get("custom")).toBe(17);
        expect(kinds.has("custom_message")).toBe(true);
        expect(kinds.has("model_change")).toBe(true);
        expect(kinds.has("thinking_level_change")).toBe(true);
    });

    it("rebuilds the exact span the live run sent", () => {
        const replayed = replay();

        expect(replayed.cut.cutFound).toBe(true);
        expect(replayed.cut.entries).toHaveLength(28);
        expect(replayed.span.copiedEntries).toBe(28);
        // Nothing may be silently unrepresentable: a skipped entry narrows stage 1 without anyone noticing.
        expect(skippedEntryCount(replayed.span.skippedEntries)).toBe(0);
        expect(replayed.messages).toHaveLength(17);
        expect(replayed.messages.map((message) => message.role)).toEqual([
            "user",
            "user",
            "assistant",
            "toolResult",
            "toolResult",
            "assistant",
            "toolResult",
            "toolResult",
            "assistant",
            "toolResult",
            "assistant",
            "user",
            "assistant",
            "toolResult",
            "assistant",
            "toolResult",
            "toolResult",
        ]);

        // Tripwire for the rebuild itself: any change to span slicing, entry copying, or message conversion
        // moves this head, and the input is a real session rather than a model of one.
        expect(replayed.head).toBe("2d54d1ca019d4841");
    });

    it("agrees with the trace fixture from the same run", () => {
        const native = traceAttempt("native");
        const replayed = replay();

        expect(native.messageCount).toBe(replayed.messages.length);
        expect(native.copiedEntries).toBe(replayed.span.copiedEntries);
        expect(native.provider).toBe("llamacpp");
    });
});
