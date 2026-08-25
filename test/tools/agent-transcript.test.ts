import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
    formatAgentSessionTranscript,
    loadAgentSessionTranscript,
} from "../../src/tools/agent/presentation/transcript";

function transcriptFixture(name: string): string {
    return fileURLToPath(new URL(`./fixtures/agent-transcripts/${name}.jsonl`, import.meta.url));
}

const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("delegated-agent transcript formatting", () => {
    it("includes messages, tool calls, and tool results while omitting thinking", async () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "user",
            content: "Inspect the project",
            timestamp: 1,
        });
        session.appendMessage({
            role: "assistant",
            content: [
                { type: "thinking", thinking: "private reasoning must not be shown" },
                { type: "text", text: "I will inspect the entry point." },
                { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 2,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "export default function main() {}" }],
            isError: false,
            timestamp: 3,
        });
        session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "The entry point is present." }],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "stop",
            timestamp: 4,
        });

        const transcript = formatAgentSessionTranscript(session.getBranch());

        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.complete.txt");
    });

    it("marks failed calls and keeps consecutive calls together", async () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-edit",
                    name: "edit",
                    arguments: {
                        path: "src/index.ts",
                        edits: [{ oldText: "const oldValue = true;", newText: "const newValue = true;" }],
                    },
                },
                { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "npm test" } },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 1,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-edit",
            toolName: "edit",
            content: [{ type: "text", text: "Edit failed" }],
            isError: true,
            timestamp: 2,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-bash",
            toolName: "bash",
            content: [{ type: "text", text: "Passed" }],
            isError: false,
            timestamp: 3,
        });
        session.appendMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } }],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 4,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "Read successfully" }],
            isError: false,
            timestamp: 5,
        });

        await expect(formatAgentSessionTranscript(session.getBranch())).toMatchFileSnapshot(
            "__snapshots__/agent-transcript.tool-calls.txt",
        );
    });

    it("shows search patterns and paths", async () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "assistant",
            content: [
                { type: "toolCall", id: "call-find", name: "find", arguments: { pattern: "*.test.ts", path: "test" } },
                { type: "toolCall", id: "call-grep", name: "grep", arguments: { pattern: "AgentSession", path: "src/tui" } },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 1,
        });

        await expect(formatAgentSessionTranscript(session.getBranch())).toMatchFileSnapshot(
            "__snapshots__/agent-transcript.search-calls.txt",
        );
    });

    it("renders the saved delegated-agent transcript", async () => {
        const transcript = loadAgentSessionTranscript(transcriptFixture("run-0"));

        expect(transcript).toBeDefined();
        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.run-0.txt");
    });

    it("renders the second saved delegated-agent transcript", async () => {
        const transcript = loadAgentSessionTranscript(transcriptFixture("run-1"));

        expect(transcript).toBeDefined();
        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.run-1.txt");
    });

    it("renders the reviewer delegated-agent transcript", async () => {
        const transcript = loadAgentSessionTranscript(transcriptFixture("run-2"));

        expect(transcript).toBeDefined();
        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.run-2.txt");
    });
});
