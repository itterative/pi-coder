import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { repairInterruptedToolCalls } from "../../src/tools/agent/child";
import { ZERO_USAGE } from "../../src/tools/agent/runtime";

describe("persistent child transcript repair", () => {
    it("adds uncertain error results only for unmatched tool calls", () => {
        const sessionManager = SessionManager.inMemory(process.cwd());
        sessionManager.appendMessage({
            role: "assistant",
            content: [
                { type: "toolCall", id: "matched", name: "read", arguments: { path: "a.ts" } },
                { type: "toolCall", id: "unmatched", name: "edit", arguments: { path: "b.ts" } },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            stopReason: "toolUse",
            timestamp: Date.now(),
        });
        sessionManager.appendMessage({
            role: "toolResult",
            toolCallId: "matched",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now(),
        });

        expect(repairInterruptedToolCalls(sessionManager)).toBe(1);
        const messages = sessionManager.buildSessionContext().messages;
        const repaired = messages.at(-1);
        expect(repaired).toMatchObject({
            role: "toolResult",
            toolCallId: "unmatched",
            toolName: "edit",
            isError: true,
        });
        expect(JSON.stringify(repaired)).toContain("outcome is uncertain");
        expect(repairInterruptedToolCalls(sessionManager)).toBe(0);
    });
});
