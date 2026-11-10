import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
    ContextThresholdTracker,
    ContextUsageReminders,
    foldContextNote,
    formatContextLine,
    readMeasuredContext,
} from "../../../src/modules/reminders/context-usage";
import {
    CONTEXT_HALF_REMINDER,
    CONTEXT_TIGHT_REMINDER,
} from "../../../src/modules/reminders/catalog";
import { countedUsage } from "../../helpers/agent-doubles";
import { createPiStub, stubContext, stubModel, stubSessionManager } from "../../helpers/pi-stub";
import {
    assistantEntry,
    cleanupBranches,
    sessionManager,
    textPart,
    toolCall,
    userEntry,
    type AppendedMessage,
} from "../../helpers/session-branch";

/**
 * The context reminders: what counts as a measured reading, the two threshold crossings, the post-fold estimate,
 * and the one-shot that carries a fold's number when the fold reminder could not. Everything here is pure or
 * branch-driven, so no provider or handler is involved.
 */

afterEach(() => {
    cleanupBranches();
});

function usage(tokens: number | null, contextWindow = 200_000, percent?: number): ContextUsage {
    return {
        tokens,
        contextWindow,
        percent: percent ?? (tokens === null ? null : (tokens / contextWindow) * 100),
    };
}

function contextFor(
    branch: readonly SessionEntry[],
    reading: ContextUsage | undefined,
    model = stubModel(),
) {
    return stubContext({
        model,
        sessionManager: stubSessionManager({ getBranch: () => [...branch] }),
        getContextUsage: () => reading,
        getSystemPrompt: () => "a system prompt",
    });
}

/** A real branch from the messages a case needs, so entries have pi's own shape. */
function branchWith(...messages: AppendedMessage[]): SessionEntry[] {
    const manager = sessionManager("/tmp/context-usage");
    for (const message of messages) {
        manager.appendMessage(message);
    }

    return manager.getBranch();
}

/** One counted reply, which is what any trust decision needs. */
function countedReply(timestamp = 1): AppendedMessage {
    return assistantEntry([textPart("continued")], timestamp, countedUsage(5_000, 120));
}

/**
 * A branch whose newest row is a fold: a counted reply, the kept user row, the fold itself, and optionally one
 * reply after it. `details` can be suppressed to model a fold written by pi's own compaction rather than ours.
 */
function foldedBranch(
    options: { model?: string; postFoldReply?: boolean; details?: boolean } = {},
): SessionEntry[] {
    const manager = sessionManager("/tmp/context-usage");
    manager.appendMessage(
        assistantEntry([toolCall("read", { path: "a.ts" }, "c1")], 1, countedUsage(5_000, 100)),
    );
    const keptId = manager.appendMessage(userEntry("keep working", 2));
    manager.appendCompaction(
        "a summary of the work so far",
        keptId,
        6_000,
        options.details === false
            ? undefined
            : { version: 1, provider: "anthropic", model: options.model ?? "stub-model" },
        false,
        countedUsage(1_500, 200),
    );

    if (options.postFoldReply === true) {
        manager.appendMessage(countedReply(3));
    }

    return manager.getBranch();
}

describe("readMeasuredContext", () => {
    it("needs both a count and a counted reply on the current basis", () => {
        expect(readMeasuredContext(contextFor([], undefined))).toBeUndefined();
        expect(readMeasuredContext(contextFor([], usage(null)))).toBeUndefined();
        // pi's own chars/4 fallback is a number, but nothing was measured, so it is not shown as one.
        expect(readMeasuredContext(contextFor([], usage(4_000)))).toBeUndefined();
    });

    it("reads a count anchored on a counted reply", () => {
        const reading = readMeasuredContext(
            contextFor(branchWith(countedReply()), usage(42_000, 200_000, 21)),
        );

        expect(reading).toEqual({ tokens: 42_000, contextWindow: 200_000, percent: 21 });
    });

    it("refuses a count the model change invalidated", () => {
        const manager = sessionManager("/tmp/context-usage");
        manager.appendMessage(countedReply(1));
        manager.appendModelChange("anthropic", "stub-model-2");

        expect(readMeasuredContext(contextFor(manager.getBranch(), usage(42_000)))).toBeUndefined();
    });

    it("refuses a count the fold invalidated, and reads one after the fold's own reply", () => {
        expect(readMeasuredContext(contextFor(foldedBranch(), usage(42_000)))).toBeUndefined();

        const afterReply = readMeasuredContext(
            contextFor(foldedBranch({ postFoldReply: true }), usage(12_000, 200_000, 6)),
        );

        expect(afterReply).toEqual({ tokens: 12_000, contextWindow: 200_000, percent: 6 });
    });

    it("refuses a count taken under the previous thinking level", () => {
        const manager = sessionManager("/tmp/context-usage");
        manager.appendMessage(countedReply(1));
        manager.appendThinkingLevelChange("high");

        expect(readMeasuredContext(contextFor(manager.getBranch(), usage(42_000)))).toBeUndefined();
    });
});

