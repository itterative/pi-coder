import { describe, expect, it, vi } from "vitest";

import { emitAgentEvent } from "../../src/tools/agent/observability/events";

describe("delegated-agent event emission", () => {
    it("emits the payload with named sink and cwd options", () => {
        const emit = vi.fn();
        const now = vi.spyOn(Date, "now").mockReturnValue(123);

        try {
            emitAgentEvent(
                { type: "runtime", action: "reconciled", released: 2 },
                { sink: { emit }, cwd: "/tmp/project" },
            );
        } finally {
            now.mockRestore();
        }

        expect(emit).toHaveBeenCalledWith({
            type: "runtime",
            action: "reconciled",
            released: 2,
            cwd: "/tmp/project",
            timestamp: 123,
        });
        expect(Object.keys(emit.mock.calls[0][0])).toEqual([
            "type",
            "action",
            "released",
            "cwd",
            "timestamp",
        ]);
    });

    it("does nothing when no sink is provided", () => {
        expect(() =>
            emitAgentEvent({ type: "runtime", action: "reset" }, { cwd: "/tmp/project" }),
        ).not.toThrow();
    });
});
