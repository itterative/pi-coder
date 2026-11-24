import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerContinueCommand, {
    CONTINUE_CUSTOM_TYPE,
    CONTINUE_TRIGGER_CONTENT,
    stripContinueTriggers,
} from "../../src/commands/continue";
import { zeroUsage } from "../helpers/agent-doubles";
import { createPiStub, stubCommandContext, stubContext, stubUi } from "../helpers/pi-stub";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    userEntry,
    type AppendedMessage,
} from "../helpers/session-branch";

afterEach(cleanupBranches);

async function invokeContinue(messages: readonly AppendedMessage[]) {
    const session = sessionManager();
    for (const message of messages) {
        session.appendMessage(message);
    }

    const stub = createPiStub();
    registerContinueCommand(stub.pi);

    const notify = vi.fn();
    const waitForIdle = vi.fn(async () => {
        // The command must not race an in-flight run: nothing is sent until idle resolves.
        expect(stub.sentMessages).toHaveLength(0);
    });
    const ctx = stubCommandContext({
        sessionManager: session,
        ui: stubUi({ notify }),
        waitForIdle,
    });

    await stub.requireCommand("continue").handler("", ctx);

    return { sent: stub.sentMessages, notify, waitForIdle };
}

type ContextMessage = Parameters<typeof stripContinueTriggers>[0]["messages"][number];

function customMessage(customType: string, timestamp: number): ContextMessage {
    return {
        role: "custom",
        customType,
        content: "",
        display: false,
        timestamp,
    };
}

function userMessage(text: string, timestamp: number): ContextMessage {
    return { role: "user", content: text, timestamp };
}

/** Fresh handlers for the module-level memo; each test resets it through `session_start`. */
function registeredHandlers() {
    const stub = createPiStub();
    registerContinueCommand(stub.pi);

    return {
        stub,
        context: stub.requireHandler("context"),
        turnEnd: stub.requireHandler("turn_end"),
        sessionStart: stub.requireHandler("session_start"),
        sessionTree: stub.requireHandler("session_tree"),
    };
}

