import path from "node:path";

import { SessionManager, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { PI_CODER_EXTENSION_DIR } from "../../../src/common/constants";
import { countBoundary, countSpanTokens } from "../../../src/modules/compaction/native-request";
import { spanContextEntries } from "../../../src/modules/compaction/span-session";

/**
 * The cut-point shapes, stated case by case.
 *
 * A cut is a claim about two things at once: what the summary has to cover, and what the retained tail has to be
 * able to say without the prefix it lost. Those are different failures - one costs summary quality, the other
 * puts a `tool_call_id` on the wire with no call behind it, which a provider refuses outright - and today this
 * module inherits both from pi without asserting either. So each shape gets its own case naming the row before
 * the cut, the row after it, whether any call id in the tail resolves, and which sizing tier the module can use.
 *
 * Cuts are located by shape rather than by index: the recorded session's *branch order* is its parent chain,
 * which is not the order the lines were written in, and a test that hard-coded positions found the wrong rows
 * while still passing arithmetic. The random and exhaustive version of this file is
 * `cut-invariants.test.ts`; this one is the readable catalogue.
 */
const FIXTURE = path.join(
    PI_CODER_EXTENSION_DIR,
    "test",
    "fixtures",
    "session",
    "llamacpp-post-compaction.jsonl",
);

interface Census {
    /** `custom` for the metadata rows pi interleaves inside a turn. */
    beforeRole: string;
    afterRole: string;
    /** Tool results in the tail whose call the summary swallowed. */
    danglingCallIds: string[];
    source: string;
    tokens: number | null;
    /** The kept row's own provider count, when it has one: what `exact-cut` must equal, never approximate. */
    keptPromptTokens: number | null;
    /** The newest reply inside the span, whose `totalTokens` covers the body through its own answer. */
    anchorTotalTokens: number;
}

/** The branch as a handler would see it: pi appends the `compaction` row after the callback returns. */
function liveBranch(): SessionEntry[] {
    const entries = SessionManager.open(FIXTURE).getBranch();
    const fold = entries.findIndex((entry) => entry.type === "compaction");

    return fold < 0 ? entries : entries.slice(0, fold);
}

function roleOf(entry: SessionEntry | undefined): string {
    if (entry === undefined) {
        return "<none>";
    }

    return entry.type === "message" ? entry.message.role : entry.type;
}

/** What the provider counted for one row's prompt, or null when the row is not a counted reply. */
function keptPrompt(entry: SessionEntry): number | null {
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

/** Resolve a tail through the same machinery the span uses, then look for calls it can no longer see. */
function danglingIn(entries: SessionEntry[]): string[] {
    const messages = convertToLlm(
        entries.flatMap((entry) => (entry.type === "message" ? [entry.message as never] : [])),
    );
    const made = new Set<string>();
    for (const message of messages) {
        if (message.role !== "assistant") {
            continue;
        }
        for (const block of message.content) {
            if (block.type === "toolCall") {
                made.add(block.id);
            }
        }
    }

    const unresolved: string[] = [];
    for (const message of messages) {
        if (message.role === "toolResult" && !made.has(message.toolCallId)) {
            unresolved.push(message.toolCallId);
        }
    }

    return unresolved;
}

function censusAt(entries: SessionEntry[], cutIndex: number): Census {
    const kept = entries[cutIndex];
    const cut = spanContextEntries(entries.slice(0, cutIndex + 1), kept.id);
    const counted = countSpanTokens({
        spanEntries: cut.entries,
        keptEntry: kept,
        boundary: countBoundary(entries),
        extraTokens: 0,
    });

    return {
        beforeRole: roleOf(entries[cutIndex - 1]),
        afterRole: roleOf(kept),
        danglingCallIds: danglingIn(entries.slice(cutIndex)),
        source: counted.source,
        tokens: counted.tokens,
        keptPromptTokens: keptPrompt(kept),
        anchorTotalTokens: newestTotal(cut.entries),
    };
}

/** The newest usable `totalTokens` in a span, which is what an exact-anchor number has to equal. */
function newestTotal(entries: SessionEntry[]): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }
        const total = entry.message.usage?.totalTokens ?? 0;
        if (total > 0) {
            return total;
        }
    }

    return 0;
}

