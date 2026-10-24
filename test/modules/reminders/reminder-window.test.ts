import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    ITEM_CHARS,
    decisionSessionContext,
    renderSessionWindow,
    type DecisionSessionContext,
    type ReminderSignals,
} from "../../../src/modules/decision";
import { ACTIVE_ROTATION_REMINDERS } from "../../../src/modules/reminders/catalog";
import {
    REMINDER_STATE_TYPE,
    availableRotationIds,
    buildReminderSignals,
    reminderStateMarker,
} from "../../../src/modules/reminders/session-signals";
import type { ReminderId } from "../../../src/modules/reminders/types";
import {
    assistantEntry,
    branch,
    cleanupBranches,
    sessionManager,
    textPart,
    toolCall,
    toolResultEntry,
    userEntry,
    type AppendedMessage,
} from "../../helpers/session-branch";

/**
 * The conversation the reminder model is judged by - the branches the `phase` / `finishing` / `unvalidated`
 * state questions are read against - rendered as a transcript, the way the mid-run probe renders one
 * (`session-midturn.py`: `User:` / `Assistant:` lines, `Tool: name(arg)` per call).
 *
 * Each case pins that rendering to a file, beside the reminders the state gate allowed and the signals the
 * questions also read, because the window is prose: whether it carries the work the turn did is something a
 * reviewer has to read, not something an assertion should be trusted to describe. The direct assertions next to
 * each snapshot cover what a re-recorded snapshot would hide - the gate's outcome, and what the plan dropped or
 * capped.
 *
 * Two properties of the live shape decide what the cases look like. `before_agent_start` runs before the
 * prompt is persisted, so the branch is everything *before* the current turn. The branch's newest user message
 * is therefore the previous turn's request, which the request field replaces - it is dropped from the window,
 * and a user item appears there only when an older turn is in the branch.
 */

const CWD = "/repo";

interface RenderedState {
    signals: ReminderSignals;
    session: DecisionSessionContext;
    /** The offered reminders, after the state gate; their ids are also the per-reminder questions asked. */
    offered: readonly ReminderId[];
}

/** Build one state the way the reminders module does: signals and the window from the branch, then the gate. */
function stateFor(options: {
    messages: readonly AppendedMessage[];
    currentTurn?: number;
    shown?: ReadonlyMap<ReminderId, number>;
}): RenderedState {
    return stateForEntries(branch(options.messages), options);
}

/** The same, over entries built by hand, for a case that writes a recorded state into the branch. */
function stateForEntries(
    entries: SessionEntry[],
    options: { currentTurn?: number; shown?: ReadonlyMap<ReminderId, number> } = {},
): RenderedState {
    const signals = buildReminderSignals({
        entries,
        cwd: CWD,
        currentTurn: options.currentTurn ?? 2,
        contextTokens: 42_000,
        shown: options.shown ?? new Map(),
    });
    const available = availableRotationIds(signals);
    const offered = ACTIVE_ROTATION_REMINDERS.filter((reminder) => available.has(reminder.id));

    return {
        signals,
        session: decisionSessionContext(entries, { stateMarker: reminderStateMarker }),
        offered: offered.map(({ id }) => id),
    };
}

/** The view a snapshot holds: the gate's outcome, the signals, then the conversation as a transcript. */
function shownAs(state: RenderedState): string {
    const omitted = state.session.omitted ?? 0;

    return [
        `offered: ${state.offered.join(", ") || "none"}`,
        `signals: ${JSON.stringify(state.signals.session ?? {})}`,
        `conversation (${state.session.recent.length} items, ${omitted} dropped):`,
        renderSessionWindow(state.session.recent, omitted).join("\n"),
    ].join("\n");
}

afterEach(cleanupBranches);

