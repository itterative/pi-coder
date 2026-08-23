import { describe, expect, it, vi } from "vitest";

import {
    AGENT_MAILBOX_MESSAGE_TYPE,
    AgentMailbox,
} from "../../src/tools/agent/mailbox";
import {
    ZERO_USAGE,
    type AgentRunDetails,
    type AgentRunStatus,
} from "../../src/tools/agent/runtime";

function details(
    runId: string,
    status: AgentRunStatus,
    fields: Partial<AgentRunDetails> = {},
): AgentRunDetails {
    return {
        runId,
        agent: "scout",
        status,
        background: true,
        task: "Inspect the implementation",
        recentActivity: [],
        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        startedAt: 1,
        updatedAt: 2,
        ...fields,
    };
}

describe("agent parent mailbox", () => {
    it("holds and coalesces updates until an automatic follow-up flush", () => {
        const sendMessage = vi.fn();
        const mailbox = new AgentMailbox({ sendMessage });

        mailbox.queue(details("scout-1", "running", { output: "Still working" }));
        mailbox.queue(details("scout-1", "waiting_for_parent", {
            question: { question: "Which implementation?", context: "Both are viable." },
        }));
        mailbox.queue(details("scout-1", "completed", {
            output: `Final\nresult ${"x".repeat(300)}`,
        }));

        expect(sendMessage).not.toHaveBeenCalled();
        expect(mailbox.flush()).toBe(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        const [message, options] = sendMessage.mock.calls[0]!;
        expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
        expect(message).toMatchObject({
            customType: AGENT_MAILBOX_MESSAGE_TYPE,
            display: false,
            details: {
                updates: [{ runId: "scout-1", agent: "scout", status: "completed" }],
            },
        });
        expect(message.content).toContain("This is not a new user request");
        expect(message.content).toContain('Run ID: "scout-1"');
        expect(message.content).toContain("Status: completed");
        expect(message.content).not.toContain("Which implementation?");
        expect(message.content.length).toBeLessThan(1_000);
        expect(mailbox.flush()).toBe(0);
    });

    it("drops stale updates after collection, resume, or cancellation", () => {
        const sendMessage = vi.fn();
        const mailbox = new AgentMailbox({ sendMessage });

        mailbox.queue(details("scout-1", "completed", { output: "Done" }));
        mailbox.queue(details("scout-2", "waiting_for_parent", {
            question: { question: "Need guidance", context: "Blocked" },
        }));
        mailbox.reconcile([
            { runId: "scout-2", status: "running" },
        ]);

        expect(mailbox.flush()).toBe(0);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("stops accepting or delivering updates after shutdown", () => {
        const sendMessage = vi.fn();
        const mailbox = new AgentMailbox({ sendMessage });
        mailbox.queue(details("scout-1", "completed", { output: "Done" }));

        mailbox.close();
        mailbox.queue(details("scout-2", "completed", { output: "Also done" }));

        expect(mailbox.flush()).toBe(0);
        expect(sendMessage).not.toHaveBeenCalled();
    });
});