/** The first cut in the recorded session with this pair of roles, or a failure naming what was looked for. */
function realCutWith(before: string[], after: string): Census {
    const entries = liveBranch();
    for (let i = 1; i < entries.length; i += 1) {
        if (after === roleOf(entries[i]) && before.includes(roleOf(entries[i - 1]))) {
            return censusAt(entries, i);
        }
    }

    throw new Error(
        `no recorded cut with [${before.join("|")}] | [${after}]; branch roles were ${JSON.stringify(
            entries.map((entry) => roleOf(entry)),
        )}`,
    );
}

describe("cut point shapes", () => {
    it("(a) [assistant] | [user]: a whole-turn boundary - nothing dangles, and the count is the body", () => {
        const census = realCutWith(["assistant"], "user");

        expect(census.beforeRole).toBe("assistant");
        expect(census.afterRole).toBe("user");
        expect(census.danglingCallIds).toEqual([]);
        // A user row carries no usage, so the *cut point* offers no count - but the reply before it counted the
        // context through its own answer, which is this span exactly. So the number is still a measurement, and
        // says so: the tier with an empty tail is its own source, which is what this label was added for.
        expect(census.source).toBe("exact-anchor");
        expect(census.tokens).toBe(census.anchorTotalTokens);
    });

    it("(b) [.. tool result] | [assistant]: the split a provider already measured, so the size is a count", () => {
        const census = realCutWith(["toolResult"], "assistant");

        expect(census.afterRole).toBe("assistant");
        expect(census.danglingCallIds).toEqual([]);
        expect(census.source).toBe("exact-cut");
        // The claim that makes this tier worth having: the number *is* the provider's count of this body, not
        // an estimate of it. Equality, not a band.
        expect(census.tokens).toBe(census.keptPromptTokens);
    });

    it("(e) [user] | [assistant]: wire-valid and countable, and it still separates a question from its answer", () => {
        const census = realCutWith(["user"], "assistant");

        expect(census.beforeRole).toBe("user");
        expect(census.afterRole).toBe("assistant");
        expect(census.danglingCallIds).toEqual([]);
        expect(census.source).toBe("exact-cut");
        expect(census.tokens).toBe(census.keptPromptTokens);
    });

    it("tells (b) and (e) apart only by the row before the cut, which is why both are catalogued", () => {
        // Same tier, same clean tail, opposite consequences: (b) swallows a tool cycle whose answer survives,
        // (e) swallows the prompt whose answer survives. pi cannot make this distinction - both are
        // assistant-at-the-cut with `isSplitTurn` (`compaction.js:345-350`) - so a rule stated only as "cut at
        // an assistant" admits both, and excluding (e) has to be a separate predicate naming the row before it.
        const split = realCutWith(["toolResult"], "assistant");
        const orphaned = realCutWith(["user"], "assistant");

        expect(split.source).toBe(orphaned.source);
        expect(split.danglingCallIds).toEqual(orphaned.danglingCallIds);
        expect(split.beforeRole).toBe("toolResult");
        expect(orphaned.beforeRole).toBe("user");
    });

    it("never cuts mid-cycle in the recorded session: every real cut leaves a tail that resolves", () => {
        const entries = liveBranch();

        // The invariant the two valid shapes lean on, checked at every position rather than at the one pi chose.
        // A `toolResult` at the head of a tail means its call went into the summary, and that is a request a
        // provider rejects, not a summary that reads a little worse.
        for (let i = 1; i < entries.length; i += 1) {
            if (roleOf(entries[i]) !== "assistant") {
                continue;
            }

            expect(danglingIn(entries.slice(i)), `cut at ${entries[i].id}`).toEqual([]);
        }
    });
});
