import { beforeEach, describe, expect, it } from "vitest";

import { commentBlocksOf } from "../../../src/tools/code/comment-blocks";
import { clearCodeCache } from "../../../src/tools/code/load";
import { parseCodeFile } from "../../../src/tools/code/parse";
import { runSearch } from "../../../src/tools/code/search";
import type { SemanticSearch } from "../../../src/tools/code/semantic/types";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * Comment rows (`[comment]`): prose no declaration owns.
 *
 * The fixture's header sits above the import, so no declaration's range or doc range covers it — that is exactly the
 * text the doc and body channels cannot answer for.
 */
const WINDOW = [
    "/**",
    " * The window allocator: spend a char budget on the items that carry the most context.",
    " *",
    " * Every candidate competes for room, and the allocator answers in one pass.",
    " */",
    'import { clip } from "./clip";',
    "",
    "/** Keeps the newest entries and drops the rest. */",
    "export function allocate(items: string[], budget: number): string[] {",
    "    return clip(items, budget);",
    "}",
    "",
].join("\n");

const LABEL = ["export const value = 1;", "", "// TODO: tidy this up later", ""].join("\n");

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", { "src/tools/window.ts": WINDOW });
}

function semanticFor(): SemanticSearch {
    return {
        rank: async () => {
            const parsed = await parseCodeFile(
                WINDOW,
                "/project/src/tools/window.ts",
                "typescript",
            );
            const block = commentBlocksOf(parsed)[0];

            return block === undefined ? [] : [{ file: parsed, comment: block }];
        },
        dispose: () => undefined,
    };
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline search comment blocks", () => {
    it("returns a row for prose no declaration owns, counted as a match", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "spend a char budget",
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain(
            '# search "spend a char budget" in src · 1 file · typescript · 1 match · 1 by comment text',
        );
        expect(result.text).toContain("src/tools/window.ts:1-5  comment");
        // The evidence line loses its `*` decoration: the row is about the prose, not the comment syntax.
        expect(result.text).toContain(
            "  :2  The window allocator: spend a char budget on the items that carry the most context.",
        );
        expect(result.text).toContain("# comment: prose no declaration owns");
    });

    it("leaves the doc comment above a declaration to the doc channel", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "newest entries and drops the rest",
        });

        expect(result.text).toContain("allocate");
        expect(result.text).toContain("[doc]");
        expect(result.text).not.toContain("  comment");
    });

    it("drops comment rows under a kind filter, which names no comment kind", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "spend a char budget",
            kind: "function",
        });

        expect(result.matches).toBe(0);
        expect(result.text).toContain("# filter: kind=function");
    });

    it("indexes no row for a label that carries no prose", async () => {
        const result = await runSearch(new MemoryCodeSource("/project", { "src/x.ts": LABEL }), {
            action: "search",
            path: "src",
            query: "tidy this up later",
        });

        expect(result.matches).toBe(0);
    });

    it("marks a comment reached by similarity as a guess, not a match", async () => {
        const result = await runSearch(
            source(),
            // No word of this query appears in the block, so only the similarity channel can answer it.
            { action: "search", path: "src", query: "share the budget among candidates" },
            undefined,
            semanticFor(),
        );

        expect(result.matches).toBe(0);
        expect(result.text).toContain("no literal matches");
        expect(result.text).toContain('src/tools/window.ts:1-5  comment  "The window allocator:');
        expect(result.text).toContain("[related]");
    });
});