describe("formatContextLine", () => {
    it("states the used, total, percent, and free count with separators", () => {
        expect(formatContextLine({ tokens: 123_456, contextWindow: 200_000, percent: 61.7 })).toBe(
            "Measured context: 123,456 of 200,000 tokens used (62%), 76,544 free.",
        );
    });

    it("does not report negative free room", () => {
        expect(formatContextLine({ tokens: 210_000, contextWindow: 200_000, percent: 105 })).toBe(
            "Measured context: 210,000 of 200,000 tokens used (105%), 0 free.",
        );
    });
});

describe("foldContextNote", () => {
    const pi = createPiStub().pi;

    it("prefers a measured reading once a post-fold reply exists", () => {
        const note = foldContextNote(
            contextFor(foldedBranch({ postFoldReply: true }), usage(12_345, 200_000, 6.17)),
            pi,
        );

        expect(note.stated).toBe(true);
        expect(note.text).toContain(
            "Measured context after the fold: 12,345 of 200,000 tokens used (6%), 187,655 free.",
        );
        expect(note.text).toContain("no longer applies");
    });

    it("estimates from the retained rows while nothing has replied yet", () => {
        const note = foldContextNote(contextFor(foldedBranch(), undefined), pi);

        expect(note.stated).toBe(true);
        expect(note.text).toMatch(
            /Estimated context after the fold: about [\d,]+ of 200,000 tokens used \(\d+%\), [\d,]+ free\./u,
        );
        expect(note.text).toContain("no longer applies");
    });

    it("keeps the number out when the model changed, leaving the one-shot to arm", () => {
        const note = foldContextNote(
            contextFor(foldedBranch(), undefined, stubModel({ id: "other-model" })),
            pi,
        );

        expect(note.stated).toBe(false);
        expect(note.text).toContain("no longer applies");
        expect(note.text).not.toContain("Estimated context");
    });

    it("keeps the number out when a model row follows the fold", () => {
        const manager = sessionManager("/tmp/context-usage");
        manager.appendMessage(
            assistantEntry([toolCall("read", { path: "a.ts" }, "c1")], 1, countedUsage(5_000, 100)),
        );
        const keptId = manager.appendMessage(userEntry("keep working", 2));
        manager.appendCompaction(
            "a summary",
            keptId,
            6_000,
            { version: 1, provider: "anthropic", model: "other-model" },
            false,
            countedUsage(1_500, 200),
        );
        manager.appendModelChange("anthropic", "other-model");

        const note = foldContextNote(
            contextFor(manager.getBranch(), undefined, stubModel({ id: "other-model" })),
            pi,
        );

        expect(note.stated).toBe(false);
    });

    it("estimates a fold written by pi when the model matches", () => {
        const note = foldContextNote(contextFor(foldedBranch({ details: false }), undefined), pi);

        expect(note.stated).toBe(true);
        expect(note.text).toContain("Estimated context after the fold");
    });
});

