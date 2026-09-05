import { describe, expect, it } from "vitest";

import {
    analyzeSpan,
    buildSupplementarySections,
    computeFileLists,
    formatFileLists,
} from "../../../src/modules/compaction/sections";
import type { ContextMessage } from "../../../src/modules/compaction/types";
import {
    assistantMessage,
    fileOperations,
    toolResultMessage,
    userMessage,
} from "../../helpers/compaction-doubles";
import { snapshotText } from "../../helpers";

function call(id: string, name: string, args: Record<string, unknown>): ContextMessage {
    return assistantMessage({ calls: [{ id, name, arguments: args }] });
}

describe("deterministic summary sections", () => {
    const messages: ContextMessage[] = [
        userMessage("first request"),
        call("a1", "agent", { action: "start", agent: "scout", title: "Map the compaction path" }),
        toolResultMessage({ callId: "a1", tool: "agent", text: "run id 01abc" }),
        call("a2", "agent", { action: "collect", runId: "01abc" }),
        call("r1", "read", { path: "src/index.ts" }),
        toolResultMessage({ callId: "r1", tool: "read", text: "contents", isError: true }),
        call("r2", "read", { path: "src/main.ts" }),
        userMessage("second request with a very long tail ".repeat(40)),
    ];

    it("counts calls and failures per tool", () => {
        const analysis = analyzeSpan(messages);
        expect(analysis.tools.get("agent")).toEqual({ calls: 2, failed: 0 });
        expect(analysis.tools.get("read")).toEqual({ calls: 2, failed: 1 });
        expect(analysis.toolCallCount).toBe(4);
        expect(analysis.failedToolCallCount).toBe(1);
        expect(analysis.messageCount).toBe(messages.length);
    });

    it("collects delegated run ids from the calls that named them", () => {
        const analysis = analyzeSpan(messages);
        expect([...analysis.agentRunIds]).toEqual(["01abc"]);
        expect(analysis.agentCalls[0]).toEqual({
            action: "start",
            agent: "scout",
            title: "Map the compaction path",
        });
    });

    it("renders the sections for a file snapshot", async () => {
        const sections = buildSupplementarySections({
            analysis: analyzeSpan(messages),
            firstKeptEntryId: "kept-9",
            droppedBlocks: 3,
        });
        await expect(snapshotText(sections)).toMatchFileSnapshot(
            "__snapshots__/compaction-sections.span.txt",
        );
    });

    it("omits sections a span cannot fill", () => {
        const sections = buildSupplementarySections({
            analysis: analyzeSpan([userMessage("only a request")]),
            firstKeptEntryId: "kept-1",
            droppedBlocks: 0,
        });
        expect(sections).not.toContain("## Tool Ledger");
        expect(sections).not.toContain("## Delegated Runs");
        expect(sections).toContain("## Verbatim Recent Requests");
        expect(sections).not.toContain("older message blocks were left out");
    });

    it("reports the blocks the serializer itself dropped", () => {
        const sections = buildSupplementarySections({
            analysis: analyzeSpan([userMessage("only a request")]),
            firstKeptEntryId: "kept-1",
            droppedBlocks: 2,
        });
        expect(sections).toContain("2 older message blocks were left out");
    });

    it("ignores non-agent tool calls when collecting runs", () => {
        const analysis = analyzeSpan([call("x1", "read", { path: "a" })]);
        expect(analysis.agentCalls).toEqual([]);
    });

    it("keeps a file's most recent classification when it was both read and edited", () => {
        const lists = computeFileLists(
            fileOperations({
                read: new Set(["a.ts", "b.ts"]),
                written: new Set(["c.ts"]),
                edited: new Set(["b.ts"]),
            }),
        );
        expect(lists.readFiles).toEqual(["a.ts"]);
        expect(lists.modifiedFiles).toEqual(["b.ts", "c.ts"]);
    });

    it("emits pi's file tags verbatim", () => {
        expect(formatFileLists(["a.ts"], [])).toBe("\n\n<read-files>\na.ts\n</read-files>");
        expect(formatFileLists(["a.ts"], ["b.ts"])).toBe(
            "\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
        );
        expect(formatFileLists([], [])).toBe("");
    });
});
