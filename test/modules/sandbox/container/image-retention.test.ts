import { describe, expect, it } from "vitest";

import type { ImageStore } from "../../../../src/modules/sandbox/container/image";
import {
    KEEP_SANDBOX_IMAGES,
    normalizeImageId,
    planRetention,
    pruneSandboxImages,
} from "../../../../src/modules/sandbox/container/image-retention";

const STAMP = "2025-02-09 12:34:56.123456789 +0000 UTC";

function image(id: string, day: number, reference = `localhost/pi-coder-sandbox:${id}`) {
    const created = `2025-02-${String(day).padStart(2, "0")} 12:00:00.000000000 +0000 UTC`;

    return { id, reference, created };
}

describe("planRetention", () => {
    it("keeps the configured number of newest images and removes the rest, oldest first", () => {
        const plan = planRetention({
            images: [image("cccccccccccc", 3), image("aaaaaaaaaaaa", 1), image("bbbbbbbbbbbb", 2)],
            inUse: [],
            keep: 2,
        });

        expect(plan.keep.map((entry) => entry.id)).toEqual(["cccccccccccc", "bbbbbbbbbbbb"]);
        expect(plan.remove.map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa"]);
    });

    it("defaults to three images", () => {
        const images = [5, 4, 3, 2, 1].map((day) => image(`id${day}00000000`, day));

        expect(planRetention({ images, inUse: [], keep: KEEP_SANDBOX_IMAGES }).remove).toHaveLength(
            2,
        );
    });

    it("never removes an image a container references, however old", () => {
        const plan = planRetention({
            images: [image("cccccccccccc", 3), image("aaaaaaaaaaaa", 1)],
            inUse: ["aaaaaaaaaaaa"],
            keep: 1,
        });

        expect(plan.keep.map((entry) => entry.id)).toEqual(["cccccccccccc", "aaaaaaaaaaaa"]);
        expect(plan.remove).toEqual([]);
    });

    it("keeps an older image pinned by a stopped container, so the whole set stays at the budget", () => {
        const plan = planRetention({
            images: [image("dddddddddddd", 4), image("cccccccccccc", 3), image("aaaaaaaaaaaa", 1)],
            inUse: ["aaaaaaaaaaaa"],
            keep: 2,
        });

        expect(plan.keep.map((entry) => entry.id)).toEqual([
            "dddddddddddd",
            "cccccccccccc",
            "aaaaaaaaaaaa",
        ]);
        expect(plan.remove).toEqual([]);
    });

    it("matches an in-use full ID against the short ID a listing prints", () => {
        const fullId = "aaaaaaaaaaaa0000000000000000000000000000000000000000000000000000";
        const plan = planRetention({
            images: [image("bbbbbbbbbbbb", 2), image("aaaaaaaaaaaa", 1)],
            inUse: [fullId],
            keep: 1,
        });

        expect(plan.remove).toEqual([]);
    });

    it("never removes the reference it was told to protect", () => {
        const plan = planRetention({
            images: [image("bbbbbbbbbbbb", 2), image("aaaaaaaaaaaa", 1)],
            inUse: [],
            keep: 1,
            protect: ["localhost/pi-coder-sandbox:aaaaaaaaaaaa"],
        });

        expect(plan.keep.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
        expect(plan.remove).toEqual([]);
    });

    it("orders equal or unparseable stamps by ID, so the choice does not depend on listing order", () => {
        const first = planRetention({
            images: [image("bbbbbbbbbbbb", 1), image("aaaaaaaaaaaa", 1)],
            inUse: [],
            keep: 1,
        });
        const second = planRetention({
            images: [image("aaaaaaaaaaaa", 1), image("bbbbbbbbbbbb", 1)],
            inUse: [],
            keep: 1,
        });
        const unparseable = planRetention({
            images: [
                { id: "cccccccccccc", reference: "localhost/pi-coder-sandbox:c", created: "?" },
                { id: "dddddddddddd", reference: "localhost/pi-coder-sandbox:d", created: "!" },
            ],
            inUse: [],
            keep: 1,
        });

        expect(first.remove).toEqual(second.remove);
        expect(unparseable.remove.map((entry) => entry.id)).toEqual(["dddddddddddd"]);
    });

    it("removes everything unpinned when the budget is zero", () => {
        const plan = planRetention({
            images: [image("aaaaaaaaaaaa", 1), image("bbbbbbbbbbbb", 2)],
            inUse: [],
            keep: 0,
        });

        expect(plan.keep).toEqual([]);
        expect(plan.remove).toHaveLength(2);
    });
});

describe("pruneSandboxImages", () => {
    function fakeStore(overrides: Partial<ImageStore> = {}): ImageStore & {
        removed: string[][];
    } {
        const removed: string[][] = [];
        const store = {
            removed,
            async listSandboxImages() {
                return [
                    image("cccccccccccc", 3),
                    image("bbbbbbbbbbbb", 2),
                    image("aaaaaaaaaaaa", 1),
                ];
            },
            async containersInUse() {
                return [];
            },
            async removeImages(ids: readonly string[]) {
                removed.push([...ids]);
            },
            ...overrides,
        };

        return store;
    }

    it("removes only what the plan selected", async () => {
        const store = fakeStore();
        const result = await pruneSandboxImages({ store, keep: 2 });

        expect(result.removed).toEqual(["localhost/pi-coder-sandbox:aaaaaaaaaaaa"]);
        expect(store.removed).toEqual([["aaaaaaaaaaaa"]]);
    });

    it("asks podman nothing when the set already fits", async () => {
        let inUseCalls = 0;
        const store = fakeStore({
            async containersInUse() {
                inUseCalls += 1;

                return [];
            },
        });

        await expect(pruneSandboxImages({ store, keep: 3 })).resolves.toEqual({ removed: [] });
        expect(inUseCalls).toBe(0);
    });

    it("counts a protected image in the budget and removes the rest, oldest first", async () => {
        const store = fakeStore();
        const result = await pruneSandboxImages({
            store,
            keep: 1,
            protect: ["localhost/pi-coder-sandbox:cccccccccccc"],
        });

        expect(result.removed).toEqual([
            "localhost/pi-coder-sandbox:aaaaaaaaaaaa",
            "localhost/pi-coder-sandbox:bbbbbbbbbbbb",
        ]);
    });

    it("returns a failure instead of throwing, because housekeeping must not fail a build", async () => {
        const store = fakeStore({
            async listSandboxImages() {
                throw new Error("podman not found");
            },
        });

        await expect(pruneSandboxImages({ store, keep: 1 })).resolves.toEqual({
            removed: [],
            error: "podman not found",
        });
    });
});

describe("normalizeImageId", () => {
    it("reduces full IDs, short IDs, and a sha256 scheme to the same comparison form", () => {
        const full = "aaaaaaaaaaaa" + "0".repeat(52);

        expect(normalizeImageId(full)).toBe("aaaaaaaaaaaa");
        expect(normalizeImageId("sha256:aaaaaaaaaaaa")).toBe("aaaaaaaaaaaa");
        expect(normalizeImageId("AAAAAAAAAAAA")).toBe("aaaaaaaaaaaa");
    });

    it("ignores whitespace from a pretty-printed inspect field", () => {
        expect(normalizeImageId(`  aaaaaaaaaaaa  `)).toBe("aaaaaaaaaaaa");
    });

    it("does not collide two different images that share a date-like stamp", () => {
        expect(normalizeImageId(STAMP.slice(0, 12))).not.toBe(normalizeImageId("aaaaaaaaaaaa"));
    });
});
