import { describe, expect, it } from "vitest";

import { TUI_DIALOG_EVENT, withDialogQueue } from "../src/tui/dialog-queue";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("shared dialog queue", () => {
    it("serializes dialogs in arrival order", async () => {
        const firstDone = deferred();
        const started: string[] = [];
        const first = withDialogQueue(undefined, async () => {
            started.push("first");
            await firstDone.promise;
            return 1;
        });
        const second = withDialogQueue(undefined, async () => {
            started.push("second");
            return 2;
        });

        for (let index = 0; index < 4; index++) await Promise.resolve();
        expect(started).toEqual(["first"]);
        firstDone.resolve();

        await expect(first).resolves.toBe(1);
        await expect(second).resolves.toBe(2);
        expect(started).toEqual(["first", "second"]);
    });

    it("emits dialog lifecycle events", async () => {
        const states: boolean[] = [];
        const events = {
            emit(channel: string, data: unknown) {
                if (channel === TUI_DIALOG_EVENT && typeof data === "object" && data !== null) {
                    states.push((data as { active: boolean }).active);
                }
            },
            on() {
                return () => {};
            },
        } as any;

        await expect(withDialogQueue(undefined, async () => "done", events)).resolves.toBe("done");
        expect(states).toEqual([true, false]);
    });

    it("keeps the dialog active event across queued dialogs on one bus", async () => {
        const firstDone = deferred();
        const states: boolean[] = [];
        const events = {
            emit(channel: string, data: unknown) {
                if (channel === TUI_DIALOG_EVENT && typeof data === "object" && data !== null) {
                    states.push((data as { active: boolean }).active);
                }
            },
            on() {
                return () => {};
            },
        } as any;

        const first = withDialogQueue(
            undefined,
            async () => {
                await firstDone.promise;
                return "first";
            },
            events,
        );
        const second = withDialogQueue(undefined, async () => "second", events);

        for (let index = 0; index < 4; index++) await Promise.resolve();
        firstDone.resolve();
        await expect(first).resolves.toBe("first");
        await expect(second).resolves.toBe("second");
        expect(states).toEqual([true, false]);
    });

    it("removes an aborted waiter without allowing later dialogs to overtake", async () => {
        const firstDone = deferred();
        const started: string[] = [];
        const first = withDialogQueue(undefined, async () => {
            started.push("first");
            await firstDone.promise;
            return "first";
        });
        const controller = new AbortController();
        const aborted = withDialogQueue(controller.signal, async () => {
            started.push("aborted");
            return "aborted";
        });
        const third = withDialogQueue(undefined, async () => {
            started.push("third");
            return "third";
        });

        for (let index = 0; index < 4; index++) await Promise.resolve();
        controller.abort();
        await expect(aborted).resolves.toBeUndefined();
        expect(started).toEqual(["first"]);

        firstDone.resolve();
        await expect(first).resolves.toBe("first");
        await expect(third).resolves.toBe("third");
        expect(started).toEqual(["first", "third"]);
    });
});
