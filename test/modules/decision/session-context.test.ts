import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    decisionSessionContext,
    SUGGESTION_HISTORY_COUNT,
    decisionSimilarCommands,
    ITEM_CHARS,
    RECENT_ITEM_COUNT,
    REQUEST_CHARS,
} from "../../../src/modules/decision";
import { zeroUsage } from "../../helpers/agent-doubles";

/**
 * The session half of a decision, built from a real branch: the current user request stays its own field and
 * `recent` carries the last turns of prose and bash commands before the command. Tool output never reaches
 * the model.
 */

type AppendedMessage = Parameters<SessionManager["appendMessage"]>[0];

const temporaryDirectories: string[] = [];

function branch(messages: AppendedMessage[]): SessionEntry[] {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decision-session-"));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(process.cwd(), directory);
    for (const message of messages) {
        session.appendMessage(message);
    }

    return session.getBranch();
}

function userEntry(text: string, timestamp: number): AppendedMessage {
    return { role: "user", content: text, timestamp };
}

function assistantEntry(content: AssistantMessage["content"], timestamp: number): AppendedMessage {
    return {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp,
    };
}

function toolResultEntry(text: string, timestamp: number): AppendedMessage {
    return {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp,
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("decisionSessionContext", () => {
    it("carries the last user message as the request and keeps the turns before the command", () => {
        const entries = branch([
            userEntry("inspect the tree", 1),
            assistantEntry([{ type: "text", text: "Looking at the tree." }], 2),
            userEntry("now run the tests", 3),
        ]);

        expect(decisionSessionContext(entries)).toEqual({
            request: "now run the tests",
            recent: [
                { role: "user", text: "inspect the tree" },
                { role: "assistant", text: "Looking at the tree." },
            ],
        });
    });

    it("has an empty recent when the branch holds only the request", () => {
        const entries = branch([userEntry("only request", 1)]);

        expect(decisionSessionContext(entries)).toEqual({ request: "only request", recent: [] });
    });

    it("keeps the current turn's committed items, with the request dropped only from recent", () => {
        const entries = branch([
            userEntry("start", 1),
            assistantEntry(
                [
                    { type: "text", text: "working" },
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "git status" },
                    },
                ],
                2,
            ),
            toolResultEntry("clean", 3),
        ]);

        // This is the branch at gate time for a second command in the turn: the first assistant message and
        // its command are committed, the pending message is not.
        expect(decisionSessionContext(entries)).toEqual({
            request: "start",
            recent: [
                { role: "assistant", text: "working" },
                { role: "command", text: "git status" },
            ],
        });
    });

    it("keeps the newest four items before the request, oldest first", () => {
        const entries = branch([
            userEntry("u1", 1),
            assistantEntry([{ type: "text", text: "a1" }], 2),
            userEntry("u2", 3),
            assistantEntry([{ type: "text", text: "a2" }], 4),
            userEntry("u3", 5),
            assistantEntry([{ type: "text", text: "a3" }], 6),
            userEntry("current", 7),
        ]);

        const { recent } = decisionSessionContext(entries);

        expect(recent).toHaveLength(RECENT_ITEM_COUNT);
        expect(recent).toEqual([
            { role: "user", text: "u2" },
            { role: "assistant", text: "a2" },
            { role: "user", text: "u3" },
            { role: "assistant", text: "a3" },
        ]);
    });

    it("records assistant prose and each bash call with the command role", () => {
        const entries = branch([
            userEntry("tidy up", 1),
            assistantEntry(
                [
                    { type: "text", text: "I'll inspect" },
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "git status" },
                    },
                    {
                        type: "toolCall",
                        id: "call-2",
                        name: "bash",
                        arguments: { command: "ls   -la" },
                    },
                ],
                2,
            ),
            userEntry("carry on", 3),
        ]);

        expect(decisionSessionContext(entries).recent).toEqual([
            { role: "user", text: "tidy up" },
            { role: "assistant", text: "I'll inspect" },
            { role: "command", text: "git status" },
            { role: "command", text: "ls -la" },
        ]);
    });

    it("ignores non-bash tool calls and tool results", () => {
        const entries = branch([
            userEntry("run the tests", 1),
            assistantEntry(
                [
                    { type: "text", text: "Reading first." },
                    {
                        type: "toolCall",
                        id: "call-read",
                        name: "read",
                        arguments: { path: "README.md" },
                    },
                ],
                2,
            ),
            toolResultEntry("file contents", 3),
            userEntry("now stop", 4),
        ]);

        const { recent } = decisionSessionContext(entries);

        expect(recent).toEqual([
            { role: "user", text: "run the tests" },
            { role: "assistant", text: "Reading first." },
        ]);
        expect(recent.some((item) => item.role === "command")).toBe(false);
    });

    it("clips a recent item at ITEM_CHARS after collapsing whitespace", () => {
        const entries = branch([
            assistantEntry([{ type: "text", text: `alpha\n\nbeta ${"x".repeat(400)}` }], 1),
            userEntry("continue", 2),
        ]);

        const [item] = decisionSessionContext(entries).recent;

        expect(item?.text).toHaveLength(ITEM_CHARS);
        expect(item?.text.startsWith("alpha beta ")).toBe(true);
        expect(item?.text.endsWith("…")).toBe(true);
        expect(item?.text).not.toContain("\n");
    });

    it("clips the request at REQUEST_CHARS", () => {
        const entries = branch([userEntry(`start ${"y".repeat(700)}`, 1)]);

        const { request } = decisionSessionContext(entries);

        expect(request).toHaveLength(REQUEST_CHARS);
        expect(request?.startsWith("start y")).toBe(true);
        expect(request?.endsWith("…")).toBe(true);
    });

    it("keeps only the earlier commands that name the same tool, newest last", () => {
        const entries = branch([
            userEntry("keep working", 1),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "npx zorch run test/a.test.ts" },
                    },
                ],
                2,
            ),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-2",
                        name: "bash",
                        arguments: { command: "npx vitest run test/b.test.ts" },
                    },
                ],
                3,
            ),
            assistantEntry(
                [
                    {
                        type: "toolCall",
                        id: "call-3",
                        name: "bash",
                        arguments: { command: "FOO=bar npx zorch run test/c.test.ts" },
                    },
                ],
                4,
            ),
        ]);

        expect(decisionSimilarCommands(entries, ["npx", "zorch", "run", "test/x.test.ts"])).toEqual(
            ["npx zorch run test/a.test.ts", "FOO=bar npx zorch run test/c.test.ts"],
        );
    });

    it("caps the same-tool window at SUGGESTION_HISTORY_COUNT", () => {
        const entries = branch(
            [2, 3, 4, 5].map((timestamp) =>
                assistantEntry(
                    [
                        {
                            type: "toolCall",
                            id: `call-${timestamp}`,
                            name: "bash",
                            arguments: { command: `npx zorch run test/${timestamp}.test.ts` },
                        },
                    ],
                    timestamp,
                ),
            ),
        );

        const commands = decisionSimilarCommands(entries, ["npx", "zorch"]);

        expect(commands).toHaveLength(SUGGESTION_HISTORY_COUNT);
        expect(commands).toEqual([
            "npx zorch run test/3.test.ts",
            "npx zorch run test/4.test.ts",
            "npx zorch run test/5.test.ts",
        ]);
    });

    it("produces no item or request for messages with empty text", () => {
        const entries = branch([
            userEntry("first", 1),
            assistantEntry([{ type: "text", text: "   \n  " }], 2),
            userEntry("   ", 3),
            userEntry("second", 4),
        ]);

        expect(decisionSessionContext(entries)).toEqual({
            request: "second",
            recent: [{ role: "user", text: "first" }],
        });
    });
});
