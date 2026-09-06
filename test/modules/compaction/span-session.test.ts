import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "../../../src/modules/compaction/types";
import { describe, expect, it } from "vitest";

import {
    buildSpanSession,
    previousFoldWindowStart,
    skippedEntryCount,
    spanContextEntries,
    stageOneSpanEntries,
} from "../../../src/modules/compaction/span-session";
import { assistantMessage, toolResultMessage, userMessage } from "../../helpers/compaction-doubles";

/**
 * A branch built through pi's own appends, so every id referenced below is an id pi actually minted.
 *
 * Hand-written ids would not survive: the stage-1 transcript mints its own, and the point of these tests is
 * how resolution behaves across that difference.
 */
/** pi refuses message-shaped summaries through `appendMessage`, so the fixtures narrow them out. */
function append(manager: SessionManager, message: ContextMessage): string {
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
        throw new TypeError(`pi stores ${message.role} entries through their own append`);
    }
    return manager.appendMessage(message);
}

function buildBranch() {
    const manager = SessionManager.inMemory("/tmp");
    const first = append(manager, userMessage("first request"));
    const withCall = append(
        manager,
        assistantMessage({ text: "answer", calls: [{ id: "c1", name: "read" }] }),
    );
    const result = append(
        manager,
        toolResultMessage({ callId: "c1", tool: "read", text: "file contents here" }),
    );
    const compaction = manager.appendCompaction(
        "## Goal\n\nearlier checkpoint\n\n## Progress\n\n- [x] earlier checkpoint",
        first,
        1000,
    );
    const second = append(manager, userMessage("second request"));
    const mailbox = manager.appendCustomMessageEntry(
        "pi-coder:agent-mailbox",
        "run finished quietly",
        false,
    );
    const tail = append(manager, userMessage("the retained tail starts here"));
    const tailReply = append(manager, assistantMessage({ text: "and continues" }));
    return { manager, first, withCall, result, compaction, second, mailbox, tail, tailReply };
}

function rendered(messages: readonly unknown[]): string {
    return JSON.stringify(messages);
}

