import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import {
    createSemanticSearch,
    forgetSharedRuntime,
    sharedEmbedRuntime,
} from "../../../src/tools/code/semantic";
import type { SemanticSearch } from "../../../src/tools/code/semantic/types";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

const FILES = {
    "src/hint.ts": `/** Keeps recently used cache entries alive. */
export function promote(key: string): string {
    return key;
}

/** A plain unrelated helper. */
export function other(): void {}

export function alpha(): void {}
export function beta(): void {}
export function gamma(): void {}
export function adapterForLanguage(language: string): string {
    return language;
}
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

function semanticRanking(name: string): SemanticSearch {
    return {
        hint: "# semantic: enable semantic search with /outline semantic on",
        dispose: () => undefined,
        async rank(request) {
            const file = request.files[0];
            const declaration = file.all.find((candidate) => candidate.name === name);

            return declaration === undefined
                ? []
                : [{ file, declaration, score: 0.83, scale: "cosine" }];
        },
    };
}

describe("outline search relevance tail", () => {
    it("names the chunk span when a body chunk produced the similarity score", async () => {
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files[0]!;
                const declaration = file.all.find((candidate) => candidate.name === "promote")!;

                return [
                    {
                        file,
                        declaration,
                        score: 0.71,
                        scale: "cosine",
                        chunk: {
                            index: 2,
                            total: 5,
                            startLine: 10,
                            endLine: 20,
                            key: "chunk-key",
                            text: "chunk text",
                        },
                    },
                ];
            },
        };
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "lifetime policy" },
            undefined,
            semantic,
        );

        expect(result.text).toContain("promote");
        expect(result.text).toContain("§2/5  :10-20");
    });

    it("renders a related row when no name or doc comment matches", async () => {
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "lifetime policy" },
            undefined,
            semanticRanking("promote"),
        );

        // A related row is a similarity guess, so it is not a match: the header has to say so, or an agent reads
        // "1 match" as proof the identifier exists.
        expect(result.matches).toBe(0);
        expect(result.text).toContain("no literal matches");
        expect(result.text).toMatch(/\[related \d+%\]/u);
        expect(result.text).toContain("1 related guess");
        expect(result.text).toContain(
            "# related: guesses, not matches · % = embedding similarity (cosine)",
        );
        expect(result.text).toContain("# semantic: enable semantic search");
    });

    it("prints an embedding cosine as itself, not as a share of the best row", async () => {
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files[0]!;
                const [first, second] = file.all;

                return [
                    { file, declaration: first!, score: 0.71, scale: "cosine" },
                    { file, declaration: second!, score: 0.55, scale: "cosine" },
                ];
            },
        };
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "lifetime policy" },
            undefined,
            semantic,
        );

        // A cosine is already 0-1, so a relative share would inflate 0.55 into 77%.
        expect(result.text).toContain("[related 71%]");
        expect(result.text).toContain("[related 55%]");
        expect(result.text).toContain("% = embedding similarity (cosine)");
    });

    it("prints no percentage when the tail was ranked lexically", async () => {
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files[0]!;
                const [first, second] = file.all;

                return [
                    { file, declaration: first!, score: 5.2, scale: "bm25" },
                    { file, declaration: second!, score: 3.5, scale: "bm25" },
                ];
            },
        };
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "lifetime policy" },
            undefined,
            semantic,
        );

        // 5.2 and 3.5 are corpus-relative magnitudes: as a share of the best they would read `100%` and `67%`, which
        // says the top row is certain when it is only the top row.
        expect(result.text).toMatch(/\[related\]/u);
        expect(result.text).not.toMatch(/\[related \d/u);
        expect(result.text).toContain("ranked by BM25/fusion");
    });

    it("says the default scan skipped ignored paths when only guesses came back", async () => {
        const result = await runSearch(
            source(),
            { action: "search", query: "nothing_matches_this" },
            undefined,
            semanticRanking("promote"),
        );

        // A guess is not a match, so the zero-literal answer still carries the scope note.
        expect(result.text).toContain("no literal matches");
        expect(result.text).toContain("the default scan skips ignored paths");
    });

    it("keeps the tail out of the way when names already answer", async () => {
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "a" },
            undefined,
            semanticRanking("promote"),
        );

        expect(result.text).not.toMatch(/\[related/u);
        expect(result.text).not.toContain("# related:");
    });

    it("prefers an identifier typo match to the relevance tail", async () => {
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "adpaterForLanguage" },
            undefined,
            semanticRanking("promote"),
        );

        expect(result.text).toContain("adapterForLanguage");
        expect(result.text).toContain("~1");
        expect(result.text).not.toMatch(/\[related/u);
    });

    it("keeps a doc match first and appends the tail after it", async () => {
        let rankingCalls = 0;
        const semantic: SemanticSearch = {
            hint: "# semantic: enable semantic search with /outline semantic on",
            dispose: () => undefined,
            async rank(request) {
                rankingCalls += 1;

                return semanticRanking("other").rank(request);
            },
        };

        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "cache entries alive" },
            undefined,
            semantic,
        );

        // A doc match is the answer, so it still leads; the dense channel runs anyway because it is cheap and it
        // cannot know what the literal pass missed. Its rows decorate the answer instead of replacing it.
        expect(result.text).toContain("promote");
        expect(result.text).toContain("[doc]");
        expect(rankingCalls).toBe(1);
        expect(result.text).toMatch(/\[related \d+%\]/u);
        expect(result.text.indexOf("[doc]")).toBeLessThan(result.text.indexOf("[related"));
    });

    it("leads with related rows when the doc tier only saw the words somewhere", async () => {
        const seen: boolean[] = [];
        const semantic: SemanticSearch = {
            hint: "# semantic: enable semantic search with /outline semantic on",
            dispose: () => undefined,
            async rank(request) {
                seen.push(request.similarityOnly === true);

                return await semanticRanking("other").rank(request);
            },
        };

        // Both words are in the doc comment, but not as a phrase: the doc tier matches, the phrase tier does not.
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "entries cache" },
            undefined,
            semantic,
        );
        const rows = result.text.split("\n").filter((line) => line.includes(":"));

        expect(seen).toEqual([true]);
        expect(rows[0]).toContain("other");
        expect(rows[0]).toMatch(/\[related \d+%\]/u);
        expect(rows.findIndex((line) => line.includes("promote"))).toBeGreaterThan(0);
    });

    it("keeps a name match first and asks the ranker to fuse, not to replace it", async () => {
        const seen: boolean[] = [];
        const semantic: SemanticSearch = {
            dispose: () => undefined,
            async rank(request) {
                seen.push(request.similarityOnly === true);

                return await semanticRanking("other").rank(request);
            },
        };

        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "promote" },
            undefined,
            semantic,
        );

        expect(seen).toEqual([false]);

        // The name tier renders without a tag; what matters is that it still leads the related row.
        const rows = result.text.split("\n");
        const promoted = rows.findIndex((line) => line.includes("promote"));
        const related = rows.findIndex((line) => line.includes("[related"));

        expect(promoted).toBeGreaterThanOrEqual(0);
        expect(related).toBeGreaterThan(promoted);
    });

    it("shows a declaration once even when both channels find it", async () => {
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "entries cache" },
            undefined,
            semanticRanking("promote"),
        );
        const promotes = result.text.split("\n").filter((line) => line.includes("promote"));

        expect(promotes).toHaveLength(1);
        expect(promotes[0]).toMatch(/\[related \d+%\]/u);
    });

    it("counts the doc rows the page shows, not the ones the tail displaced", async () => {
        const files: Record<string, string> = {
            "src/a.ts":
                "/** Keeps entries in the cache alive. */\nexport function promote(): void {}\n",
            "src/b.ts":
                "/** Another note about entries and the cache. */\nexport function refresh(): void {}\n",
        };
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files.find((candidate) => candidate.path.endsWith("b.ts"))!;

                return [{ file, declaration: file.all[0]!, score: 1, scale: "rrf" as const }];
            },
        };
        const result = await runSearch(
            new MemoryCodeSource("/project", files),
            { action: "search", path: "src", query: "cache entries" },
            undefined,
            semantic,
        );

        // `refresh` is a doc match and the tail's best guess: the page shows it once, as a guess. Counting it as a doc
        // match too made the summary read `1 match · 2 by doc text`, a contradiction on its face.
        expect(result.text).toContain("1 match · 1 by doc text · 1 related guess");
    });

    it("does not add a hint when the tail produced nothing", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "lifetime policy",
        });

        expect(result.text).not.toContain("# semantic:");
        expect(result.text).not.toMatch(/\[related/u);
    });
});

describe("outline search related-led page", () => {
    // A full tail of guesses must not push the query's only literal match onto the next page: the row that is
    // evidence stays on the page the caller reads, and only the tail's weakest guess is deferred behind it.
    const SLOT_FILES: Record<string, string> = {
        "src/hint.ts": [
            "/** Keeps recently used cache entries alive. */",
            "export function promote(key: string): string {",
            "    return key;",
            "}",
            "",
        ].join("\n"),
        "src/related.ts": Array.from(
            { length: 8 },
            (_, index) => `export function rel${index + 1}(): void {}`,
        ).join("\n"),
    };

    function slotSource(): MemoryCodeSource {
        return new MemoryCodeSource("/project", SLOT_FILES);
    }

    it("keeps a slot for the literal row when related rows would fill the page", async () => {
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files.find((candidate) =>
                    candidate.path.endsWith("related.ts"),
                )!;

                return file.all.map((declaration, index) => ({
                    file,
                    declaration,
                    score: 1 / (index + 1),
                    scale: "rrf" as const,
                }));
            },
        };
        const result = await runSearch(
            slotSource(),
            { action: "search", path: "src", query: "cache alive" },
            undefined,
            semantic,
        );
        const literal = result.text.indexOf("promote");

        // The order is a measured decision, but the row that is evidence stays on the page the caller reads.
        expect(literal).toBeGreaterThanOrEqual(0);
        // A fused tail has no absolute score, so the rows carry the tag alone and the footer names the scale.
        expect(result.text).toMatch(/\[related\]/u);
        expect(result.text).not.toMatch(/\[related \d/u);
        expect(result.text).toContain("ranked by BM25/fusion");
        // A row the page shows needs no second mention in the footer.
        expect(result.text).not.toContain("# also:");
    });

    it("heads a file once when it contributes both a guess and a literal row", async () => {
        const files: Record<string, string> = {
            ...FILES,
            "src/related.ts": Array.from(
                { length: 8 },
                (_, index) => `export function rel${index + 1}(): void {}`,
            ).join("\n"),
        };
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const hint = request.files.find((candidate) => candidate.path.endsWith("hint.ts"))!;
                const related = request.files.find((candidate) =>
                    candidate.path.endsWith("related.ts"),
                )!;
                const first = hint.all.find((declaration) => declaration.name === "other")!;

                return [
                    { file: hint, declaration: first, score: 1, scale: "rrf" as const },
                    ...related.all.map((declaration, index) => ({
                        file: related,
                        declaration,
                        score: 0.9 - index / 100,
                        scale: "rrf" as const,
                    })),
                ];
            },
        };
        const result = await runSearch(
            new MemoryCodeSource("/project", files),
            { action: "search", path: "src", query: "cache alive" },
            undefined,
            semantic,
        );

        // A related-led page lists its guesses, then the literal rows. Both came from `hint.ts` here, and a second
        // heading for the same path reads as a second file.
        expect(result.text.split("\n").filter((line) => line === "src/hint.ts")).toHaveLength(1);

        const block = result.text.slice(result.text.indexOf("src/hint.ts"));

        expect(block).toContain("function other");
        expect(block).toContain("promote");
        expect(block.indexOf("function other")).toBeLessThan(block.indexOf("promote"));
    });

    it("counts the rows on the page separately from the header tallies", async () => {
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files.find((candidate) =>
                    candidate.path.endsWith("related.ts"),
                )!;

                return file.all.map((declaration, index) => ({
                    file,
                    declaration,
                    score: 1 / (index + 1),
                    scale: "rrf" as const,
                }));
            },
        };
        const result = await runSearch(
            slotSource(),
            { action: "search", path: "src", query: "cache alive", limit: 400 },
            undefined,
            semantic,
        );

        // The header counts the whole result and the page is a character budget, so a short page has to say so.
        expect(result.text).toContain("# page: rows 1-");
        expect(result.text).toMatch(/of 9 · the header counts the whole result/u);
        expect(result.text).toContain("# next:");
    });

    it("names a literal row the page could not show", async () => {
        const semantic: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank(request) {
                const file = request.files.find((candidate) =>
                    candidate.path.endsWith("related.ts"),
                )!;

                return file.all.map((declaration, index) => ({
                    file,
                    declaration,
                    score: 1 / (index + 1),
                    scale: "rrf" as const,
                }));
            },
        };
        const result = await runSearch(
            slotSource(),
            { action: "search", path: "src", query: "cache alive", limit: 400 },
            undefined,
            semantic,
        );

        expect(result.text).toContain(
            "# also: literal row follows the related guesses · src/hint.ts",
        );
        // The footer names the row; the page itself stops before it.
        expect(result.text).not.toContain("export function promote(key: string): string");
    });

    it("does not promise related guesses when the tail came back empty", async () => {
        const empty: SemanticSearch = {
            hint: undefined,
            dispose: () => undefined,
            async rank() {
                return [];
            },
        };
        const result = await runSearch(
            slotSource(),
            { action: "search", path: "src", query: "cache alive" },
            undefined,
            empty,
        );

        // The same page with no guesses: "literal rows follow the related guesses" would name rows that do not exist.
        expect(result.text).not.toContain("# also:");
        expect(result.text).not.toContain("[related");
    });
});

describe("outline semantic runtime", () => {
    it("shares one embedding runtime per model directory", () => {
        const model = path.join(os.tmpdir(), "pi-coder-shared-runtime");
        const first = sharedEmbedRuntime(model);

        expect(sharedEmbedRuntime(model)).toBe(first);
        expect(sharedEmbedRuntime(`${model}-other`)).not.toBe(first);

        forgetSharedRuntime(model, first);

        expect(sharedEmbedRuntime(model)).not.toBe(first);
    });

    it("releases the shared runtime when a search disposes it", async () => {
        const model = path.join(os.tmpdir(), "pi-coder-shared-runtime-dispose");
        const before = sharedEmbedRuntime(model);
        const search = createSemanticSearch({
            mode: "hybrid",
            modelDir: model,
            autoRefresh: false,
            artifactsReady: () => false,
        });

        await search.rank({ query: "anything", root: os.tmpdir(), sourceKind: "local", files: [] });
        search.dispose();

        expect(sharedEmbedRuntime(model)).not.toBe(before);
    });
});
