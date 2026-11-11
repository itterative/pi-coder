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
        expect(result.text).toContain("# related: ranked by relevance");
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
