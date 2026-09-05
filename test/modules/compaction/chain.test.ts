import { describe, expect, it } from "vitest";

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

function shape(overrides: Partial<ChainShape> = {}): ChainShape {
    return {
        systemHash: "sys-1",
        toolsHash: "tools-1",
        systemChars: 100,
        toolNames: ["read", "bash"],
        keys: ["messages", "model", "tools"],
        model: "test-model",
        ...overrides,
    };
}

function messages(count: number, tag = "m"): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${tag}${String(index)}`,
    }));
}

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
        ladder: messageLadder(body),
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
            ladder: messageLadder(body),
            pathIds: pathIdSet([{ id: LEAF_A }]),
            shape: shape({ keys: ["messages", "model", "tool_choice", "tools"] }),
        });
        expect(match.parameters).toEqual(["+tool_choice"]);
        expect(match.verifiedTo).toBe(3);
    });

    it("notes a model change without treating it as a message mismatch", () => {
        const body = messages(2);
        const chain = chainWith([LEAF_A, body]);

        const match = matchOf(chain, body, { shape: shape({ model: "other-model" }) });
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
