import { describe, expect, it } from "vitest";

import {
    ACTIVE_ROTATION_REMINDERS,
    COMPACTION_REMINDER,
    MEMORY_READ_REMINDER,
    ROTATION_REMINDERS,
} from "../../../src/modules/reminders/catalog";
import type { ReminderDefinition } from "../../../src/modules/reminders/types";

/**
 * The catalog and its active view: a `disabled` entry stays in the catalog (so re-enabling it is a one-line
 * change) but never reaches the rotation or the model's offer.
 */

describe("reminder catalog", () => {
    it("keeps every entry complete", () => {
        for (const reminder of ROTATION_REMINDERS) {
            expect(reminder.text.length).toBeGreaterThan(0);
            expect(reminder.guidance.length).toBeGreaterThan(0);
        }
    });

    it("filters disabled reminders out of the active rotation", () => {
        const disabled = ROTATION_REMINDERS.filter(
            (reminder: ReminderDefinition) => reminder.disabled === true,
        );
        const active = new Set(ACTIVE_ROTATION_REMINDERS.map((reminder) => reminder.id));

        expect(disabled.map((reminder) => reminder.id)).toEqual(["sandbox"]);
        expect(active.has("sandbox")).toBe(false);
        expect(ACTIVE_ROTATION_REMINDERS).toEqual(
            ROTATION_REMINDERS.filter((reminder: ReminderDefinition) => reminder.disabled !== true),
        );
    });

    it("keeps the change-point reminders out of the rotation", () => {
        const active = ACTIVE_ROTATION_REMINDERS.map((reminder) => reminder.id);

        // Session start, tree moves, and compaction arm these directly; rotating them on a cadence would
        // show them for the schedule rather than for the change that makes them relevant.
        expect(active).not.toContain("memory-read");
        expect(active).not.toContain("compaction");
        expect(MEMORY_READ_REMINDER.text.length).toBeGreaterThan(0);
        expect(COMPACTION_REMINDER.text.length).toBeGreaterThan(0);
    });
});
