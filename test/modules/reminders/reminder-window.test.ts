import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    ITEM_CHARS,
    allocationText,
    decisionSessionContext,
    reminderConversationAtoms,
    selectWindow,
    WINDOW_POLICY_REMINDER,
    type DecisionSessionContext,
    type ReminderSignals,
    type SessionWindow,
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
 * The conversation the tier-2 reminder-selection ask is judged by - the one `conversation` field it sends -
 * rendered as the model reads it, with the allocator's own role prefixes and omission line
 * (`session-midturn.py`: `User:` / `Assistant:` lines, `Tool: name(arg)` per call).
 *
 * Each case pins that rendering to a file, beside the reminders the state gate allowed and the signals the
 * gate was built from, because the window is prose: whether it carries the work the turn did is something a
 * reviewer has to read, not something an assertion should be trusted to describe. The direct assertions next to
 * each snapshot cover what a re-recorded snapshot would hide - the gate's outcome, and what the allocator
 * dropped or capped.
 *
 * Two properties of the live shape decide what the cases look like. A rotation pick happens **mid-run**, inside
 * a user turn, so the branch already carries that turn's request and the work done since it - which is why
 * these fixtures need no appended request item, and why the conversation holds every item of the walk rather
 * than the planner's window that dropped the ask. And the budget is 2000 chars of item text, so an overflow
 * case has to be long in content, not merely long in items.
 */

const CWD = "/repo";

interface RenderedState {
    signals: ReminderSignals;
    session: DecisionSessionContext;
    /** The offered reminders, after the state gate; their ids are also the per-reminder questions asked. */
    offered: readonly ReminderId[];
    /** The tier-2 state: the conversation exactly as it is sent, omission line included. */
    conversation: string;
    /** The items behind it, so a case can assert what was kept and what was dropped. */
    window: SessionWindow;
}

/** Build one state the way the reminders module does: signals and items from the branch, then the gate. */
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

    // The consult's own read: every item of the branch walk through the reminder policy. The fixtures model a
    // branch that already carries the turn's request, so `reminderConversationAtoms` would append nothing - it
    // is what the live `before_agent_start` path does with a prompt pi has not persisted yet.
    const session = decisionSessionContext(entries, { stateMarker: reminderStateMarker });
    const selection = selectWindow(
        reminderConversationAtoms(session.items, session.request, session.request),
        WINDOW_POLICY_REMINDER,
    );

    return {
        signals,
        session,
        offered: offered.map(({ id }) => id),
        conversation: selection.lines.join("\n"),
        window: {
            items: selection.kept.map((allocation) => ({
                role: allocation.item.role,
                text: allocationText(allocation),
            })),
            omitted: selection.omitted,
        },
    };
}

/** The view a snapshot holds: the gate's outcome, the signals, then the conversation as it was sent. */
function shownAs(state: RenderedState): string {
    return [
        `offered: ${state.offered.join(", ") || "none"}`,
        `signals: ${JSON.stringify(state.signals.session ?? {})}`,
        `conversation (${String(state.window.items.length)} items, ${String(state.window.omitted)} dropped):`,
        state.conversation,
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
        expect(state.window.items.map((item) => item.role)).toEqual([
            "user",
            "assistant",
            "tool",
            "user",
            "command",
            "assistant",
            "tool",
        ]);
        // Every item of the walk is a candidate now, both turns' asks included, and the newest one is the edit:
        // the patch it carried is gone, the file it changed is not.
        expect(state.session.request).toBe("also cover the mid-run path");
        expect(state.window.omitted).toBe(0);
        expect(state.window.items.at(-1)?.text).toBe(
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

        // The markers are items of the conversation, one per recorded change, in the order the changes
        // happened - the probe's `--annotate`, which is what carries the phase timeline into the conversation
        // instead of leaving it to the state's single phase field.
        expect(state.window.items.filter((item) => item.role === "state")).toEqual([
            { role: "state", text: "State: *exploring*" },
            { role: "state", text: "State: *validating*" },
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

    it("shows the oldest items being dropped once the conversation is full", async () => {
        const messages: AppendedMessage[] = [];
        for (let turn = 1; turn <= 4; turn += 1) {
            messages.push(userEntry(`request ${turn}`, turn * 2 - 1));
            messages.push(
                assistantEntry(
                    [
                        textPart(`Answer ${turn}. ${"checking the reminder gate. ".repeat(20)}`),
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

        // Every item would cost more than the 2000-char budget, so the four oldest go - which is the oldest
        // turn's messages, while its one-line command is cheap enough to stay: the snapshot says what was
        // dropped rather than reading as a complete window.
        expect(state.window.omitted).toBeGreaterThan(0);
        expect(state.conversation.split("\n")[0]).toMatch(/^… \d+ earlier items omitted …$/u);
        expect(state.window.items.at(-1)?.text).toBe(`rg -n "step4" src/modules`);
        expect(state.window.items.map((item) => item.role).slice(0, 2)).toEqual([
            "command",
            "command",
        ]);
        // The cap is on the item's text, so a long answer is drawn at 240 chars rather than crowding the rest
        // of the window out.
        for (const item of state.window.items) {
            expect(item.text.length).toBeLessThanOrEqual(ITEM_CHARS);
        }
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

        const [ask, prose, command] = state.window.items;

        // Three items, all of them kept: the budget is what an item costs in total, and two capped lines fit
        // it easily, so a long echo is drawn down rather than dropped.
        expect(state.window.items).toHaveLength(3);
        expect(state.window.omitted).toBe(0);
        expect(prose?.role).toBe("assistant");
        expect(command?.role).toBe("command");
        expect(prose?.text).toHaveLength(ITEM_CHARS);
        expect(command?.text).toHaveLength(ITEM_CHARS);
        expect(ask?.text).toBe("why did that command fail?");
        await expect(shownAs(state)).toMatchFileSnapshot(
            "./__snapshots__/reminder-window.long-echo.txt",
        );
    });
});
