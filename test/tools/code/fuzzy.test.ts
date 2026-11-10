import { describe, expect, it } from "vitest";

import {
    boundedDamerauLevenshtein,
    fuzzyLimit,
    fuzzyNameDistance,
    nameTokens,
} from "../../../src/tools/code/fuzzy";

describe("fuzzy declaration names", () => {
    it("splits camel and snake case names into tokens", () => {
        expect(nameTokens("make_plan")).toEqual(["make", "plan"]);
        expect(nameTokens("CallList")).toEqual(["Call", "List"]);
        expect(nameTokens("HTTPServer")).toEqual(["HTTP", "Server"]);
    });

    it("allows adjacent transpositions", () => {
        expect(boundedDamerauLevenshtein("exectue", "execute", 2)).toBe(1);
        expect(boundedDamerauLevenshtein("connect", "connect", 0)).toBe(0);
        expect(boundedDamerauLevenshtein("connect", "disconnect", 2)).toBe(3);
    });

    it("matches a typo against a token inside a longer name", () => {
        expect(fuzzyNameDistance("plna", "make_plan", 1)).toBe(1);
        expect(fuzzyNameDistance("plna", "make_plan", 0)).toBeUndefined();
        expect(fuzzyNameDistance("makepln", "make_plan", 2)).toBe(1);
    });

    it("does not fuzz very short queries", () => {
        expect(fuzzyLimit("pl")).toBeUndefined();
        expect(fuzzyLimit("plan")).toBe(1);
        expect(fuzzyLimit("execute")).toBe(2);
    });
});