describe("stage-1 span transcript", () => {
    it("truncates exactly where compaction will keep from", () => {
        const branch = buildBranch();
        const resolved = branch.manager.buildContextEntries();
        const cut = spanContextEntries(resolved, branch.tail);

        expect(cut.cutFound).toBe(true);
        expect(cut.entries.map((entry) => entry.id)).toEqual(
            resolved.slice(0, resolved.length - 2).map((entry) => entry.id),
        );
        expect(cut.entries.some((entry) => entry.id === branch.tail)).toBe(false);
    });

    it("returns everything when the kept id is not on this path, and says so", () => {
        const branch = buildBranch();
        const resolved = branch.manager.buildContextEntries();
        const uncut = spanContextEntries(resolved, "not-an-entry");

        // The length cannot tell an uncut span from a merely long one, which is why the flag exists at all: a
        // caller that only looked at `entries` would send the retained tail again and read it back as normal.
        expect(uncut.cutFound).toBe(false);
        expect(uncut.entries).toEqual(resolved);
    });

    it("rebuilds pi's resolved context minus the retained tail, previous checkpoint included", () => {
        const branch = buildBranch();
        const resolved = branch.manager.buildContextEntries();
        const cut = spanContextEntries(resolved, branch.tail);
        const built = buildSpanSession(cut.entries, "/tmp");

        const text = rendered(built.sessionManager.buildSessionContext().messages);
        expect(text).toContain("first request");
        expect(text).toContain("file contents here");
        expect(text).toContain("earlier checkpoint");
        expect(text).toContain("second request");
        expect(text).toContain("run finished quietly");
        expect(text).not.toContain("the retained tail starts here");
        expect(text).not.toContain("and continues");
        expect(built.copiedEntries).toBe(cut.entries.length);
        expect(built.skippedEntries).toEqual({});
    });

    it("keeps the tool call and its result as real messages, not as text", () => {
        const branch = buildBranch();
        const cut = spanContextEntries(branch.manager.buildContextEntries(), branch.tail);
        const messages = buildSpanSession(cut.entries, "/tmp").sessionManager.buildSessionContext()
            .messages;

        const withCall = messages.find(
            (message) =>
                message.role === "assistant" &&
                message.content.some((block) => block.type === "toolCall"),
        );
        const result = messages.find((message) => message.role === "toolResult");
        expect(withCall).toBeDefined();
        expect(result?.role === "toolResult" && result.toolName).toBe("read");
    });

    it("reports entry types with no public append instead of failing the compaction", () => {
        const branch = buildBranch();
        const span: SessionEntry[] = branch.manager.buildContextEntries();
        // pi 0.84 has no public append for branch summaries, and labels reference parent ids.
        const withUncopyable = [
            ...span,
            {
                type: "branch_summary" as const,
                id: "bs-1",
                parentId: branch.tailReply,
                timestamp: "1970-01-01T00:00:00.000Z",
                summary: "a branch that was left behind",
                fromId: branch.first,
            },
            {
                type: "label" as const,
                id: "lb-1",
                parentId: "bs-1",
                timestamp: "1970-01-01T00:00:00.000Z",
                targetId: branch.first,
                label: "checkpoint",
            },
        ];
        const built = buildSpanSession(withUncopyable, "/tmp");

        expect(built.skippedEntries).toEqual({ branch_summary: 1, label: 1 });
        expect(skippedEntryCount(built.skippedEntries)).toBe(2);
        expect(rendered(built.sessionManager.buildSessionContext().messages)).toContain(
            "first request",
        );
    });

    it("copies plain custom entries even though they never reach the model", () => {
        const manager = SessionManager.inMemory("/tmp");
        append(manager, userMessage("visible"));
        const marker = manager.appendCustomEntry("pi-coder:scratchpad", { path: "/tmp/x" });
        const built = buildSpanSession(manager.getBranch(), "/tmp");

        expect(built.copiedEntries).toBe(2);
        expect(built.sessionManager.getEntry(marker)).toBeUndefined();
        expect(rendered(built.sessionManager.buildSessionContext().messages)).not.toContain(
            "/tmp/x",
        );
    });

    it("keeps a compaction entry that is first on the path", () => {
        const manager = SessionManager.inMemory("/tmp");
        manager.appendCompaction(
            "## Goal\n\nsolo checkpoint\n\n## Progress\n\n- [x] solo checkpoint",
            "nonexistent-entry-id",
            10,
        );
        append(manager, userMessage("after the checkpoint"));

        const built = buildSpanSession(manager.buildContextEntries(), "/tmp");
        const text = rendered(built.sessionManager.buildSessionContext().messages);

        expect(built.copiedEntries).toBe(2);
        expect(text).toContain("solo checkpoint");
        expect(text).toContain("after the checkpoint");
    });
});

describe("stage-1 window", () => {
    it("has no window start before the first fold, and no cut without a named entry", () => {
        const manager = SessionManager.inMemory("/tmp");
        append(manager, userMessage("nothing compacted yet"));
        const entries = manager.getBranch();

        expect(previousFoldWindowStart(entries)).toBeUndefined();
        expect(stageOneSpanEntries(entries, "no-such-entry").cutFound).toBe(false);
    });

    it("leaves a first fold's span untouched, which is why early folds looked clean", () => {
        const branch = buildBranch();
        const entries = branch.manager.getBranch();

        // The only compaction here keeps the very first entry, so the window cannot drop anything: hoisting runs
        // once either way and one summary is already newest-first. Folds at or beyond two are where the resolved
        // list and this window part company, which `session-fixture.test.ts` measures on a recorded session.
        expect(previousFoldWindowStart(entries)).toBe(branch.first);
        expect(stageOneSpanEntries(entries, branch.tail).entries).toEqual(
            spanContextEntries(entries, branch.tail).entries,
        );
    });
});
