import { describe, expect, it } from "vitest";

import {
    ACTIVE_ROTATION_REMINDERS,
    COMPACTION_REMINDER,
    MEMORY_READ_REMINDER,
} from "../../../src/modules/reminders/catalog";
import { ReminderScheduler } from "../../../src/modules/reminders/scheduler";
import type { ReminderId } from "../../../src/modules/reminders/types";

/**
 * The deterministic schedule: the memory reminder for a changed memory list, then a rotation on a turn
 * cadence or a context-growth threshold. A model choice may replace one turn's decision, and a deliberate
 * `none` suppresses the fallback for that turn only. The activity gate narrows the rotation to the ids the
 * module allows this turn.
 */

function armed(options: {
    everyTurns: number;
    thresholdTokens: number;
    maxMidRunPerTurn?: number;
}): ReminderScheduler {
    const scheduler = new ReminderScheduler(options);
    scheduler.reset(MEMORY_READ_REMINDER);
    return scheduler;
}

const NO_TURNS = { everyTurns: 0, thresholdTokens: 0 };

describe("ReminderScheduler", () => {
    it("emits the memory reminder on the first turn after a reset", () => {
        const scheduler = armed(NO_TURNS);

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.snapshot().sessionArmed).toBe(false);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();
    });

    it("arms a restart point only with the reminder it is given", () => {
        const scheduler = armed(NO_TURNS);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();

        scheduler.reset();

        expect(scheduler.snapshot().sessionArmed).toBe(false);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();

        scheduler.reset(MEMORY_READ_REMINDER);

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
    });

    it("arms the reminder a post-compaction reset passes", () => {
        const scheduler = armed(NO_TURNS);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);

        scheduler.reset(COMPACTION_REMINDER);

        expect(scheduler.snapshot().sessionArmed).toBe(true);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(COMPACTION_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();
    });

    it("resumes the rotation pointer and the cadence origin from branch history", () => {
        // A tree move on a branch that already emitted delegation at turn 1: a navigation seeds the state
        // without arming, so the next turn is a plain rotation turn.
        const scheduler = new ReminderScheduler({ everyTurns: 1, thresholdTokens: 0 });
        scheduler.seed({ userTurns: 1, lastEmitTurn: 1, lastRotationId: "delegation" });

        expect(scheduler.snapshot()).toMatchObject({ userTurns: 1, sessionArmed: false });

        // The cadence fires, and the pointer continues after delegation rather than repeating it from the top
        // of the catalog.
        expect(scheduler.decide({ maxContextTokens: 0 })?.id).toBe("todo");
    });

    it("arms the memory reminder when a session start seeds the branch", () => {
        const scheduler = new ReminderScheduler(NO_TURNS);
        scheduler.seed({ userTurns: 2, lastEmitTurn: 2 }, MEMORY_READ_REMINDER);

        expect(scheduler.snapshot().sessionArmed).toBe(true);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
    });

    it("resumes the threshold baseline from the branch state it is seeded with", () => {
        const scheduler = new ReminderScheduler({ everyTurns: 0, thresholdTokens: 100 });
        scheduler.seed({ userTurns: 2, lastEmitTurn: 2, baselineContext: 5_000 });

        expect(scheduler.snapshot().thresholdBaseline).toBe(5_000);
        expect(scheduler.midRunDue(5_099)).toBe(false);
        expect(scheduler.midRunDue(5_100)).toBe(true);
    });

    it("does not let an unknown-context emission drop a seeded baseline", () => {
        // A reload's armed memory reminder renders before the run's usage exists, so it must not clear the
        // branch baseline and hand the cooldown back to the whole context.
        const scheduler = new ReminderScheduler(NO_TURNS);
        scheduler.seed(
            { userTurns: 2, lastEmitTurn: 2, baselineContext: 5_000 },
            MEMORY_READ_REMINDER,
        );

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.snapshot().thresholdBaseline).toBe(5_000);
    });

    it("starts the rotation pointer at zero when there is no rotation history", () => {
        const scheduler = new ReminderScheduler(NO_TURNS);
        scheduler.seed({ userTurns: 3, lastEmitTurn: 0 });

        expect(scheduler.snapshot()).toMatchObject({
            userTurns: 3,
            rotationIndex: 0,
            sessionArmed: false,
        });
    });

    it("waits everyTurns turns after the last emission before rotating", () => {
        const scheduler = armed({ everyTurns: 5, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        for (let turn = 0; turn < 4; turn += 1) {
            expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();
        }

        // The sixth turn is five turns after the memory reminder.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ACTIVE_ROTATION_REMINDERS[0]);
    });

    it("cycles the active catalog in order", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        for (const reminder of ACTIVE_ROTATION_REMINDERS) {
            expect(scheduler.decide({ maxContextTokens: 0 })).toBe(reminder);
        }

        // A full cycle wraps rather than stopping.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ACTIVE_ROTATION_REMINDERS[0]);
    });

    it("fires the threshold trigger when turns alone would not", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        // The run's first usage establishes the baseline the turn decision could not know.
        scheduler.noteContext(99);
        expect(scheduler.decide({ maxContextTokens: 99 })).toBeUndefined();
        expect(scheduler.decide({ maxContextTokens: 199 })).toBe(ACTIVE_ROTATION_REMINDERS[0]);
        expect(scheduler.decide({ maxContextTokens: 298 })).toBeUndefined();
        expect(scheduler.decide({ maxContextTokens: 299 })).toBe(ACTIVE_ROTATION_REMINDERS[1]);
    });

    it("emits only the memory reminder when both triggers are disabled", () => {
        const scheduler = armed(NO_TURNS);

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        for (let turn = 0; turn < 10; turn += 1) {
            expect(scheduler.decide({ maxContextTokens: 1_000_000 })).toBeUndefined();
        }
    });

    it("uses the model's choice and leaves the rotation after it", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: "delegation" })).toBe(
            ACTIVE_ROTATION_REMINDERS[1],
        );

        // A deterministic fallback continues after the model's pick instead of repeating it.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ACTIVE_ROTATION_REMINDERS[2]);
    });

    it("treats a deliberate none as final for that turn", () => {
        const scheduler = armed({ everyTurns: 2, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: "none" })).toBeUndefined();
        // Due by turns (3 - 1 >= 2) but the model said no.
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: "none" })).toBeUndefined();
        // No answer this turn: the fallback runs again.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ACTIVE_ROTATION_REMINDERS[0]);
    });

    it("skips a reminder the activity gate disallows", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);

        // `memory-hygiene` is first in the rotation but not available, so the rotation moves to the next
        // allowed id rather than stalling.
        const available = new Set<ReminderId>(["delegation", "todo"]);
        expect(scheduler.decide({ maxContextTokens: 0, available })).toBe(
            ACTIVE_ROTATION_REMINDERS[1],
        );
        expect(scheduler.decide({ maxContextTokens: 0, available })).toBe(
            ACTIVE_ROTATION_REMINDERS[2],
        );
    });

    it("vetoes a model pick the activity gate disallows without falling back", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);

        const available = new Set<ReminderId>(["delegation"]);
        expect(
            scheduler.decide({ maxContextTokens: 0, modelChoice: "memory-hygiene", available }),
        ).toBeUndefined();
    });

    it("emits nothing from the rotation when every reminder is disallowed", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        scheduler.noteContext(100);

        const available = new Set<ReminderId>();
        expect(scheduler.decide({ maxContextTokens: 0, available })).toBeUndefined();
        expect(scheduler.decideMidRun({ maxContextTokens: 200, available })).toBeUndefined();
    });

    it("leaves the threshold unestablished until the run's first usage", () => {
        // A turn decision renders before the run's first usage, so the context it carries is 0. That 0 must
        // not become the baseline: the whole context would then count as growth on the first tool call.
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.snapshot().thresholdBaseline).toBeUndefined();

        scheduler.noteContext(5_000);

        expect(scheduler.snapshot().thresholdBaseline).toBe(5_000);
        expect(scheduler.midRunDue(5_099)).toBe(false);
        expect(scheduler.midRunDue(5_100)).toBe(true);
    });

    it("does not move a baseline an emission already set", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });
        expect(scheduler.decide({ maxContextTokens: 5_000 })).toBe(MEMORY_READ_REMINDER);

        scheduler.noteContext(9_000);

        expect(scheduler.snapshot().thresholdBaseline).toBe(5_000);
    });

    it("reports a due mid-run threshold without deciding", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });
        scheduler.noteContext(100);

        expect(scheduler.midRunDue(199)).toBe(false);
        expect(scheduler.midRunDue(200)).toBe(true);
    });

    it("caps mid-run emissions per user turn", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100, maxMidRunPerTurn: 1 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        scheduler.noteContext(100);
        expect(scheduler.decideMidRun({ maxContextTokens: 200 })).toBe(
            ACTIVE_ROTATION_REMINDERS[0],
        );
        // Same turn, another crossing: the budget is spent.
        expect(scheduler.decideMidRun({ maxContextTokens: 300 })).toBeUndefined();

        // A new user turn gets a fresh budget.
        expect(scheduler.decide({ maxContextTokens: 200 })).toBeUndefined();
        expect(scheduler.decideMidRun({ maxContextTokens: 300 })).toBe(
            ACTIVE_ROTATION_REMINDERS[1],
        );
    });

    it("delivers the threshold mid-run even when no user turn has passed", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        scheduler.noteContext(100);
        expect(scheduler.decideMidRun({ maxContextTokens: 199 })).toBeUndefined();
        expect(scheduler.decideMidRun({ maxContextTokens: 200 })).toBe(
            ACTIVE_ROTATION_REMINDERS[0],
        );
        expect(scheduler.decideMidRun({ maxContextTokens: 299 })).toBeUndefined();
    });

    it("counts a mid-run emission against the turn cadence", () => {
        const scheduler = armed({ everyTurns: 2, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        scheduler.noteContext(100);
        expect(scheduler.decideMidRun({ maxContextTokens: 200 })).toBe(
            ACTIVE_ROTATION_REMINDERS[0],
        );

        // The next user turn starts the cadence after the mid-run emission rather than repeating it.
        expect(scheduler.decide({ maxContextTokens: 200 })).toBeUndefined();
        expect(scheduler.decide({ maxContextTokens: 200 })).toBe(ACTIVE_ROTATION_REMINDERS[1]);
    });

    it("never fires the turn-based rotation mid-run", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decideMidRun({ maxContextTokens: 1_000_000 })).toBeUndefined();
    });

    it("falls back when the model was not asked or gave no readable answer", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: undefined })).toBe(
            ACTIVE_ROTATION_REMINDERS[0],
        );
    });
});
