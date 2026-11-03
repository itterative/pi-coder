import { describe, expect, it } from "vitest";

import {
    CONSECUTIVE_FAILURES_BEFORE_COOLDOWN,
    FailureCooldown,
} from "../../../src/modules/decision";

/** Fail `times` requests in a row, so a test reads as the streak rather than a loop. */
function failTimes(cooldown: FailureCooldown, times: number, cooldownMs = 1000): void {
    for (let attempt = 0; attempt < times; attempt++) {
        cooldown.failed(cooldownMs);
    }
}

describe("FailureCooldown", () => {
    it("stays closed after a single failure", () => {
        const clock = { t: 0 };
        const cooldown = new FailureCooldown(() => clock.t);

        cooldown.failed(1000);

        expect(cooldown.active).toBe(false);
    });

    it("opens after the configured streak and expires on the clock", () => {
        const clock = { t: 0 };
        const cooldown = new FailureCooldown(() => clock.t);

        failTimes(cooldown, CONSECUTIVE_FAILURES_BEFORE_COOLDOWN);
        expect(cooldown.active).toBe(true);

        clock.t = 1000;
        expect(cooldown.active).toBe(false);
    });

    it("restarts the streak when the endpoint answers", () => {
        const clock = { t: 0 };
        const cooldown = new FailureCooldown(() => clock.t);

        failTimes(cooldown, CONSECUTIVE_FAILURES_BEFORE_COOLDOWN - 1);
        cooldown.answered();
        failTimes(cooldown, CONSECUTIVE_FAILURES_BEFORE_COOLDOWN - 1);

        expect(cooldown.active).toBe(false);
    });

    it("needs a fresh streak after the cooldown expires", () => {
        const clock = { t: 0 };
        const cooldown = new FailureCooldown(() => clock.t);

        failTimes(cooldown, CONSECUTIVE_FAILURES_BEFORE_COOLDOWN);
        clock.t = 1000;
        cooldown.failed(1000);

        expect(cooldown.active).toBe(false);
    });

    it("accepts a threshold for a caller that wants a longer run", () => {
        const clock = { t: 0 };
        const cooldown = new FailureCooldown(() => clock.t, 3);

        failTimes(cooldown, 2);
        expect(cooldown.active).toBe(false);

        cooldown.failed(1000);
        expect(cooldown.active).toBe(true);
    });
});
