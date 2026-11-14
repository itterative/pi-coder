import { describe, expect, it } from "vitest";

import { commentBlocksOf } from "../../../src/tools/code/comment-blocks";
import { parseCodeFile } from "../../../src/tools/code/parse";

const HEADER_THEN_IMPORT = [
    "/**",
    " * The window allocator: spend a char budget on the items that carry the most context.",
    " *",
    " * Every candidate competes for room, and the allocator answers in one pass.",
    " */",
    'import { clip } from "./clip";',
    "",
    "/** A candidate is never clipped in half. */",
    "export function allocate(items: string[]): string[] {",
    "    return clip(items);",
    "}",
    "",
].join("\n");

const TWO_HEADERS = [
    "// The transport layer owns the retry loop, because only it knows which errors are worth retrying",
    "// and which ones the caller has to see.",
    'import { retry } from "./retry";',
    "",
    "export const version = 1;",
    "",
    "// The tracing layer is deliberately separate: a trace must never change the behaviour it observes, so",
    "// every hook here is optional and the default implementations do nothing at all.",
    "",
].join("\n");

const LABELS_ONLY = [
    "// TODO: tidy this up later",
    "// ---- next section ----",
    "",
    "export const value = 1;",
    "",
].join("\n");

const INLINE_NOTE = [
    "export function score(items: string[]): number {",
    "    // The weights are tuned against the evaluation corpus and must stay in sync with the recall report,",
    "    // which is regenerated whenever the corpus changes at all.",
    "    return items.length;",
    "}",
    "",
].join("\n");

describe("unowned comment blocks", () => {
    it("returns a file header and skips the doc comment of a declaration", async () => {
        const parsed = await parseCodeFile(HEADER_THEN_IMPORT, "/project/window.ts", "typescript");
        const blocks = commentBlocksOf(parsed);

        expect(parsed.parseErrors).toBe(0);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.startLine).toBe(1);
        expect(blocks[0]?.endLine).toBe(5);
        expect(blocks[0]?.text).toContain("spend a char budget");
        expect(blocks[0]?.lead).toBe(
            "The window allocator: spend a char budget on the items that carry the most context.",
        );
    });

    it("keeps a header above the imports and a note after the last declaration", async () => {
        const parsed = await parseCodeFile(TWO_HEADERS, "/project/layers.ts", "typescript");
        const blocks = commentBlocksOf(parsed);

        // A run of `//` lines is one block; a blank line is not what separates these. The second block sits past the
        // last declaration, which is the case no doc range can ever own.
        expect(blocks).toHaveLength(2);
        expect(blocks.map((block) => block.startLine)).toEqual([1, 7]);
        expect(blocks[0]?.text).toContain("transport layer");
        expect(blocks[1]?.text).toContain("tracing layer");
    });

    it("drops labels that carry no prose", async () => {
        const parsed = await parseCodeFile(LABELS_ONLY, "/project/labels.ts", "typescript");

        expect(commentBlocksOf(parsed)).toEqual([]);
    });

    it("skips a comment inside a declaration body", async () => {
        const parsed = await parseCodeFile(INLINE_NOTE, "/project/score.ts", "typescript");

        // The body channel already reads this text, so a comment row would answer the same query twice.
        expect(commentBlocksOf(parsed)).toEqual([]);
    });

    it("has no comment channel for markdown", async () => {
        const parsed = await parseCodeFile("# Title\n\nProse.\n", "/project/doc.md", "markdown");

        expect(commentBlocksOf(parsed)).toEqual([]);
    });
});
