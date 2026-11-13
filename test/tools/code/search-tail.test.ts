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

            return declaration === undefined ? [] : [{ file, declaration }];
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

        expect(result.matches).toBe(1);
        expect(result.text).toContain("[related]");
        expect(result.text).toContain("1 related");
        expect(result.text).toContain(
            "# related: ranked by term overlap and, when the embedding index is warm, similarity",
        );
        expect(result.text).toContain("# semantic: enable semantic search");
    });

    it("keeps the tail out of the way when names already answer", async () => {
        const result = await runSearch(
            source(),
            { action: "search", path: "src", query: "a" },
            undefined,
            semanticRanking("promote"),
        );

        expect(result.text).not.toContain("[related]");
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
        expect(result.text).not.toContain("[related]");
    });

    it("skips the tail when a doc comment already matched", async () => {
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

        // A doc match means the prose mentions every content word of the query, so one row is an answer, and the
        // tail would only spend an embedding to decorate it.
        expect(result.text).toContain("promote");
        expect(result.text).toContain("[doc]");
        expect(rankingCalls).toBe(0);
        expect(result.text).not.toContain("[related]");
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
        expect(rows[0]).toContain("[related]");
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
        const related = rows.findIndex((line) => line.includes("[related]"));

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
        expect(promotes[0]).toContain("[related]");
    });

    it("does not add a hint when the tail produced nothing", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "lifetime policy",
        });

        expect(result.text).not.toContain("# semantic:");
        expect(result.text).not.toContain("[related]");
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
