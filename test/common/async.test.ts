import { describe, expect, it, vi } from "vitest";

import { isAbortError } from "../../src/common/abort";
import { sleep } from "../../src/common/async";

describe("async helpers", () => {
    it("sleeps until the timer completes", async () => {
        vi.useFakeTimers();
        try {
            const pending = sleep(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(pending).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects promptly when its signal aborts", async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            const pending = sleep(1_000, controller.signal);
            controller.abort();
            const error = await pending.catch((caught: unknown) => caught);
            expect(isAbortError(error)).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
