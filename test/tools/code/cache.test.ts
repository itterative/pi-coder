import { describe, expect, it } from "vitest";

import { TwoQueueCache } from "../../../src/tools/code/cache";

describe("TwoQueueCache", () => {
    it("promotes a repeated entry and evicts probation before protected entries", () => {
        const cache = new TwoQueueCache<string, string>({ entryLimit: 3, byteLimit: 100 });

        cache.set("a", "A", 1);
        cache.set("b", "B", 1);
        cache.set("c", "C", 1);
        expect(cache.get("a")).toBe("A");

        cache.set("d", "D", 1);

        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")).toBe("A");
        expect(cache.get("c")).toBe("C");
        expect(cache.get("d")).toBe("D");
        expect(cache.size).toBe(3);
    });

    it("evicts the least recently used protected entry when probation is empty", () => {
        const cache = new TwoQueueCache<string, string>({ entryLimit: 2, byteLimit: 100 });

        cache.set("a", "A", 1);
        cache.set("b", "B", 1);
        expect(cache.get("a")).toBe("A");
        expect(cache.get("b")).toBe("B");

        cache.set("c", "C", 1);

        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe("B");
        expect(cache.get("c")).toBe("C");
    });

    it("honors the byte budget independently of the entry budget", () => {
        const cache = new TwoQueueCache<string, string>({ entryLimit: 10, byteLimit: 3 });

        cache.set("a", "A", 2);
        cache.set("b", "B", 2);

        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe("B");
        expect(cache.byteSize).toBe(2);
    });

    it("removes replaced, deleted, and cleared entries from the budget", () => {
        const cache = new TwoQueueCache<string, number>({ entryLimit: 10, byteLimit: 100 });

        cache.set("a", 1, 4);
        cache.set("a", 2, 6);
        expect(cache.get("a")).toBe(2);
        expect(cache.byteSize).toBe(6);

        cache.delete("a");
        expect(cache.get("a")).toBeUndefined();
        expect(cache.byteSize).toBe(0);

        cache.set("b", 3, 5);
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.byteSize).toBe(0);
    });
});