describe("/continue", () => {
    beforeEach(async () => {
        const { sessionStart } = registeredHandlers();
        await sessionStart(
            { type: "session_start", reason: "startup" },
            stubContext({ sessionManager: sessionManager() }),
        );
    });

    it("registers a command and a context filter", () => {
        const stub = createPiStub();
        registerContinueCommand(stub.pi);

        expect(stub.requireCommand("continue").description).toContain("without adding a message");
        expect(stub.handlersFor("context")).toHaveLength(1);
        expect(stub.handlersFor("turn_end")).toHaveLength(1);
        expect(stub.handlersFor("session_start")).toHaveLength(1);
        expect(stub.handlersFor("session_tree")).toHaveLength(1);
    });

    it("sends a hidden, empty trigger after a provider error and reports the error", async () => {
        const { sent, notify, waitForIdle } = await invokeContinue([
            userEntry("fix the failing test", 1),
            assistantEntry([], 2, zeroUsage(), {
                stopReason: "error",
                errorMessage: "529 overloaded",
            }),
        ]);

        expect(waitForIdle).toHaveBeenCalledTimes(1);
        expect(sent).toStrictEqual([
            {
                message: {
                    customType: CONTINUE_CUSTOM_TYPE,
                    content: CONTINUE_TRIGGER_CONTENT,
                    display: false,
                },
                options: { triggerTurn: true },
            },
        ]);
        expect(notify).toHaveBeenCalledWith(
            "Retrying after the provider error: 529 overloaded",
            "warning",
        );
    });

    it("removes the trigger from the request and keeps every other message", () => {
        const trigger = customMessage(CONTINUE_CUSTOM_TYPE, 4);
        const otherCustom = customMessage("other-extension", 2);
        const messages: ContextMessage[] = [
            { role: "user", content: "fix it", timestamp: 1 },
            otherCustom,
            trigger,
        ];

        const result = stripContinueTriggers({ type: "context", messages });

        expect(result).toStrictEqual({ messages: [messages[0], otherCustom] });
    });

    it("leaves a request without triggers untouched", () => {
        const messages: ContextMessage[] = [
            { role: "user", content: "fix it", timestamp: 1 },
            customMessage("other-extension", 2),
        ];

        expect(stripContinueTriggers({ type: "context", messages })).toBeUndefined();
    });

    it("omits a consumed trigger at turn_end", async () => {
        const session = sessionManager();
        session.appendMessage(userEntry("fix it", 1));
        const triggerId = session.appendCustomMessageEntry(CONTINUE_CUSTOM_TYPE, "", false);
        session.appendMessage(assistantEntry([{ type: "text", text: "Done." }], 2));

        const stub = createPiStub();
        registerContinueCommand(stub.pi);

        const result = await stub.requireHandler("turn_end")(
            { type: "turn_end", entries: [] },
            stubContext({ sessionManager: session }),
        );

        expect(result).toStrictEqual({
            entries: [{ type: "context_edit", targetId: triggerId, replacement: null }],
        });
    });

    it("keeps earlier boundary drafts when adding the omission", async () => {
        const session = sessionManager();
        session.appendMessage(userEntry("fix it", 1));
        const triggerId = session.appendCustomMessageEntry(CONTINUE_CUSTOM_TYPE, "", false);
        const earlier = { type: "custom", customType: "other-extension", data: { kept: true } };

        const stub = createPiStub();
        registerContinueCommand(stub.pi);

        const result = await stub.requireHandler("turn_end")(
            { type: "turn_end", entries: [earlier] },
            stubContext({ sessionManager: session }),
        );

        expect(result).toStrictEqual({
            entries: [earlier, { type: "context_edit", targetId: triggerId, replacement: null }],
        });
    });

    it("does not omit the same trigger twice", async () => {
        const session = sessionManager();
        session.appendMessage(userEntry("fix it", 1));
        const triggerId = session.appendCustomMessageEntry(CONTINUE_CUSTOM_TYPE, "", false);
        session.appendContextEdit(triggerId, null);

        const stub = createPiStub();
        registerContinueCommand(stub.pi);

        const result = await stub.requireHandler("turn_end")(
            { type: "turn_end", entries: [] },
            stubContext({ sessionManager: session }),
        );

        expect(result).toBeUndefined();
    });

    it("drops an omitted trigger from the model projection", () => {
        const session = sessionManager();
        session.appendMessage(userEntry("fix it", 1));
        const triggerId = session.appendCustomMessageEntry(CONTINUE_CUSTOM_TYPE, "", false);
        session.appendMessage(assistantEntry([{ type: "text", text: "Done." }], 2));
        session.appendContextEdit(triggerId, null);

        const messages = session.buildSessionProjection().messages;

        expect(
            messages.some(
                (message) =>
                    message.role === "custom" && message.customType === CONTINUE_CUSTOM_TYPE,
            ),
        ).toBe(false);
    });

    it("filters a leftover trigger after a session reload", async () => {
        const session = sessionManager();
        session.appendMessage(userEntry("fix it", 1));
        session.appendCustomMessageEntry(CONTINUE_CUSTOM_TYPE, "", false);

        const { context, sessionStart } = registeredHandlers();
        await sessionStart(
            { type: "session_start", reason: "reload" },
            stubContext({ sessionManager: session }),
        );

        const user = userMessage("fix it", 1);
        const trigger = customMessage(CONTINUE_CUSTOM_TYPE, 2);
        const result = await context(
            { type: "context", messages: [user, trigger] },
            stubContext({ sessionManager: session }),
        );

        expect(result).toStrictEqual({ messages: [user] });
    });

    it("filters a leftover trigger after tree navigation", async () => {
        const empty = sessionManager();
        const { context, turnEnd, sessionTree } = registeredHandlers();

        // A completed turn clears the memo; navigating onto another branch must set it again.
        await turnEnd({ type: "turn_end", entries: [] }, stubContext({ sessionManager: empty }));

        const session = sessionManager();
        session.appendMessage(userEntry("fix it", 1));
        session.appendCustomMessageEntry(CONTINUE_CUSTOM_TYPE, "", false);
        await sessionTree(
            { type: "session_tree", newLeafId: "leaf", oldLeafId: null },
            stubContext({ sessionManager: session }),
        );

        const user = userMessage("fix it", 1);
        const trigger = customMessage(CONTINUE_CUSTOM_TYPE, 2);
        const result = await context(
            { type: "context", messages: [user, trigger] },
            stubContext({ sessionManager: session }),
        );

        expect(result).toStrictEqual({ messages: [user] });
    });

    it("skips the request scan after turn_end clears the memo", async () => {
        const empty = sessionManager();
        const { context, turnEnd } = registeredHandlers();

        await turnEnd({ type: "turn_end", entries: [] }, stubContext({ sessionManager: empty }));

        const trigger = customMessage(CONTINUE_CUSTOM_TYPE, 2);
        const result = await context(
            { type: "context", messages: [userMessage("fix it", 1), trigger] },
            stubContext({ sessionManager: empty }),
        );

        expect(result).toBeUndefined();
    });

    it("still re-issues the request after a completed response", async () => {
        const { sent, notify } = await invokeContinue([
            userEntry("explain the test", 1),
            assistantEntry([{ type: "text", text: "It asserts the failure." }], 2),
        ]);

        expect(sent).toHaveLength(1);
        expect(notify).toHaveBeenCalledWith(
            "The previous response completed; asking for the next step.",
            "info",
        );
    });

    it("reports an aborted or truncated response", async () => {
        const aborted = await invokeContinue([
            userEntry("run it", 1),
            assistantEntry([], 2, zeroUsage(), { stopReason: "aborted" }),
        ]);
        const truncated = await invokeContinue([
            userEntry("run it", 1),
            assistantEntry([], 2, zeroUsage(), { stopReason: "length" }),
        ]);

        expect(aborted.notify).toHaveBeenCalledWith(
            "Resuming after the previous run was aborted.",
            "warning",
        );
        expect(truncated.notify).toHaveBeenCalledWith(
            "Resuming after the response hit the output limit.",
            "warning",
        );
    });

    it("reads the newest assistant response, not an older failure", async () => {
        const { notify } = await invokeContinue([
            userEntry("first try", 1),
            assistantEntry([], 2, zeroUsage(), { stopReason: "error", errorMessage: "503" }),
            userEntry("second try", 3),
            assistantEntry([{ type: "text", text: "Done." }], 4),
        ]);

        expect(notify).toHaveBeenCalledWith(
            "The previous response completed; asking for the next step.",
            "info",
        );
    });

    it("re-issues a branch that has no assistant response yet", async () => {
        const { sent, notify } = await invokeContinue([]);

        expect(sent).toHaveLength(1);
        expect(notify).toHaveBeenCalledWith("Continuing the conversation.", "info");
    });
});
