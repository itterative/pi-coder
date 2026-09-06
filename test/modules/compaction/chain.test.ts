import { describe, expect, it } from "vitest";

import { chainMessages as messages, chainShape as shape } from "../../helpers/compaction-doubles";
import {
    divergenceLine,
    messageLadder,
    pathIdSet,
    RequestChain,
    sampleMessages,
    shapeKey,
    type ChainShape,
} from "../../../src/modules/compaction/chain";

/**
 * The chain is the only thing standing between "our rebuild matched" and "we could not tell", so these cases
 * are about what a verdict is allowed to claim: matched at which depth, on which branch, under which shape.
 */

const LEAF_A = "leaf-a";
const LEAF_B = "leaf-b";

function chainWith(...observations: [string, unknown[]][]): RequestChain {
    const chain = new RequestChain();
    for (const [leafId, body] of observations) {
        chain.observe({ leafId, messages: body, shape: shape() });
    }

    return chain;
}

function matchOf(
    chain: RequestChain,
    body: unknown[],
    options: { path?: string[]; shape?: ChainShape } = {},
) {
    return chain.match({
        // Mirrors the production caller: the last message is the instruction we append, which no reference
        // ever sent, so it is outside the span being verified.
        spanLadder: messageLadder(body.slice(0, -1)),
        pathIds: pathIdSet((options.path ?? [LEAF_A]).map((id) => ({ id }))),
        shape: options.shape ?? shape(),
    });
}

