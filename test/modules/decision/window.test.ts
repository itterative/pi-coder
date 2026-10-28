import { describe, expect, it } from "vitest";

import {
    ITEM_CHARS,
    ITEM_MIN,
    allocationText,
    selectWindow,
    TOOL_ITEMS_KEPT,
    WINDOW_CHARS,
    WINDOW_POLICY_CONVERSATION,
    WINDOW_POLICY_PLAN,
    WINDOW_POLICY_REMINDER,
    WINDOW_POLICY_TRANSCRIPT,
    type DecisionRecentMessage,
    type WindowPolicy,
} from "../../../src/modules/decision";

/**
 * The allocator replaces the priority heuristics with an explicit optimization, so the tests pin the
 * properties a heuristic used to provide by construction: the budget holds, the request survives, the
 * per-turn caps hold, and the render is the same shape the existing renderers produce. A policy is data, so
 * the interesting assertions are about a policy's promises rather than about one algorithm.
 */

function item(role: string, text: string, turn: number): DecisionRecentMessage {
    return { role, text, turn };
}

/** A branch of `turns` turns, each with a user request, an assistant answer, and two tool calls. */
function branchOf(turns: number, messageChars = 400): DecisionRecentMessage[] {
    const out: DecisionRecentMessage[] = [];
    for (let turn = 1; turn <= turns; turn += 1) {
        out.push(item("user", `request ${String(turn)} `.repeat(messageChars / 10), turn));
        out.push(item("assistant", `answer ${String(turn)} `.repeat(messageChars / 10), turn));
        out.push(item("tool", `read(src/file${String(turn)}.ts)`, turn));
        out.push(item("command", `npm run test:run -- turn ${String(turn)}`, turn));
    }

    return out;
}

const SHAPES: readonly { name: string; policy: WindowPolicy }[] = [
    { name: "plan", policy: WINDOW_POLICY_PLAN },
    { name: "reminder", policy: WINDOW_POLICY_REMINDER },
    { name: "conversation", policy: WINDOW_POLICY_CONVERSATION },
    { name: "transcript", policy: WINDOW_POLICY_TRANSCRIPT },
];

describe("window policies", () => {
    it("plan carries the tier-2 window's numbers, so the allocator is comparable to planSessionWindow", () => {
        expect(WINDOW_POLICY_PLAN.budget).toBe(WINDOW_CHARS);
        expect(WINDOW_POLICY_PLAN.floors).toEqual({ message: ITEM_MIN, tool: ITEM_MIN });
        expect(WINDOW_POLICY_PLAN.caps).toEqual({ message: ITEM_CHARS, tool: ITEM_CHARS });
        expect(WINDOW_POLICY_PLAN.mustKeep.tools).toBe(TOOL_ITEMS_KEPT);
    });

    it("gives the transcript policy the tier-1 turn span, which bounds the forced markers", () => {
        expect(WINDOW_POLICY_TRANSCRIPT.markers).toBe("forced");
        expect(WINDOW_POLICY_TRANSCRIPT.keepTurns).toBeGreaterThan(0);
    });

    it("drops the state markers for the conversation policy", () => {
        expect(WINDOW_POLICY_CONVERSATION.markers).toBe("drop");
    });

    it("gives the reminder selection the plan policy at the measured budget", () => {
        // One named policy, shared by production and the `turn_shapes.mts` probe, so the two cannot drift: the
        // tier-2 state is this window rendered as a single conversation, and 2000 chars is the size that ranked
        // best against the hindsight oracle at the shipped gate.
        expect(WINDOW_POLICY_REMINDER).toEqual({ ...WINDOW_POLICY_PLAN, budget: 2000 });
    });
});

