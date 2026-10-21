import { describe, expect, it } from "vitest";

import {
    loadReminderSettings,
    reminderDebugEnabled,
} from "../../../src/modules/reminders/settings";

/**
 * The settings surface. `debug` is deliberately on by default for now: the decision entry is the only record
 * of the state a selection was made from, and it cannot be captured after the session has already run. These
 * assertions pin that temporary default so flipping it back to opt-in is a deliberate change, not an accident.
 */
describe("reminder settings", () => {
    it("records selection decisions by default", () => {
        expect(loadReminderSettings({}).debug).toBe(true);
    });

    it("ignores the debug switch while the default is on", () => {
        expect(reminderDebugEnabled("false")).toBe(true);
    });
});