describe("request chain", () => {
    it("folds a head that depends on every message before it", () => {
        const ladder = messageLadder(messages(4));
        expect(ladder.size).toBe(4);
        expect(new Set(ladder.values()).size).toBe(4);
        expect(ladder.get(1)).not.toBe(ladder.get(4));

        // Changing the third message leaves depths 1 and 2 alone and changes everything after.
        const changed = messages(4);
        changed[2] = { role: "user", content: "different" };
        const other = messageLadder(changed);
        expect(other.get(1)).toBe(ladder.get(1));
        expect(other.get(2)).toBe(ladder.get(2));
        expect(other.get(3)).not.toBe(ladder.get(3));
        expect(other.get(4)).not.toBe(ladder.get(4));
    });

    it("does not confuse message boundaries", () => {
        // Without a separator in the fold these two bodies would hash alike.
        const split = messageLadder([{ text: "ab" }, { text: "c" }]);
        const merged = messageLadder([{ text: "abc" }]);
        expect(split.get(2)).not.toBe(merged.get(1));
    });

    it("verifies a rebuild that matches at the reference's depth", () => {
        const body = messages(5);
        const chain = chainWith([LEAF_A, body]);

        const match = matchOf(chain, [...body, { role: "user", content: "instruction" }]);
        expect(match.reference).toBe("chain");
        expect(match.verifiedTo).toBe(5);
        expect(match.referenceDepth).toBe(5);
        expect(match.firstMismatchDepth).toBeNull();
        expect(match.parameters).toEqual([]);
    });

    it("names the exact depth where the rebuild stopped matching", () => {
        // pi sent these on three requests, so depths 2, 3 and 4 each carry a reference head.
        const base = messages(4);
        const chain = chainWith(
            [LEAF_A, base.slice(0, 2)],
            [LEAF_A, base.slice(0, 3)],
            [LEAF_A, base],
        );

        const drifted = base
            .slice(0, 3)
            .map((message, index) =>
                index === 2 ? { role: "assistant", content: "rewritten" } : message,
            );
        const match = matchOf(chain, [...drifted, { role: "user", content: base[3] }]);

        expect(match.verifiedTo).toBe(2);
        expect(match.firstMismatchDepth).toBe(3);
    });

    it("credits one reference and counts the others where they disagreed", () => {
        // The shape a live record showed: a stale ladder left from before an earlier compaction is still on the
        // branch and still the same shape, so it disagrees at a shallow depth while the live prefix agrees all
        // the way through. Merging across references printed `verified 728/728` beside `messages[59]` - two
        // measurements under one label.
        const base = messages(6);
        const chain = new RequestChain();

        chain.restore({
            observations: [],
            ladders: [
                {
                    leafId: LEAF_A,
                    heads: messageLadder([
                        ...base.slice(0, 2),
                        { role: "user", content: "pre-summary text" },
                    ]),
                    shapeKey: shapeKey(shape()),
                },
            ],
        });
        // One live request, so the restored ladder is still inside the retention window and still able to
        // disagree - which is exactly the state a session reaches right after a reload.
        chain.observe({ leafId: LEAF_A, messages: base, shape: shape() });

        const match = matchOf(chain, [...base, { role: "user", content: "instruction" }]);

        expect(match.verifiedTo).toBe(6);
        expect(match.comparableDepth).toBe(6);
        // The credited reference agreed throughout, so no divergence may be printed from the other one.
        expect(match.firstMismatchDepth).toBeNull();
        expect(match.disagreeingReferences).toBe(1);
        expect(match.referenceSource).toBe("observation");
    });

    it("credits a retained ladder when the span is shorter than every request pi sent", () => {
        const base = messages(8);
        const chain = chainWith([LEAF_A, base]);

        const match = matchOf(chain, [
            ...base.slice(0, 3),
            { role: "user", content: "instruction" },
        ]);

        expect(match.verifiedTo).toBe(3);
        expect(match.comparableDepth).toBe(3);
        // Named, because "verified 3/3" from a ladder is evidence about the request that ladder came from, and
        // the reader should be able to tell that from a request pi actually sent at depth 3.
        expect(match.referenceSource).toBe("ladder");
        expect(match.referenceLeafId).toBe(LEAF_A);
    });

    it("still answers when the span is shorter than every request pi sent", () => {
        // The first llama.cpp run after the chain shipped: ten observations at depths 70-87, a span truncated
        // to 64 messages, and a verdict that read the mismatch as the prefix being unusable.
        const full = messages(87);
        const chain = new RequestChain();
        chain.observe({ leafId: LEAF_A, messages: full, shape: shape() });

        const span = [...full.slice(0, 63), { role: "user", content: "summarize this" }];
        const match = matchOf(chain, span);

        expect(match.reference).toBe("chain");
        expect(match.comparableDepth).toBe(63);
        expect(match.verifiedTo).toBe(63);
        expect(match.firstMismatchDepth).toBeNull();
        // pi's own request went deeper than the span, which is truncation working as designed.
        expect(match.referenceDepth).toBe(87);
    });

    it("localizes the exact message where a truncated span stops matching", () => {
        const full = messages(87);
        const chain = new RequestChain();
        chain.observe({ leafId: LEAF_A, messages: full, shape: shape() });

        const span = full.slice(0, 63);
        span[40] = { role: "assistant", content: "rewritten in our rebuild" };
        const match = matchOf(chain, [...span, { role: "user", content: "summarize this" }]);

        // Message index 40 is folded into head(41), so everything up to 40 still agrees.
        expect(match.verifiedTo).toBe(40);
        expect(match.comparableDepth).toBe(63);
        expect(match.firstMismatchDepth).toBe(41);
    });

    it("keeps a depth-0 observation a reference that says nothing rather than an absent one", () => {
        // `reference: "none"` has exactly one cause: nothing on the branch. A request that carried no messages
        // still happened, so collapsing the two would make the report's `none-with-branch` invariant fire on
        // honest data - and would hide the difference between "nothing to compare" and "nothing to learn".
        const chain = new RequestChain();
        chain.observe({ leafId: LEAF_A, messages: [], shape: shape() });

        const verdict = chain.match({
            spanLadder: messageLadder(messages(3)),
            pathIds: pathIdSet([{ id: LEAF_A }]),
            shape: shape(),
        });

        expect(verdict.reference).toBe("chain");
        expect(verdict.comparableDepth).toBe(-1);
        expect(verdict.verifiedTo).toBe(-1);
        expect(chain.branchObservations(pathIdSet([{ id: LEAF_A }]))).toHaveLength(1);
    });

    it("refuses to compare a retained ladder built under a different shape", () => {
        const full = messages(20);
        const chain = new RequestChain();
        chain.observe({ leafId: LEAF_A, messages: full, shape: shape() });

        const match = matchOf(chain, [...full, { role: "user", content: "instruction" }], {
            shape: shape({ toolsHash: "tools-2" }),
        });
        expect(match.compared).toBe(0);
        expect(match.comparableDepth).toBe(-1);
    });

    it("ignores a reference taken on a branch that is no longer the current one", () => {
        const body = messages(6);
        const chain = chainWith([LEAF_B, body]);

        const match = matchOf(chain, body, { path: [LEAF_A] });
        expect(match.reference).toBe("none");
        // The old code turned this exact situation into a confident "unusable prefix" reading.
        expect(match.verifiedTo).toBe(-1);
        expect(match.referenceDepth).toBe(-1);
        expect(match.firstMismatchDepth).toBeNull();
    });

    it("keeps the on-branch reference when a sibling branch also has one", () => {
        const shared = messages(3);
        const other = [...shared, ...messages(2, "other")];
        const chain = chainWith([LEAF_B, other], [LEAF_A, shared]);

        const match = matchOf(chain, [...shared, { role: "user", content: "instruction" }], {
            path: [LEAF_A, "root"],
        });
        expect(match.verifiedTo).toBe(3);
        expect(match.referenceDepth).toBe(3);
        expect(match.referenceLeafId).toBe(LEAF_A);
    });

    it("compares nothing when the system prompt no longer matches any request on the branch", () => {
        const body = messages(4);
        const chain = chainWith([LEAF_A, body]);

        const match = matchOf(chain, body, {
            shape: shape({ systemHash: "sys-2", systemChars: 4000 }),
        });
        expect(match.reference).toBe("chain");
        expect(match.compared).toBe(0);
        expect(match.verifiedTo).toBe(-1);
    });

    it("reports body keys as parameters rather than a verdict", () => {
        // A sampling parameter one side added and the other did not is a parameter, not a prefix divergence.
        const body = messages(3);
        const chain = new RequestChain();
        chain.observe({ leafId: LEAF_A, messages: body, shape: shape() });

        const match = chain.match({
            spanLadder: messageLadder(body),
            pathIds: pathIdSet([{ id: LEAF_A }]),
            shape: shape({ keys: ["messages", "model", "presence_penalty", "tools"] }),
        });
        expect(match.parameters).toEqual(["+presence_penalty"]);
        expect(match.verifiedTo).toBe(3);
    });

    it("notes a model change without treating it as a message mismatch", () => {
        const body = messages(2);
        const chain = chainWith([LEAF_A, body]);

        const match = matchOf(chain, [...body, { role: "user", content: "instruction" }], {
            shape: shape({ model: "other-model" }),
        });
        expect(match.modelDivergence).toBe("test-model -> other-model");
        expect(match.verifiedTo).toBe(2);
    });

    it("returns an empty verdict for a session it has never observed", () => {
        const chain = new RequestChain();
        const match = matchOf(chain, messages(3));

        expect(match.reference).toBe("none");
        expect(match.compared).toBe(0);
        expect(match.truncatedHistory).toBe(false);
    });
});

