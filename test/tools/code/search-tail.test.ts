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
        expect(result.text).toContain("# related: guesses, not matches · % = similarity");
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
        const weakest = result.text.indexOf("rel8");

        expect(literal).toBeGreaterThanOrEqual(0);
        expect(weakest).toBeGreaterThanOrEqual(0);
        expect(literal).toBeLessThan(weakest);
        expect(result.text).toMatch(/\[related \d+%\]/u);
        // The percentage is of the best guess in this result: the top-ranked row is 100%, the eighth is not.
        expect(result.text).toContain("[related 100%]");
        expect(result.text).toMatch(/\[related (?:[1-9]|[1-9]\d)%\]/u);
        // The order is a measured decision, but a literal row below the guesses is never silent.
        expect(result.text).toContain(
            "# also: literal row follows the related guesses · src/hint.ts:2-4",
        );
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