describe("ContextThresholdTracker", () => {
    it("fires each threshold once, in order, and ignores the ones already passed", () => {
        const tracker = new ContextThresholdTracker();
        tracker.reset([]);

        expect(tracker.next(40)).toBeUndefined();
        expect(tracker.next(51)).toBe(CONTEXT_HALF_REMINDER);
        expect(tracker.next(60)).toBeUndefined();
        expect(tracker.next(76)).toBe(CONTEXT_TIGHT_REMINDER);
        expect(tracker.next(90)).toBeUndefined();
    });

    it("reports only the highest threshold a jump crosses", () => {
        const tracker = new ContextThresholdTracker();
        tracker.reset([]);

        expect(tracker.next(80)).toBe(CONTEXT_TIGHT_REMINDER);
        expect(tracker.next(51)).toBeUndefined();
    });

    it("rebuilds delivered thresholds from the branch", () => {
        const manager = sessionManager("/tmp/context-usage");
        manager.appendMessage(countedReply(1));
        manager.appendCustomMessageEntry("pi-coder-reminder", "shown", false, {
            id: "context-half",
            turn: 1,
        });

        const tracker = new ContextThresholdTracker();
        tracker.reset(manager.getBranch());

        expect(tracker.next(60)).toBeUndefined();
        expect(tracker.next(76)).toBe(CONTEXT_TIGHT_REMINDER);
    });

    it("resets when a fold starts a new epoch", () => {
        const manager = sessionManager("/tmp/context-usage");
        manager.appendMessage(countedReply(1));
        manager.appendCustomMessageEntry("pi-coder-reminder", "shown", false, {
            id: "context-half",
            turn: 1,
        });
        const keptId = manager.getBranch()[0]?.id;
        manager.appendCompaction("folded", keptId ?? null, 4_000);

        const tracker = new ContextThresholdTracker();
        tracker.reset(manager.getBranch());

        expect(tracker.next(51)).toBe(CONTEXT_HALF_REMINDER);
    });

    it("reads a combined message's ids, not only its newest one", () => {
        const manager = sessionManager("/tmp/context-usage");
        manager.appendMessage(countedReply(1));
        manager.appendCustomMessageEntry("pi-coder-reminder", "shown", false, {
            id: "todo",
            ids: ["context-half", "todo"],
            turn: 1,
        });

        const tracker = new ContextThresholdTracker();
        tracker.reset(manager.getBranch());

        expect(tracker.next(60)).toBeUndefined();
    });
});

describe("ContextUsageReminders", () => {
    it("delivers a crossed threshold with the measured line", () => {
        const reminders = new ContextUsageReminders();
        reminders.reset([]);

        const due = reminders.due(
            contextFor(branchWith(countedReply()), usage(102_000, 200_000, 51)),
        );

        expect(due?.reminder.id).toBe("context-half");
        expect(
            due?.text.startsWith(
                "Measured context: 102,000 of 200,000 tokens used (51%), 98,000 free.",
            ),
        ).toBe(true);
    });

    it("says nothing without a measured reading", () => {
        const reminders = new ContextUsageReminders();
        reminders.reset([]);

        expect(reminders.due(contextFor([], usage(102_000, 200_000, 51)))).toBeUndefined();
    });

    it("sends the post-fold number once and consumes the thresholds it crosses", () => {
        const reminders = new ContextUsageReminders();
        reminders.reset(foldedBranch({ postFoldReply: true }));
        reminders.awaitAfterFold();

        const due = reminders.due(
            contextFor(foldedBranch({ postFoldReply: true }), usage(152_000, 200_000, 76)),
        );

        expect(due?.reminder.id).toBe("context-after-fold");
        expect(due?.text).toContain("Measured context: 152,000 of 200,000 tokens used (76%)");
        // The same number was just stated; the 75% text must not follow on the next step.
        expect(
            reminders.due(contextFor(branchWith(countedReply()), usage(154_000, 200_000, 77))),
        ).toBeUndefined();
    });

    it("keeps the fallback pending until a reading can be trusted", () => {
        const reminders = new ContextUsageReminders();
        reminders.reset(foldedBranch());
        reminders.awaitAfterFold();

        expect(reminders.due(contextFor(foldedBranch(), usage(20_000)))).toBeUndefined();

        const due = reminders.due(
            contextFor(foldedBranch({ postFoldReply: true }), usage(20_000, 200_000, 10)),
        );

        expect(due?.reminder.id).toBe("context-after-fold");
    });
});
