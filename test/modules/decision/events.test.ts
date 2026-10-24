import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
    DECISION_STATE_EVENT,
    DECISION_STATUS_EVENT,
    emitDecisionState,
    emitDecisionStatus,
    isDecisionStateEvent,
    isDecisionStatusEvent,
    withDecisionCheck,
} from "../../../src/modules/decision/events";

/**
 * The two decision channels: the in-flight count every consult shares, and the judged state the footer
 * renders. The count is a process-wide number, so these cases are about who may move it and how it comes back
 * down rather than about any one subject's answers.
 */

/** Every count emitted on the bus, in order. */
function counters(events: EventBus): number[] {
    const seen: number[] = [];
    events.on(DECISION_STATUS_EVENT, (data) => {
        if (isDecisionStatusEvent(data)) {
            seen.push(data.checking);
        }
    });

    return seen;
}

describe("withDecisionCheck", () => {
    it("counts one consult up and back down to idle", async () => {
        const events = createEventBus();
        const seen = counters(events);

        const result = await withDecisionCheck(events, async () => "answered");

        expect(result).toBe("answered");
        expect(seen).toEqual([1, 0]);
    });

    it("counts overlapping consults rather than overwriting one another", async () => {
        const events = createEventBus();
        const seen = counters(events);

        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        const outer = withDecisionCheck(events, () => held);
        await withDecisionCheck(events, async () => undefined);
        release?.();
        await outer;

        // The append-only reading is what the footer checks: two consults can run at once (the evaluator
        // serves several), and the badge stays animated until the last of them finishes.
        expect(seen).toEqual([1, 2, 1, 0]);
    });

    it("releases the count when the consult throws", async () => {
        const events = createEventBus();
        const seen = counters(events);

        await expect(
            withDecisionCheck(events, async () => {
                throw new Error("endpoint down");
            }),
        ).rejects.toThrow("endpoint down");

        expect(seen).toEqual([1, 0]);
    });

    it("runs the consult without a bus", async () => {
        const seen: number[] = [];

        const result = await withDecisionCheck(undefined, async () => {
            seen.push(1);
            return "answered";
        });

        expect(result).toBe("answered");
        expect(seen).toEqual([1]);
    });
});

describe("decision events", () => {
    it("reads a status payload structurally and rejects anything else", () => {
        expect(isDecisionStatusEvent({ checking: 2 })).toBe(true);

        expect(isDecisionStatusEvent({ checking: "2" })).toBe(false);
        expect(isDecisionStatusEvent(null)).toBe(false);
        expect(isDecisionStatusEvent("checking")).toBe(false);
    });

    it("drops a judged state whose phase the vocabulary cannot name", () => {
        expect(isDecisionStateEvent({ labels: { phase: "implementing" } })).toBe(true);
        expect(isDecisionStateEvent({ labels: {} })).toBe(true);

        expect(isDecisionStateEvent({ labels: { phase: "nonsense" } })).toBe(false);
        expect(isDecisionStateEvent({})).toBe(false);
        expect(isDecisionStateEvent(undefined)).toBe(false);
    });

    it("emits nothing without a bus", () => {
        expect(() => {
            emitDecisionStatus(undefined, 1);
            emitDecisionState(undefined, { phase: "documenting" });
        }).not.toThrow();
    });

    it("emits on both channels when a bus is given", () => {
        const events = createEventBus();
        const statuses = counters(events);
        const states: unknown[] = [];
        events.on(DECISION_STATE_EVENT, (data) => states.push(data));

        emitDecisionStatus(events, 1);
        emitDecisionState(events, { phase: "implementing" });

        expect(statuses).toEqual([1]);
        expect(states).toEqual([{ labels: { phase: "implementing" } }]);
    });
});
