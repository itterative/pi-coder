import { afterEach, describe, expect, it } from "vitest";

import {
    OUTLINE_COOLDOWN_TURNS,
    OUTLINE_OUTPUT_CHARS,
    OUTLINE_QUIET_CALLS,
    OutlineNudgeTracker,
    commandText,
    isSearchCall,
    outlineUsageFromEntries,
    summarizeToolOutput,
    toolCallsOf,
} from "../../../src/modules/reminders/outline-nudge";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    toolCall,
} from "../../helpers/session-branch";

/**
 * The outline nudge: searches without `outline` are the trigger, a recent `outline` call and a turn cooldown
 * are the quieting rules, and the branch is where a restart reads both back from.
 */

afterEach(() => {
    cleanupBranches();
});

/** A step's calls from names and commands, which is the shape the assistant message produces. */
function calls(...specs: Array<string | { command: string }>): ReturnType<typeof toolCallsOf> {
    return specs.map((spec) =>
        typeof spec === "string"
            ? { name: spec }
            : { name: "bash", arguments: { command: spec.command } },
    );
}

const search = { command: 'rg -n "symbol" src' };

describe("search classification", () => {
    it("counts the grep tool and shell search commands", () => {
        expect(isSearchCall({ name: "grep" })).toBe(true);
        expect(isSearchCall({ name: "bash", arguments: search })).toBe(true);
        expect(
            isSearchCall({ name: "bash", arguments: { command: "cd src && grep -rn foo ." } }),
        ).toBe(true);
        expect(isSearchCall({ name: "bash", arguments: { command: "git grep -n foo" } })).toBe(
            true,
        );
        expect(isSearchCall({ name: "bash", arguments: { command: "FOO=1 rg foo ." } })).toBe(true);
        expect(isSearchCall({ name: "bash", arguments: { command: "/usr/bin/rg foo ." } })).toBe(
            true,
        );
    });

    it("does not count file listing, prose commands, or a quoted search", () => {
        expect(isSearchCall({ name: "find" })).toBe(false);
        expect(isSearchCall({ name: "ls" })).toBe(false);
        expect(isSearchCall({ name: "read" })).toBe(false);
        expect(isSearchCall({ name: "bash", arguments: { command: "ls src" } })).toBe(false);
        expect(isSearchCall({ name: "bash", arguments: { command: "rg --files src" } })).toBe(
            false,
        );
        expect(isSearchCall({ name: "bash", arguments: { command: "echo 'rg foo'" } })).toBe(false);
        expect(isSearchCall({ name: "outline", arguments: { action: "search" } })).toBe(false);
    });

    it("does not count a search that filters another command's output", () => {
        expect(
            isSearchCall({
                name: "bash",
                arguments: { command: 'npx vitest run x 2>&1 | rg -n "×|Tests" | head -20' },
            }),
        ).toBe(false);

        // A real search on the left of a pipe still counts; the pipe only disqualifies its right side.
        expect(
            isSearchCall({ name: "bash", arguments: { command: 'rg -n "×" src | head -20' } }),
        ).toBe(true);
        expect(
            isSearchCall({
                name: "bash",
                arguments: { command: "cat log | grep error; rg symbol src" },
            }),
        ).toBe(true);
    });

    it("does not count a search inside a heredoc body", () => {
        expect(
            isSearchCall({
                name: "bash",
                arguments: { command: "cat > fixture.sh <<'EOF'\nrg -n foo src\nEOF" },
            }),
        ).toBe(false);

        // The body is skipped, not the rest of the command.
        expect(
            isSearchCall({
                name: "bash",
                arguments: { command: "cat > fixture.sh <<'EOF'\nrg foo\nEOF\nrg bar src" },
            }),
        ).toBe(true);
    });

    it("reads tool calls off an assistant message in order", () => {
        const content = [
            { type: "text", text: "searching" },
            toolCall("bash", { command: "rg a" }, "c1"),
            toolCall("outline", { action: "digest" }, "c2"),
        ];

        expect(toolCallsOf(content)).toEqual([
            { id: "c1", name: "bash", arguments: { command: "rg a" } },
            { id: "c2", name: "outline", arguments: { action: "digest" } },
        ]);
    });

    it("renders a triggering command in the conversation's vocabulary", () => {
        expect(commandText({ name: "bash", arguments: { command: "rg foo src" } })).toBe(
            "rg foo src",
        );
        expect(commandText({ name: "read", arguments: { path: "src/a.ts" } })).toBe(
            "read(src/a.ts)",
        );
        expect(commandText({ name: "grep", arguments: { pattern: "foo" } })).toBe("grep(foo)");
    });

    it("summarizes a tool result with a bounded head", () => {
        const text = Array.from({ length: 50 }, (_, index) => `line ${String(index)}`).join("\n");
        const summary = summarizeToolOutput([{ type: "text", text }]);

        expect(summary.startsWith("[50 lines,")).toBe(true);
        expect(summary).toContain("line 0");
        expect(summary.length).toBeLessThanOrEqual(OUTLINE_OUTPUT_CHARS);
        expect(summarizeToolOutput([])).toBe("no output");
    });
});