describe("body samples", () => {
    it("retains a sample for requests deeper than the ladder ring reaches", () => {
        const bodies = Array.from({ length: 12 }, (_, index) =>
            messages(4, `b${String(index)}`),
        ) as [string, unknown[]][];
        const chain = chainWith(
            ...bodies.map((body, index) => [`leaf-${String(index)}`, body] as [string, unknown[]]),
        );

        // Heads are kept for the newest couple of requests, but a credited reference can be much older, and a
        // divergence against it is exactly the case that needs the body. Far apart by design: if sample retention
        // were ever tied back to the ladder ring, this is the test that says so.
        expect(chain.sampleFor("leaf-0")).not.toBeNull();
        expect(chain.sampledRequests).toBe(12);
    });

    it("answers null for a leaf this process never observed", () => {
        const chain = chainWith([LEAF_A, messages(3)]);

        expect(chain.sampleFor("leaf-unknown")).toBeNull();
        expect(chain.sampleFor(null)).toBeNull();
    });

    it("hashes a sampled message with the same form the ladder folds", () => {
        const body = messages(3);
        const retained = chainWith([LEAF_A, body]).sampleFor(LEAF_A) ?? [];
        const fresh = sampleMessages(body);

        expect(retained.map((entry) => entry.index)).toEqual(fresh.map((entry) => entry.index));
        expect(retained[1]?.hash).toBe(fresh[1]?.hash);

        // The head is cumulative, so only a per-message hash can point at one message: identical bodies agree,
        // one edited message disagrees at its own index and nowhere else.
        const edited = sampleMessages([
            { role: "user", content: "m0" },
            { role: "assistant", content: "changed" },
        ]);
        expect(edited[0]?.hash).toBe(fresh[0]?.hash);
        expect(edited[1]?.hash).not.toBe(fresh[1]?.hash);
    });

    it("records a long message's size without retaining it whole", () => {
        const [only] = sampleMessages([{ role: "user", content: "x".repeat(20_000) }]);

        expect(only?.chars).toBeGreaterThan(19_000);
        expect(only?.excerpt.length).toBeLessThan(only?.chars ?? 0);
    });

    it("names both sides of a divergence, or says the reference was never tracked", () => {
        const ours = sampleMessages(messages(3));
        const theirs = sampleMessages(messages(3, "other"));

        expect(divergenceLine(2, ours, theirs)).toContain("at messages[2]");
        expect(divergenceLine(2, ours, theirs)).toContain("pi=assistant");
        expect(divergenceLine(2, ours, null)).toContain("pi=untracked");
        // Past the sampled head there is nothing to name, and the depth alone stays the whole record.
        expect(divergenceLine(9, ours, theirs)).toBeNull();
    });
});