describe("selectWindow", () => {
    it("never spends past the budget", () => {
        for (const { name, policy } of SHAPES) {
            const selection = selectWindow(branchOf(12), policy);
            expect(selection.chars, name).toBeLessThanOrEqual(policy.budget);
        }
    });

    it("records the text each allocation sends, not the item it came from", () => {
        const selection = selectWindow(branchOf(1), WINDOW_POLICY_REMINDER);

        // A caller recording what the model read needs the clipped text: the item still carries its unclipped
        // length, and the role prefix is not charged to the budget, so the line is that text behind a prefix.
        for (const allocation of selection.kept) {
            const sent = allocationText(allocation);

            expect(sent).toBe(sent.replace(/\s+/gu, " ").trim());
            expect(sent.length).toBeLessThanOrEqual(allocation.chars);
            expect(allocation.line).toContain(sent);
        }
        expect(selection.kept.some((allocation) => allocationText(allocation).endsWith("…"))).toBe(
            true,
        );
    });

    it("keeps the newest request and answer whatever the budget", () => {
        const items = branchOf(12);
        const newestUser = items.findLast((entry) => entry.role === "user");
        const newestAssistant = items.findLast((entry) => entry.role === "assistant");

        for (const { name, policy } of SHAPES) {
            const kept = selectWindow(items, policy).kept.map((entry) => entry.item);
            expect(kept, name).toContainEqual(newestUser);
            expect(kept, name).toContainEqual(newestAssistant);
        }
    });

    it("holds the per-turn message and tool caps", () => {
        for (const { name, policy } of SHAPES) {
            const kept = selectWindow(branchOf(12), policy).kept;
            const byTurn = new Map<number, DecisionRecentMessage[]>();
            for (const entry of kept) {
                const turn = entry.item.turn ?? 0;
                byTurn.set(turn, [...(byTurn.get(turn) ?? []), entry.item]);
            }

            for (const [turn, entries] of byTurn) {
                const tools = entries.filter(
                    (entry) => entry.role === "tool" || entry.role === "command",
                );
                const messages = entries.filter(
                    (entry) => entry.role !== "tool" && entry.role !== "command",
                );
                expect(tools.length, `${name} turn ${String(turn)} tools`).toBeLessThanOrEqual(
                    policy.perTurn.tools,
                );
                expect(
                    messages.length,
                    `${name} turn ${String(turn)} messages`,
                ).toBeLessThanOrEqual(policy.perTurn.messages);
            }
        }
    });

    it("renders the same line shapes the existing renderers produce", () => {
        const selection = selectWindow(
            [
                item("user", "do the thing", 1),
                item("assistant", "on it", 1),
                item("command", "npm test", 1),
                item("tool", "read(src/a.ts)", 1),
            ],
            { ...WINDOW_POLICY_CONVERSATION, markers: "drop" },
        );

        const lines = selection.lines.filter((line) => !line.includes("omitted"));
        expect(lines).toContain("User: do the thing");
        expect(lines).toContain("Assistant: on it");
        expect(lines).toContain("Tool: bash(npm test)");
        expect(lines).toContain("Tool: read(src/a.ts)");
    });

    it("keeps or drops the state markers exactly as the policy asks", () => {
        const items = [
            item("user", "start", 1),
            item("state", "── state: exploring ──", 1),
            item("assistant", "working", 1),
        ];

        const dropped = selectWindow(items, { ...WINDOW_POLICY_CONVERSATION, markers: "drop" });
        expect(dropped.lines.some((line) => line.includes("state: exploring"))).toBe(false);
        expect(dropped.kept.some((entry) => entry.item.role === "state")).toBe(false);

        const forced = selectWindow(items, {
            ...WINDOW_POLICY_CONVERSATION,
            markers: "forced",
            budget: 600,
        });
        expect(forced.lines).toContain("── state: exploring ──");
        const marker = forced.kept.find((entry) => entry.item.role === "state");
        expect(marker?.forced).toBe(true);
        // Never trimmed: a marker is the phase anchor, so it arrives at its full length.
        expect(marker?.chars).toBeGreaterThanOrEqual("── state: exploring ──".length);
    });

    it("does not drown a long branch in forced markers", () => {
        const items: DecisionRecentMessage[] = [];
        for (let turn = 1; turn <= 20; turn += 1) {
            items.push(item("user", `ask ${String(turn)}`, turn));
            items.push(item("state", `── state: exploring ${String(turn)} ──`, turn));
            items.push(item("assistant", `answer ${String(turn)}`, turn));
        }

        const selection = selectWindow(items, { ...WINDOW_POLICY_TRANSCRIPT, budget: 600 });
        expect(selection.chars).toBeLessThanOrEqual(600);
        // Only the turns inside the span contribute a marker, so the oldest ones are gone.
        expect(selection.lines.some((line) => line.includes("exploring 1 ──"))).toBe(false);
    });

    it("is deterministic", () => {
        const items = branchOf(10);
        const first = selectWindow(items, WINDOW_POLICY_PLAN);
        const second = selectWindow(items, WINDOW_POLICY_PLAN);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it("never scores a larger budget worse", () => {
        const items = branchOf(10);
        const small = selectWindow(items, {
            ...WINDOW_POLICY_CONVERSATION,
            budget: 500,
        });
        const large = selectWindow(items, {
            ...WINDOW_POLICY_CONVERSATION,
            budget: 1000,
        });
        expect(large.value).toBeGreaterThanOrEqual(small.value);
    });

    it("reports per-turn chars that add up to what it spent on content", () => {
        const selection = selectWindow(branchOf(8), WINDOW_POLICY_CONVERSATION);
        const fromTurns = selection.turns.reduce((total, turn) => total + turn.chars, 0);
        const markers = selection.kept
            .filter((entry) => entry.item.role === "state")
            .reduce((total, entry) => total + entry.chars, 0);
        expect(selection.chars).toBe(fromTurns + markers);
    });

    it("drops older material before newer material when the budget is tight", () => {
        const items = branchOf(10);
        const selection = selectWindow(items, { ...WINDOW_POLICY_CONVERSATION, budget: 600 });
        const keptTurns = selection.kept.map((entry) => entry.item.turn ?? 0);
        expect(Math.min(...keptTurns)).toBeGreaterThan(1);
    });
});
