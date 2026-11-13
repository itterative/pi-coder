import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * One row per line.
 *
 * `state.scrollOffset = scrollOffset` mentions the name twice on one line, and a reader asking "where is this used"
 * wants the place, not each token: duplicate rows inflate the page and make the count read as call sites.
 */
const FILES: Record<string, string> = {
    "src/state.ts": [
        "export let scrollOffset = 0;",
        "",
        "export function bump(state: { scrollOffset: number }): void {",
        "    state.scrollOffset = scrollOffset;",
        "    state.scrollOffset = scrollOffset + 1;",
        "}",
        "",
    ].join("\n"),
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

function rowsOf(text: string): string[] {
    return text.split("\n").filter((line) => /^ {4}:\d+ /.test(line));
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline usages rows", () => {
    it("renders one row per line while still counting every occurrence", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src",
            query: "scrollOffset",
        });
        const rows = rowsOf(result.text);
        const lines = new Set(rows.map((row) => row.trim().split(/\s+/)[0]));

        expect(rows.length).toBe(lines.size);
        // Two occurrences on line 4 and two on line 5 collapse to one row each.
        expect(result.matches).toBeGreaterThan(rows.length);
        expect(result.text).toContain(`· ${result.matches} matches on ${rows.length} line(s) ·`);
    });

    it("keeps the count plain when nothing collapsed", async () => {
        const result = await runUsages(source(), { action: "usages", path: "src", query: "bump" });

        expect(result.text).toMatch(/· \d+ matches · /);
        expect(result.text).not.toContain("line(s)");
    });
});
