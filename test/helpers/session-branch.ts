import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { zeroUsage } from "./agent-doubles";

/**
 * Builders for a real session branch.
 *
 * The decision module reads the entry shapes pi itself writes - assistant content parts carrying tool calls,
 * user text parts, `toolResult` messages - so these build through `SessionManager` rather than hand-rolled
 * entry literals: a pi re-shape then surfaces in one place instead of in each suite. Directories are tracked
 * and removed by `cleanupBranches()`, which a suite calls from its `afterEach`.
 */

export type AppendedMessage = Parameters<SessionManager["appendMessage"]>[0];
type AssistantContent = AssistantMessage["content"];

const directories: string[] = [];

/**
 * A mutable session in a temporary directory: entries can be appended between turns.
 *
 * Use it when a case changes the branch mid-test; `branch()` is the read-only shortcut over the same thing.
 */
export function sessionManager(cwd = process.cwd()): SessionManager {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-branch-"));
    directories.push(directory);

    return SessionManager.create(cwd, directory);
}

/** A branch from a real session manager, so entry shapes are pi's rather than an approximation. */
export function branch(messages: readonly AppendedMessage[]): SessionEntry[] {
    const session = sessionManager();
    for (const message of messages) {
        session.appendMessage(message);
    }

    return session.getBranch();
}

/** Remove every directory `branch()` created; intended for a suite's `afterEach`. */
export function cleanupBranches(): void {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

export function userEntry(text: string, timestamp: number): AppendedMessage {
    return { role: "user", content: text, timestamp };
}

export function assistantEntry(content: AssistantContent, timestamp: number): AppendedMessage {
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

/**
 * A tool result. `toolCallId` and `toolName` point back at the call, which only the outcome-aware signals
 * read: everything else ignores tool output on purpose.
 */
export function toolResultEntry(
    text: string,
    timestamp: number,
    toolCallId = "call-1",
    toolName = "read",
): AppendedMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: false,
        timestamp,
    };
}

/** A text content part of an assistant message. */
export function textPart(text: string): AssistantContent[number] {
    return { type: "text", text };
}

/** A tool-call content part; `id` defaults to the tool name so results can point back at it. */
export function toolCall(
    name: string,
    args: JsonObject,
    id = `call-${name}`,
): AssistantContent[number] {
    return { type: "toolCall", id, name, arguments: args };
}
