import { describe, expect, it } from "vitest";

import { DEFAULT_COMPACTION_CONFIG } from "../../../src/modules/compaction/config";
import {
    serializeConversationMinimal,
    type SerializeOptions,
    serializerOptions,
} from "../../../src/modules/compaction/serialize";
import {
    assistantMessage,
    bashExecutionMessage,
    compactionSummaryMessage,
    customMessage,
    toolResultMessage,
    userMessage,
} from "../../helpers/compaction-doubles";
import { snapshotText } from "../../helpers";
import type { ContextMessage } from "../../../src/modules/compaction/types";

function options(overrides: Partial<SerializeOptions> = {}): SerializeOptions {
    return { ...serializerOptions(DEFAULT_COMPACTION_CONFIG), ...overrides };
}

function serialize(messages: ContextMessage[], overrides: Partial<SerializeOptions> = {}) {
    return serializeConversationMinimal(messages, options(overrides));
}

const LONG_TEXT = "line of output\n".repeat(400);

const MATRIX: Array<{ title: string; messages: ContextMessage[] }> = [
    {
        title: "user and assistant turns",
        messages: [
            userMessage("compact this session please"),
            assistantMessage({
                thinking: "private reasoning that should not be serialized",
                text: "working on it",
            }),
        ],
    },
    {
        title: "known tool calls",
        messages: [
            assistantMessage({
                calls: [
                    {
                        id: "c1",
                        name: "read",
                        arguments: { path: "src/index.ts", offset: 10, limit: 50 },
                    },
                    { id: "c2", name: "bash", arguments: { command: `${LONG_TEXT}`, timeout: 30 } },
                    { id: "c3", name: "edit", arguments: { path: "a.ts", edits: [{}, {}, {}] } },
                    { id: "c4", name: "write", arguments: { path: "b.ts", content: LONG_TEXT } },
                    {
                        id: "c5",
                        name: "grep",
                        arguments: { pattern: "compact", path: "src", glob: "*.ts" },
                    },
                    {
                        id: "c6",
                        name: "agent",
                        arguments: {
                            action: "start",
                            agent: "scout",
                            title: "Recon",
                            task: LONG_TEXT,
                        },
                    },
                    {
                        id: "c7",
                        name: "ask_user",
                        arguments: { title: "Which?", options: [{}, {}] },
                    },
                ],
            }),
        ],
    },
    {
        title: "unknown tool call",
        messages: [
            assistantMessage({
                calls: [
                    { id: "u1", name: "mystery_tool", arguments: { zeta: LONG_TEXT, alpha: 3 } },
                ],
            }),
        ],
    },
    {
        title: "tool results",
        messages: [
            toolResultMessage({ callId: "c1", tool: "read", text: LONG_TEXT }),
            toolResultMessage({ callId: "c2", tool: "bash", text: LONG_TEXT, isError: true }),
            toolResultMessage({ callId: "c6", tool: "agent", text: LONG_TEXT }),
        ],
    },
    {
        title: "bash execution and injected notes",
        messages: [
            bashExecutionMessage({ command: "npm test", output: LONG_TEXT, exitCode: 1 }),
            bashExecutionMessage({ command: "git status", output: "M src/index.ts", exitCode: 0 }),
            bashExecutionMessage({ command: "secret", output: "hidden", excludeFromContext: true }),
            customMessage("pi-coder:agent-mailbox", "background run finished", false),
        ],
    },
    {
        title: "earlier summaries",
        messages: [
            compactionSummaryMessage("## Goal\n\nEarlier goal that must survive."),
            userMessage("continue"),
        ],
    },
];

describe("serializeConversationMinimal", () => {
    it("renders the message matrix in pi's line format", async () => {
        const sections = MATRIX.map((entry) => {
            const rendered = serialize(entry.messages);
            return [`### ${entry.title}`, rendered.text].join("\n\n");
        });
        await expect(snapshotText(sections.join("\n\n"))).toMatchFileSnapshot(
            "__snapshots__/compaction-serialize.matrix.txt",
        );
    });

    it("keeps thinking only when asked", () => {
        const messages = [assistantMessage({ thinking: "the reasoning", text: "the answer" })];
        expect(serialize(messages, { keepThinking: false }).text).not.toContain("the reasoning");
        expect(serialize(messages, { keepThinking: true }).text).toContain(
            "[Assistant thinking]: the reasoning",
        );
    });

    it("omits bash executions pi excluded from context", () => {
        const rendered = serialize([
            bashExecutionMessage({ command: "secret", output: "hidden", excludeFromContext: true }),
        ]);
        expect(rendered.text).toBe("");
        expect(rendered.keptBlocks).toBe(0);
    });

    it("names unknown tool arguments without echoing their values", () => {
        const rendered = serialize(
            MATRIX.find((entry) => entry.title === "unknown tool call")?.messages ?? [],
        );
        expect(rendered.text).toContain("mystery_tool(alpha, zeta)");
        expect(rendered.text).not.toContain("line of output");
    });

    it("packs newest-first under the ceiling and reports what it dropped", () => {
        const messages: ContextMessage[] = Array.from({ length: 40 }, (_unused, index) =>
            userMessage(`message ${String(index)} ${"payload ".repeat(50)}`),
        );
        const rendered = serialize(messages, { maxTokens: 500 });
        expect(rendered.droppedBlocks).toBeGreaterThan(0);
        expect(rendered.text).toContain("message 39");
        expect(rendered.text).not.toContain("message 0 ");
        expect(rendered.text).toMatch(/older message blocks omitted/);
    });

    it("keeps at least one block even when it alone exceeds the ceiling", () => {
        const rendered = serialize([userMessage(LONG_TEXT)], { maxTokens: 10 });
        expect(rendered.keptBlocks).toBe(1);
        expect(rendered.droppedBlocks).toBe(0);
    });
});
