import { describe, expect, it, vi } from "vitest";

import { ContainerSessionError } from "../../../src/modules/sandbox/container/client";
import { idleRefresh, type IdlePass } from "../../../src/tools/code/semantic/idle-refresh";
import { stubContext } from "../../helpers/pi-stub";

const ctx = stubContext();

/** A pass whose failure the caller can trigger, standing in for one that reaches a closed container. */
function failingPass(error: unknown): IdlePass {
    return async () => {
        throw error;
    };
}

/** A pass that never settles on its own and rejects the way a container call does once its session closes. */
function sessionPass(): IdlePass {
    return (_ctx, signal) =>
        new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
                "abort",
                () =>
                    reject(
                        new ContainerSessionError("container session closed", "container-exited"),
                    ),
                { once: true },
            );
        });
}

/** A pass that counts its runs. */
function countingPass(): { pass: IdlePass; runs: () => number } {
    let runs = 0;

    return {
        pass: async () => {
            runs += 1;
        },
        runs: () => runs,
    };
}

describe("idle refresh lifecycle", () => {
    it("absorbs the rejection a closed container raises, instead of taking the process down", async () => {
        // The reported bug: an in-flight scan survived its session's container, `stat` threw with
        // `kind: "container-exited"`, and the detached pass turned that into an uncaughtException.
        const failures: unknown[] = [];
        const refresh = idleRefresh({
            pass: failingPass(
                new ContainerSessionError("container session is closed", "container-exited"),
            ),
            onFailure: (_ctx, error) => failures.push(error),
        });

        await expect(refresh.run(ctx)).resolves.toBeUndefined();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ kind: "container-exited" });
    });

    it("reports a pass it stopped as nothing at all", async () => {
        const failures: unknown[] = [];
        const started = Promise.withResolvers<void>();
        const pass: IdlePass = (inner, signal) => {
            started.resolve();

            return sessionPass()(inner, signal);
        };
        const refresh = idleRefresh({ pass, onFailure: (_ctx, error) => failures.push(error) });

        const running = refresh.run(ctx);

        await started.promise;
        refresh.stop();

        await expect(running).resolves.toBeUndefined();
        expect(failures).toHaveLength(0);
    });

    it("still settles when reporting a failure throws, as it can after the session is gone", async () => {
        const refresh = idleRefresh({
            pass: failingPass(new Error("index manifest is unreadable")),
            onFailure: () => {
                throw new Error("the UI has no session");
            },
        });

        await expect(refresh.run(ctx)).resolves.toBeUndefined();
    });

    it("does not wedge the next pass when one fails", async () => {
        let attempt = 0;
        const failures: unknown[] = [];
        const refresh = idleRefresh({
            pass: async () => {
                attempt += 1;

                if (attempt === 1) {
                    throw new Error("first pass fails");
                }
            },
            onFailure: (_ctx, error) => failures.push(error),
        });

        await refresh.run(ctx);
        await refresh.run(ctx);

        expect(attempt).toBe(2);
        expect(failures).toHaveLength(1);
    });

    it("ignores a pass requested while one is already running", async () => {
        const { pass, runs } = countingPass();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const refresh = idleRefresh({
            pass: async (inner, signal) => {
                started.resolve();
                await release.promise;

                return pass(inner, signal);
            },
            onFailure: () => undefined,
        });

        const first = refresh.run(ctx);

        await started.promise;
        await refresh.run(ctx);
        release.resolve();
        await first;

        expect(runs()).toBe(1);
    });
});

describe("idle refresh timer", () => {
    it("runs one pass after the delay", async () => {
        vi.useFakeTimers();

        try {
            const { pass, runs } = countingPass();
            const refresh = idleRefresh({ pass, onFailure: () => undefined, delayMs: 1_000 });

            refresh.arm(ctx);
            expect(runs()).toBe(0);

            await vi.advanceTimersByTimeAsync(999);
            expect(runs()).toBe(0);

            await vi.advanceTimersByTimeAsync(1);
            expect(runs()).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("disarms an armed pass, and re-arming restarts the delay", async () => {
        vi.useFakeTimers();

        try {
            const { pass, runs } = countingPass();
            const refresh = idleRefresh({ pass, onFailure: () => undefined, delayMs: 1_000 });

            refresh.arm(ctx);
            await vi.advanceTimersByTimeAsync(900);
            refresh.arm(ctx);
            refresh.cancel();

            await vi.advanceTimersByTimeAsync(5_000);
            expect(runs()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("disarms the timer on stop as well", async () => {
        vi.useFakeTimers();

        try {
            const { pass, runs } = countingPass();
            const refresh = idleRefresh({ pass, onFailure: () => undefined, delayMs: 1_000 });

            refresh.arm(ctx);
            refresh.stop();

            await vi.advanceTimersByTimeAsync(5_000);
            expect(runs()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
