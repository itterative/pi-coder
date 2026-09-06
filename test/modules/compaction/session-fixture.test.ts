import path from "node:path";

import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../../src/common/constants";
import { messageLadder } from "../../../src/modules/compaction/chain";
import {
    buildSpanSession,
    skippedEntryCount,
    spanContextEntries,
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
