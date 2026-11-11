import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { parseCodeFile } from "../../../src/tools/code/parse";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { declarationDoc, embedTextOf } from "../../../src/tools/code/text";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * A memory file: the phrase "ceiling arithmetic" exists only in its frontmatter description, which is exactly the
 * shape that used to make `grep` beat `search` on the most semantic text a memory tree has.
 */
const MEMORY = `---
name: decode-isa-budget
description: Budget ceiling arithmetic, and why the tile count is the limiting factor.
category: architecture
---

## Dual issue

The walker closes the budget here.

## Tuning

Rows and columns come from the ceiling, computed per tile.
`;

const OTHER = `---
name: unrelated
description: Something about a table of pages.
---

## Eviction

Eviction is the window sliding.
`;

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "mem/decode.md": MEMORY,
        "mem/other.md": OTHER,
    });
}

beforeEach(() => {
    clearCodeCache();
});

describe("markdown frontmatter indexing", () => {
    it("exposes the block as a declaration with the whole block as its doc text", async () => {
        const parsed = await parseCodeFile(MEMORY, "/project/mem/decode.md", "markdown");
        const frontmatter = parsed.all.find((declaration) => declaration.kind === "frontmatter");

        expect(frontmatter).toBeDefined();
        expect(frontmatter?.range.startLine).toBe(1);
        expect(frontmatter?.range.endLine).toBe(5);
        expect(declarationDoc(parsed, frontmatter!)).toContain("ceiling arithmetic");
        expect(embedTextOf(parsed, frontmatter!)).toContain("ceiling arithmetic");
    });

    it("finds a phrase that lives only in frontmatter, and labels the row", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "mem",
            query: "ceiling arithmetic",
        });

        expect(result.text).toContain("mem/decode.md:1-5");
        expect(result.text).toContain("[frontmatter]");
        // Ranked above the body sections that only carry one of the two words.
        expect(result.text.indexOf("[frontmatter]")).toBeLessThan(
            result.text.indexOf("[doc]") === -1
                ? Number.POSITIVE_INFINITY
                : result.text.indexOf("[doc]"),
        );
    });

    it("keeps the block printable by show and visible in a digest", async () => {
        const shown = await runShow(source(), {
            action: "show",
            path: "mem/decode.md",
            symbols: ["frontmatter"],
        });
        const digest = await runDigest(source(), { action: "digest", path: "mem/decode.md" });

        expect(shown.text).toContain("yaml frontmatter");
        expect(shown.text).toContain("description: Budget ceiling arithmetic");
        expect(digest.text).toContain("frontmatter  :1-5");
    });

    it("finds the block through a directory target, where discovery greps for names", async () => {
        // The word "frontmatter" appears nowhere in the sources, so a grep-based candidate list would miss both.
        const shown = await runShow(source(), {
            action: "show",
            path: "mem",
            symbols: ["frontmatter"],
        });

        expect(shown.text).toContain("ambiguous: 2 matches");
        expect(shown.text).toContain("mem/decode.md:1-5");
        expect(shown.text).toContain("mem/other.md:1-4");
    });

    it("does not invent a block when the delimiter never closes", async () => {
        const open = await parseCodeFile(
            "---\ntitle: broken\n\n# Heading\n",
            "/project/mem/x.md",
            "markdown",
        );

        expect(open.all.some((declaration) => declaration.kind === "frontmatter")).toBe(false);
    });
});
