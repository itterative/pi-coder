import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { rankBm25, tokenize } from "../../../src/tools/code/semantic/bm25";
import { declarationDoc, embedTextOf } from "../../../src/tools/code/text";
import type { ParsedFile } from "../../../src/tools/code/types";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

async function parseFiles(files: Record<string, string>): Promise<ParsedFile[]> {
    const source = new MemoryCodeSource("/project", files);
    const parsed: ParsedFile[] = [];

    for (const relative of Object.keys(files)) {
        const loaded = await loadParsedFile(source, `/project/${relative}`);

        if (loaded.kind !== "parsed") {
            throw new Error(`expected ${relative} to parse`);
        }

        parsed.push(loaded.parsed);
    }

    return parsed;
}

const FILES = {
    "src/fuzzy.ts": `/**
 * The edit-distance budget for one query.
 *
 * Two edits recover a typo in a long identifier.
 */
export function fuzzyLimit(length: number): number {
    return length < 3 ? 0 : 1;
}

/** Cache that keeps recently used entries. */
export function cacheLookup(key: string): string {
    return key;
}
`,
};

describe("outline semantic text", () => {
    it("strips comment markers from doc text", async () => {
        const [file] = await parseFiles(FILES);
        const declaration = file.all.find((candidate) => candidate.name === "fuzzyLimit");

        expect(declaration).toBeDefined();
        const doc = declarationDoc(file, declaration!);

        expect(doc).toContain("edit-distance budget");
        expect(doc).not.toContain("/**");
        expect(doc).not.toContain("*/");
    });

    it("embeds the path, kind, qualified name, doc, and signature", async () => {
        const [file] = await parseFiles(FILES);
        const declaration = file.all.find((candidate) => candidate.name === "fuzzyLimit");

        expect(embedTextOf(file, declaration!)).toBe(
            "title: /project/src/fuzzy.ts | text: function fuzzyLimit. The edit-distance budget for one query. Two edits recover a typo in a long identifier. export function fuzzyLimit(length: number): number",
        );
    });

    it("embeds a markdown section's own prose, not just its heading", async () => {
        const [file] = await parseFiles({
            "docs/ranking.md": `# Ranking

Ranking is layered: exact name, then doc text.

## BM25

BM25 weights identifiers three times.\n`,
        });
        const heading = file.all.find((candidate) => candidate.qualifiedName === "Ranking::BM25");

        expect(declarationDoc(file, heading!)).toBe("BM25 weights identifiers three times.");
        expect(embedTextOf(file, heading!)).toBe(
            "title: /project/docs/ranking.md | text: heading Ranking::BM25. BM25 weights identifiers three times. ## BM25",
        );
    });

    it("keeps a markdown bullet's asterisk instead of treating it as a comment marker", async () => {
        const [file] = await parseFiles({
            "docs/list.md": `# Lists

* first bullet
* second bullet\n`,
        });
        const heading = file.all.find((candidate) => candidate.kind === "heading");

        expect(declarationDoc(file, heading!)).toContain("* first bullet * second bullet");
    });
});

describe("outline semantic tokenizer", () => {
    it("splits camel humps, acronym runs, and digits", () => {
        expect(tokenize("HTTPServer2Ids")).toEqual(["http", "server", "2", "ids"]);
    });

    it("drops filler words that carry no meaning in a query", () => {
        expect(tokenize("how does the cache work")).toEqual(["cache", "work"]);
    });
});

describe("outline semantic bm25", () => {
    it("ranks the declaration whose doc matches the query", async () => {
        const files = await parseFiles(FILES);
        const hits = rankBm25(files, "edit distance budget", 8);

        expect(hits[0]?.declaration.qualifiedName).toBe("fuzzyLimit");
        expect(hits.every((hit) => hit.score > 0)).toBe(true);
    });

    it("keeps one row for a header declaration and its definition", async () => {
        const files = await parseFiles({
            "src/a.h": "namespace net { int connect(const char* host); }\n",
            "src/a.cpp":
                "namespace net { int connect(const char* host) { return host != nullptr; } }\n",
        });
        const hits = rankBm25(files, "connect", 8);

        expect(hits).toHaveLength(1);
        expect(hits[0]?.declaration.isDefinition).toBe(true);
    });

    it("orders equal scores deterministically by path and line", async () => {
        const files = await parseFiles({
            "src/b.ts": "export function alpha(): void {}\n",
            "src/a.ts": "export function beta(): void {}\n",
        });
        const first = rankBm25(files, "function", 8).map((hit) => hit.declaration.name);

        expect(first).toEqual(
            rankBm25(files.toReversed(), "function", 8).map((hit) => hit.declaration.name),
        );
    });
});
