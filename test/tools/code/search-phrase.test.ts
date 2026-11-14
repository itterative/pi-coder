import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * Two files: `a.md` mentions pages and tables in separate sentences, `b.md` says "page table" as a phrase.
 * Alphabetically the token-scattered file comes first, so only the phrase tier can put the answer on top.
 */
const SCATTERED = `# Sliding

Each page carries a record.

| column | meaning |
| ------ | ------- |

The table below is per head.
`;

const PHRASE = `# Walker

The walker resolves one page table entry at a time.
`;

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "mem/a.md": SCATTERED,
        "mem/b.md": PHRASE,
    });
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline search phrase handling", () => {
    it("ranks a contiguous phrase above the same words scattered through a section", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "mem",
            query: "page table",
        });

        expect(result.matches).toBe(2);
        expect(result.text.indexOf("mem/b.md")).toBeLessThan(result.text.indexOf("mem/a.md"));
    });

    it("requires the phrase when the caller quotes it", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "mem",
            query: '"page table"',
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain("mem/b.md");
        expect(result.text).not.toContain("mem/a.md");
        // The message must not double the caller's own quotes.
        expect(result.text).not.toContain('""page table""');
    });

    it("stems the doc channel so an inflected query reaches a comment in another form", async () => {
        const source = new MemoryCodeSource("/project", {
            "mem/pool.md": "# Pool\n\nThe pool spilled its rows into the scratch ring.\n",
        });
        const result = await runSearch(source, {
            action: "search",
            path: "mem",
            query: "spilling",
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain("mem/pool.md");
        expect(result.text).toContain("[doc]");
    });

    it("names the file whose rows a cut page left behind", async () => {
        const sections = (name: string): string =>
            Array.from(
                { length: 8 },
                (_, index) => `## ${name} ${index}\n\nadapter detail ${index} for the record.\n`,
            ).join("\n");
        const source = new MemoryCodeSource("/project", {
            "mem/a.md": `# A\n\n${sections("A")}`,
            "mem/b.md": `# B\n\n${sections("B")}`,
        });
        const result = await runSearch(source, {
            action: "search",
            path: "mem",
            query: "adapter",
            limit: 320,
        });

        // The count lives on `# next:` alone; this note adds only the file the page boundary hid.
        expect(result.text).toContain("# more: later rows continue in mem/b.md");
        expect(result.text).toMatch(/# next: \d+ more line\(s\) · outline\(action="search"/u);

        // A continuation that lands inside a file reprints its heading, so the rows are not anonymous.
        const offset = Number(/offset=(\d+)\)/u.exec(result.text)?.[1] ?? "0");
        const resumed = await runSearch(source, {
            action: "search",
            path: "mem",
            query: "adapter",
            limit: 320,
            offset,
        });
        const [firstLine = ""] = (resumed.text.split("\n\n")[1] ?? "").split("\n");

        expect(firstLine.startsWith("mem/")).toBe(true);
    });
});

describe("outline search quoted body text", () => {
    /**
     * Both files hold every word of the query; only one holds them adjacent.
     *
     * `pageOf(table)` is how the scattered file says "page" and "table", and the body channel used to treat a quoted
     * query as those words in any order — so a phrase search returned a file that did not contain the phrase.
     */
    function source(): MemoryCodeSource {
        return new MemoryCodeSource("/project", {
            "src/scattered.ts": [
                "export function pageOf(table: number): number {",
                "    return table + 1;",
                "}",
                "",
            ].join("\n"),
            "src/phrase.ts": [
                "export function walk(): string {",
                '    return "one page table entry";',
                "}",
                "",
            ].join("\n"),
        });
    }

    it("requires adjacency in a body, not just the words", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: '"page table"',
        });

        expect(result.text).toContain("phrase.ts");
        expect(result.text).not.toContain("scattered.ts");
        expect(result.text).toContain("[body]");
    });
});