describe("the rendered reminder conversation", () => {
    it("shows the tools a mid-turn window carries", async () => {
        const state = stateFor({
            messages: [
                userEntry("gate the validation reminder on work produced", 1),
                assistantEntry(
                    [
                        textPart("Reading the signals module first."),
                        toolCall(
                            "read",
                            { path: "src/modules/reminders/session-signals.ts" },
                            "c1",
                        ),
                    ],
                    2,
                ),
                toolResultEntry("export function availableRotationIds…", 3, "c1", "read"),
                userEntry("also cover the mid-run path", 4),
                assistantEntry(
                    [toolCall("bash", { command: "npx vitest run test/modules/reminders" }, "c2")],
                    5,
                ),
                toolResultEntry("Test Files 7 passed", 6, "c2", "bash"),
                assistantEntry(
                    [
                        textPart("The gate reads the scan, so the edit goes there."),
                        toolCall(
                            "edit",
                            {
                                path: "src/modules/reminders/session-signals.ts",
                                edits: [{ oldText: "x".repeat(400), newText: "y".repeat(400) }],
                            },
                            "c3",
                        ),
                    ],
                    7,
                ),
            ],
            currentTurn: 3,
            shown: new Map<ReminderId, number>([["delegation", 1]]),
        });

        // The edit landed after the last run, so the state reads implementing + unvalidated and the validation
        // reminder is offered; the memory reminder rides on the same recorded work.
        expect(state.offered).toEqual(["memory-hygiene", "delegation", "validation"]);
        expect(state.session.recent.map((item) => item.role)).toEqual([
            "user",
            "assistant",
            "tool",
            "command",
            "assistant",
            "tool",
        ]);
        // The turn's own ask is the request field, so the window's user item is the older turn's, and the
        // newest item is the edit: the patch it carried is gone, the file it changed is not.
        expect(state.session.request).toBe("also cover the mid-run path");
        expect(state.session.recent.at(-1)?.text).toBe(
            "edit(src/modules/reminders/session-signals.ts)",
        );
        await expect(shownAs(state)).toMatchFileSnapshot(
            "./__snapshots__/reminder-window.working.txt",
        );
    });

    it("annotates the window with the phases already accepted", async () => {
        const manager = sessionManager(CWD);
        manager.appendMessage(userEntry("gate the validation reminder on work produced", 1));
        manager.appendMessage(
            assistantEntry(
                [
                    textPart("Reading the signals first."),
                    toolCall("read", { path: "src/modules/reminders/session-signals.ts" }, "c1"),
                ],
                2,
            ),
        );
        // The state the model accepted at that point, recorded where it was accepted.
        manager.appendCustomEntry(REMINDER_STATE_TYPE, {
            phase: "exploring",
            finishing: false,
            unvalidated: false,
        });
        manager.appendMessage(
            assistantEntry(
                [toolCall("bash", { command: "npx vitest run test/modules/reminders" }, "c2")],
                3,
            ),
        );
        manager.appendCustomEntry(REMINDER_STATE_TYPE, {
            phase: "validating",
            finishing: false,
            unvalidated: false,
        });
        manager.appendMessage(
            assistantEntry(
                [
                    textPart("The gate reads the scan, so the edit goes there."),
                    toolCall(
                        "edit",
                        {
                            path: "src/modules/reminders/session-signals.ts",
                            edits: [{ oldText: "x".repeat(400), newText: "y".repeat(400) }],
                        },
                        "c3",
                    ),
                ],
                4,
            ),
        );

        const state = stateForEntries(manager.getBranch(), { currentTurn: 3 });

        // The markers are part of the item stream the model is sent, one per recorded change, in the order
        // the changes happened - the probe's `--annotate`, which is what carries the phase timeline into the
        // conversation instead of leaving it to the state's single phase field.
        expect(state.session.recent.filter((item) => item.role === "state")).toEqual([
            { role: "state", text: "── state: exploring ──" },
            { role: "state", text: "── state: validating ──" },
        ]);
        await expect(shownAs(state)).toMatchFileSnapshot(
            "./__snapshots__/reminder-window.annotated.txt",
        );
    });

    it("shows a read-only window the gate offers nothing for", async () => {
        const state = stateFor({
            messages: [
                userEntry("how does the reminder gate decide?", 1),
                assistantEntry(
                    [
                        textPart("Let me read the gate and the signals."),
                        toolCall(
                            "read",
                            { path: "src/modules/reminders/session-signals.ts" },
                            "c1",
                        ),
                    ],
                    2,
                ),
                toolResultEntry("export function availableRotationIds…", 3, "c1", "read"),
                assistantEntry(
                    [
                        toolCall(
                            "grep",
                            { pattern: "hasMutatingWork", path: "src/modules/reminders" },
                            "c2",
                        ),
                        toolCall("ask_user", { title: "Which sessions should I check?" }, "c3"),
                    ],
                    4,
                ),
            ],
        });

        // Nothing was produced, so neither the validation nor the memory reminder is offered. The grep and the
        // question still reach the window, which the bash-only window never carried.
        expect(state.offered).toEqual(["delegation"]);
        await expect(shownAs(state)).toMatchFileSnapshot(
            "./__snapshots__/reminder-window.exploring.txt",
        );
    });

    it("shows the oldest items being dropped once the window is full", async () => {
        const messages: AppendedMessage[] = [];
        for (let turn = 1; turn <= 4; turn += 1) {
            messages.push(userEntry(`request ${turn}`, turn * 2 - 1));
            messages.push(
                assistantEntry(
                    [
                        textPart(`Answer ${turn}.`),
                        toolCall(
                            "bash",
                            { command: `rg -n "step${turn}" src/modules` },
                            `c${turn}`,
                        ),
                    ],
                    turn * 2,
                ),
            );
        }

        const state = stateFor({ messages, currentTurn: 5 });

        // Eleven items and a budget for ten: the oldest request goes, the newest tool call stays, and the
        // snapshot says what was dropped rather than reading as a complete window.
        expect(state.session.recent).toHaveLength(10);
        expect(state.session.omitted).toBe(1);
        expect(state.session.recent[0]?.text).toBe("Answer 1.");
        expect(state.session.recent.at(-1)?.text).toBe(`rg -n "step4" src/modules`);
        await expect(shownAs(state)).toMatchFileSnapshot(
            "./__snapshots__/reminder-window.history.txt",
        );
    });

    it("shows one long item capped inside the window instead of dropping what it hides", async () => {
        const state = stateFor({
            messages: [
                userEntry("why did that command fail?", 1),
                assistantEntry(
                    [
                        textPart("z".repeat(900)),
                        toolCall("bash", { command: `rg -n "${"y".repeat(700)}" src/` }, "c1"),
                    ],
                    2,
                ),
            ],
        });

        const [prose, command] = state.session.recent;

        expect(state.session.recent).toHaveLength(2);
        expect(prose?.text).toHaveLength(ITEM_CHARS);
        expect(command?.text).toHaveLength(ITEM_CHARS);
        await expect(shownAs(state)).toMatchFileSnapshot(
            "./__snapshots__/reminder-window.long-echo.txt",
        );
    });
});