describe("OutlineNudgeTracker", () => {
    it("nudges once the step crosses two searches without outline", () => {
        const tracker = new OutlineNudgeTracker();

        expect(tracker.noteStep(calls(search), 1)).toBe(false);
        expect(tracker.noteStep(calls(search), 1)).toBe(true);
    });

    it("resets the count on an outline call", () => {
        const tracker = new OutlineNudgeTracker({ quietCalls: 0, cooldownTurns: 0 });

        expect(tracker.noteStep(calls(search, search), 1)).toBe(true);
        expect(tracker.noteStep(calls("outline"), 2)).toBe(false);
        expect(tracker.noteStep(calls(search), 2)).toBe(false);
        expect(tracker.noteStep(calls(search), 3)).toBe(true);
    });

    it("suppresses the nudge while the outline call is recent", () => {
        const tracker = new OutlineNudgeTracker();

        // Two searches right after `outline` are not a reason to explain the tool the model just used.
        expect(tracker.noteStep(calls("outline", search, search), 1)).toBe(false);
        expect(tracker.snapshot()).toMatchObject({
            searchesSinceOutline: 2,
            callsSinceOutline: 2,
            outlineCalls: 1,
        });

        // Fill the quiet window without searching, then search once more: the tool is far enough away now.
        for (let call = 0; call < OUTLINE_QUIET_CALLS - 2; call += 1) {
            tracker.noteStep(calls("read"), 2);
        }
        expect(tracker.noteStep(calls(search), 3)).toBe(true);
    });

    it("waits out the turn cooldown after a nudge", () => {
        const tracker = new OutlineNudgeTracker();
        expect(tracker.noteStep(calls(search, search), 1)).toBe(true);

        for (let turn = 1; turn < OUTLINE_COOLDOWN_TURNS + 1; turn += 1) {
            expect(tracker.noteStep(calls(search), turn)).toBe(false);
        }

        expect(tracker.noteStep(calls(search), OUTLINE_COOLDOWN_TURNS + 1)).toBe(true);
    });

    it("seeds from the branch and takes its cooldown anchor from the delivered nudge", () => {
        const manager = sessionManager("/repo");
        manager.appendMessage(assistantEntry([toolCall("bash", { command: "rg a" }, "c1")], 1));
        manager.appendMessage(assistantEntry([toolCall("outline", { action: "digest" }, "c2")], 2));
        manager.appendMessage(assistantEntry([toolCall("bash", { command: "rg b" }, "c3")], 3));
        // A combined message records every id it carried, so the nudge can be one of several.
        manager.appendCustomMessageEntry(
            "pi-coder-reminder",
            "<pi_coder_reminder>outline</pi_coder_reminder>",
            false,
            { id: "context-half", ids: ["context-half", "outline"], turn: 4 },
        );
        manager.appendMessage(
            assistantEntry([toolCall("bash", { command: "grep -n c" }, "c4")], 5),
        );

        const usage = outlineUsageFromEntries(manager.getBranch());
        expect(usage).toEqual({
            searchesSinceOutline: 2,
            callsSinceOutline: 2,
            outlineCalls: 1,
            lastNudgeTurn: 4,
        });

        const tracker = new OutlineNudgeTracker({ quietCalls: 0 });
        tracker.seed(usage);
        expect(tracker.noteStep(calls(search), 4)).toBe(false);
        expect(tracker.noteStep(calls(search), 12)).toBe(true);
    });

    it("starts an empty epoch when the branch holds no outline use or nudge", () => {
        const manager = sessionManager("/repo");
        manager.appendMessage(assistantEntry([toolCall("bash", { command: "rg a" }, "c1")], 1));

        expect(outlineUsageFromEntries(manager.getBranch())).toEqual({
            searchesSinceOutline: 1,
            callsSinceOutline: 1,
            outlineCalls: 0,
        });
    });
});
