import { describe, expect, it } from "vitest";

import { stem } from "../../../src/tools/code/stem";

describe("outline doc stemmer", () => {
    it("folds the inflections a comment and a query disagree on", () => {
        const same: Array<[string, string]> = [
            ["spilling", "spill"],
            ["spilled", "spill"],
            ["spills", "spills".slice(0, -1)],
            ["spill", "spill"],
            ["running", "run"],
            ["batches", "batch"],
            ["boxes", "box"],
            ["bodies", "body"],
            ["quickly", "quick"],
            ["pages", "page"],
            ["page", "page"],
        ];

        for (const [input, expected] of same) {
            expect(stem(input), input).toBe(expected);
        }
    });

    it("keeps one stem for a word, its plural, and its verb forms", () => {
        // The point of the stemmer: a query in one form has to reach a comment in another.
        expect(stem("cache")).toBe(stem("caches"));
        expect(stem("cache")).toBe(stem("caching"));
        expect(stem("write")).toBe(stem("writing"));
        expect(stem("table")).toBe(stem("tables"));
    });

    it("leaves the words where stemming would do harm", () => {
        // Not plural, not a verb suffix, and both sides of a pair that must not merge.
        expect(stem("class")).toBe("class");
        expect(stem("analysis")).toBe("analysis");
        expect(stem("status")).toBe("status");
        expect(stem("httpserver")).toBe("httpserver");
        // Shorter than any suffix rule, so every 3-letter word and every non-alpha token passes through.
        expect(stem("key")).toBe("key");
        expect(stem("x86_64")).toBe("x86_64");
        expect(stem("2d")).toBe("2d");

        // A doubled consonant collapses, except l/s/z: `spill` must not become `spil`.
        expect(stem("spilling")).toBe("spill");
        expect(stem("passing")).toBe("pass");
        expect(stem("fizzing")).toBe("fizz");
    });
});
