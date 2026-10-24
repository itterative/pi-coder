import { describe, expect, it, vi } from "vitest";

import { isAbortError } from "../../src/common/abort";
import { SerialQueue, sleep } from "../../src/common/async";

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

describe("SerialQueue", () => {
    it("runs one task at a time, in the order they were added", async () => {
        const queue = new SerialQueue();
        const order: string[] = [];
        let release!: () => void;
        const first = queue.add(async () => {
            order.push("first:start");
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            order.push("first:end");
        });

        const second = queue.add(async () => {
            order.push("second");
        });

        // The second task has not started: the queue is one deep whatever the arrival rate.
        await Promise.resolve();
        expect(order).toEqual(["first:start"]);

        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["first:start", "first:end", "second"]);
    });

    it("settles idle for a rejected task and keeps running", async () => {
        const queue = new SerialQueue();
        const failed = queue.add(async () => {
            throw new Error("nope");
        });

        await expect(failed).rejects.toThrow("nope");
        await expect(queue.idle()).resolves.toBeUndefined();

        // A rejection must not wedge the queue: the next task still runs.
        await expect(queue.add(async () => "ran")).resolves.toBe("ran");
    });

    it("resolves idle once the tasks added so far have settled", async () => {
        const queue = new SerialQueue();
        let resolve!: () => void;
        void queue.add(
            () =>
                new Promise<void>((res) => {
                    resolve = res;
                }),
        );

        let idled = false;
        const idle = queue.idle().then(() => {
            idled = true;
        });
        await Promise.resolve();
        expect(idled).toBe(false);

        resolve();
        await idle;
        expect(idled).toBe(true);
        await expect(queue.idle()).resolves.toBeUndefined();
    });
});
