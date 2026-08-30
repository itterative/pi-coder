import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { TODO_SNAPSHOT_TYPE } from "../../src/modules/todolist/persistence";
import {
    formatAgentSessionTranscript,
    formatAgentSessionTranscripts,
    formatToolCallSummary,
} from "../../src/tools/agent/presentation/transcript";

function transcriptFixture(name: string): string {
    return fileURLToPath(new URL(`./fixtures/agent-transcripts/${name}.jsonl`, import.meta.url));
}

function formatSavedTranscript(name: string): string {
    const session = SessionManager.open(transcriptFixture(name));
    return formatAgentSessionTranscript(session.getBranch());
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
    it("formats tool call counts consistently", () => {
        expect(formatToolCallSummary(3, 1)).toBe("3 tool calls (1 failed)");
        expect(formatToolCallSummary(1, 0)).toBe("1 tool call (0 failed)");
        expect(formatToolCallSummary(1, 0, false)).toBe("1 tool call");
    });

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
                {
                    type: "toolCall",
                    id: "call-1",
                    name: "read",
                    arguments: { path: "src/index.ts" },
                },
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

    it("skips hidden custom messages and keeps visible ones", () => {
        const session = SessionManager.inMemory("/project");
        session.appendCustomMessageEntry(
            "pi-memory",
            "<memory_reminder>\nBefore starting work, consider whether any memories are relevant.\n</memory_reminder>",
            false,
        );
        session.appendMessage({
            role: "user",
            content: "Inspect the project",
            timestamp: 1,
        });
        session.appendCustomMessageEntry(
            "pi-coder-agent-mailbox",
            "Background mailbox update for the parent agent.",
            false,
        );
        session.appendCustomMessageEntry("note", "A visible custom note.", true);

        const transcript = formatAgentSessionTranscript(session.getBranch());

        expect(transcript).not.toContain("memory_reminder");
        expect(transcript).not.toContain("Background mailbox update");
        expect(transcript).toContain("> A visible custom note.");
        expect(transcript).toContain("> Inspect the project");
    });

    it("does not treat visible custom messages as user messages for TODO placement", () => {
        const session = SessionManager.inMemory("/project");
        session.appendCustomMessageEntry("note", "A visible custom note.", true);
        session.appendCustomEntry(TODO_SNAPSHOT_TYPE, {
            version: 1,
            content: `---
version: 1
todos:
  - id: inspect
    title: Inspect the implementation
    status: pending
---
`,
        });

        expect(formatAgentSessionTranscript(session.getBranch())).toBe(
            "TODO 0/1 · Inspect the implementation\n  ○ Inspect the implementation\n\n> A visible custom note.",
        );
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
                        edits: [
                            {
                                oldText: "const oldValue = true;",
                                newText: "const newValue = true;",
                            },
                        ],
                    },
                },
                {
                    type: "toolCall",
                    id: "call-bash",
                    name: "bash",
                    arguments: { command: "npm test" },
                },
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
            content: [{ type: "text", text: "The first checks are complete." }],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "stop",
            timestamp: 4,
        });
        session.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-read",
                    name: "read",
                    arguments: { path: "README.md" },
                },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 5,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "Read successfully" }],
            isError: false,
            timestamp: 6,
        });

        await expect(formatAgentSessionTranscript(session.getBranch())).toMatchFileSnapshot(
            "__snapshots__/agent-transcript.tool-calls.txt",
        );

        expect(formatAgentSessionTranscript(session.getBranch(), "collapsed")).toBe(
            "▸ 2 tool calls (1 failed): edit src/index.ts; run npm test\n\nThe first checks are complete.\n\n▸ 1 tool call: read README.md",
        );
    });

    it("summarizes edit and write line changes in detailed tool calls", () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-edit-summary",
                    name: "edit",
                    arguments: {
                        path: "src/index.ts",
                        edits: [{ oldText: "one\ntwo", newText: "one\nthree\nfour" }],
                    },
                },
                {
                    type: "toolCall",
                    id: "call-write-summary",
                    name: "write",
                    arguments: { path: "README.md", content: "first\nsecond" },
                },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 1,
        });

        expect(formatAgentSessionTranscript(session.getBranch())).toBe(
            "● edit src/index.ts (+3 -2)\n● write README.md (+2 lines)",
        );
    });

    it("renders the TODO entry after the initial user message and before tool calls", () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "user",
            content: "Inspect the project",
            timestamp: 1,
        });
        session.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-read",
                    name: "read",
                    arguments: { path: "src/index.ts" },
                },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "toolUse",
            timestamp: 2,
        });
        session.appendCustomEntry(TODO_SNAPSHOT_TYPE, {
            version: 1,
            content: `---
version: 1
todos:
  - id: inspect
    title: Inspect the implementation
    status: in_progress
---
`,
        });

        const transcripts = formatAgentSessionTranscripts(session.getBranch());

        expect(transcripts.detailed).toBe(
            "> Inspect the project\n\nTODO 0/1 · Inspect the implementation\n  ◐ Inspect the implementation\n\n● read src/index.ts",
        );
        expect(transcripts.collapsed).toBe(
            "> Inspect the project\n\nTODO 0/1 · Inspect the implementation\n  ◐ Inspect the implementation\n\n▸ 1 tool call: read src/index.ts",
        );
    });

    it("renders the TODO entry first when the conversation has no user message", () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "I will inspect the project." }],
            api: "test",
            provider: "test",
            model: "test",
            usage,
            stopReason: "stop",
            timestamp: 1,
        });
        session.appendCustomEntry(TODO_SNAPSHOT_TYPE, {
            version: 1,
            content: `---
version: 1
todos:
  - id: inspect
    title: Inspect the implementation
    status: pending
---
`,
        });

        expect(formatAgentSessionTranscript(session.getBranch())).toBe(
            "TODO 0/1 · Inspect the implementation\n  ○ Inspect the implementation\n\nI will inspect the project.",
        );
    });

    it("shows search patterns and paths", async () => {
        const session = SessionManager.inMemory("/project");
        session.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-find",
                    name: "find",
                    arguments: { pattern: "*.test.ts", path: "test" },
                },
                {
                    type: "toolCall",
                    id: "call-grep",
                    name: "grep",
                    arguments: { pattern: "AgentSession", path: "src/tui" },
                },
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
        const transcript = formatSavedTranscript("run-0");

        expect(transcript).toBeDefined();
        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.run-0.txt");
    });

    it("renders the second saved delegated-agent transcript", async () => {
        const transcript = formatSavedTranscript("run-1");

        expect(transcript).toBeDefined();
        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.run-1.txt");
    });

    it("renders the reviewer delegated-agent transcript", async () => {
        const transcript = formatSavedTranscript("run-2");

        expect(transcript).toBeDefined();
        await expect(transcript).toMatchFileSnapshot("__snapshots__/agent-transcript.run-2.txt");
    });
});
