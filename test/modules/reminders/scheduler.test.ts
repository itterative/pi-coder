import { describe, expect, it } from "vitest";

import { MEMORY_READ_REMINDER, ROTATION_REMINDERS } from "../../../src/modules/reminders/catalog";
import { ReminderScheduler } from "../../../src/modules/reminders/scheduler";

/**
 * The deterministic schedule: the memory reminder for a changed memory list, then a rotation on a turn
 * cadence or a context-growth threshold. A model choice may replace one turn's decision, and a deliberate
 * `none` suppresses the fallback for that turn only.
 */

function armed(options: { everyTurns: number; thresholdTokens: number }): ReminderScheduler {
    const scheduler = new ReminderScheduler(options);
    scheduler.reset();
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

    it("re-arms the memory reminder on every reset", () => {
        const scheduler = armed(NO_TURNS);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();

        scheduler.reset();

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
    });

    it("waits everyTurns turns after the last emission before rotating", () => {
        const scheduler = armed({ everyTurns: 5, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        for (let turn = 0; turn < 4; turn += 1) {
            expect(scheduler.decide({ maxContextTokens: 0 })).toBeUndefined();
        }

        // The sixth turn is five turns after the memory reminder.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ROTATION_REMINDERS[0]);
    });

    it("cycles the catalog in order", () => {
        const scheduler = armed({ everyTurns: 1, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        for (const reminder of ROTATION_REMINDERS) {
            expect(scheduler.decide({ maxContextTokens: 0 })).toBe(reminder);
        }

        // A full cycle wraps rather than stopping.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ROTATION_REMINDERS[0]);
    });

    it("fires the threshold trigger when turns alone would not", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 99 })).toBeUndefined();
        expect(scheduler.decide({ maxContextTokens: 100 })).toBe(ROTATION_REMINDERS[0]);
        expect(scheduler.decide({ maxContextTokens: 199 })).toBeUndefined();
        expect(scheduler.decide({ maxContextTokens: 200 })).toBe(ROTATION_REMINDERS[1]);
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
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: "sandbox" })).toBe(
            ROTATION_REMINDERS[1],
        );

        // A deterministic fallback continues after the model's pick instead of repeating it.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ROTATION_REMINDERS[2]);
    });

    it("treats a deliberate none as final for that turn", () => {
        const scheduler = armed({ everyTurns: 2, thresholdTokens: 0 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: "none" })).toBeUndefined();
        // Due by turns (3 - 1 >= 2) but the model said no.
        expect(scheduler.decide({ maxContextTokens: 0, modelChoice: "none" })).toBeUndefined();
        // No answer this turn: the fallback runs again.
        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(ROTATION_REMINDERS[0]);
    });

    it("delivers the threshold mid-run even when no user turn has passed", () => {
        const scheduler = armed({ everyTurns: 0, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decideMidRun({ maxContextTokens: 99 })).toBeUndefined();
        expect(scheduler.decideMidRun({ maxContextTokens: 100 })).toBe(ROTATION_REMINDERS[0]);
        expect(scheduler.decideMidRun({ maxContextTokens: 199 })).toBeUndefined();
    });

    it("counts a mid-run emission against the turn cadence", () => {
        const scheduler = armed({ everyTurns: 2, thresholdTokens: 100 });

        expect(scheduler.decide({ maxContextTokens: 0 })).toBe(MEMORY_READ_REMINDER);
        expect(scheduler.decideMidRun({ maxContextTokens: 100 })).toBe(ROTATION_REMINDERS[0]);

        // The next user turn starts the cadence after the mid-run emission rather than repeating it.
        expect(scheduler.decide({ maxContextTokens: 100 })).toBeUndefined();
        expect(scheduler.decide({ maxContextTokens: 100 })).toBe(ROTATION_REMINDERS[1]);
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
            ROTATION_REMINDERS[0],
        );
    });
});
