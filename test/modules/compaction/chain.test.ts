import { describe, expect, it } from "vitest";

import { chainMessages as messages, chainShape as shape } from "../../helpers/compaction-doubles";
import {
    messageLadder,
    pathIdSet,
    RequestChain,
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
        // `tool_choice` is something we add; the reference never sent it. That must not read as divergence.
        const body = messages(3);
        const chain = new RequestChain();
        chain.observe({ leafId: LEAF_A, messages: body, shape: shape() });

        const match = chain.match({
            spanLadder: messageLadder(body),
            pathIds: pathIdSet([{ id: LEAF_A }]),
            shape: shape({ keys: ["messages", "model", "tool_choice", "tools"] }),
        });
        expect(match.parameters).toEqual(["+tool_choice"]);
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
