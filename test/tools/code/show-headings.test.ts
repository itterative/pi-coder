import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runShow } from "../../../src/tools/code/show";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * `show` against markdown headings.
 *
 * A heading's name is prose, so the exact-name rule that protects a code symbol from a wrong-overload answer would
 * leave most headings unreachable: a truncated or reworded title still names the section the caller wants, and a
 * comma inside the title is text rather than a symbol separator. Loose heading matches are reported as such, so the
 * loosening does not read as a confident hit.
 */
const GUIDE = [
    "# Guide",
    "",
    "Intro prose.",
    "",
    "## Framing, viewport restore, and the render cache",
    "",
    "Body of the framing section.",
    "",
    "## The agent browser is a composed host",
    "",
    "Body of the browser section.",
    "",
].join("\n");

const FILES: Record<string, string> = {
    "docs/guide.md": GUIDE,
    "src/viewport.ts": [
        "export function restoreViewport(width: number): number {",
        "    return width;",
        "}",
        "",
    ].join("\n"),
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline show heading match", () => {
    it("matches a heading by a later piece of its title, and says the match was loose", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "docs/guide.md",
            query: "viewport restore",
        });

        expect(result.text).toContain("Body of the framing section.");
        expect(result.text).toContain("# heading: 1 matched by title text, not the full title");
        expect(result.text).toContain("(substring of the title)");
    });

    it("matches a heading by a prefix of its title", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "docs/guide.md",
            query: "The agent browser",
        });

        expect(result.text).toContain("Body of the browser section.");
        expect(result.text).toContain("(prefix of the title)");
    });

    it("keeps a comma inside a title as one selector", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "docs/guide.md",
            query: "Framing, viewport restore, and the render cache",
        });

        expect(result.text).toContain("Body of the framing section.");
        expect(result.text).toContain("# comma:");
        expect(result.text).toContain("matched as one heading title, not 3 selectors");
        expect(result.text).not.toContain("not found");
    });

    it("does not loosen identifier matching: a code symbol still has to be named exactly", async () => {
        const result = await runShow(source(), { action: "show", path: "src", query: "viewport" });

        expect(result.text).toContain("not found");
        expect(result.text).not.toContain("restoreViewport");
    });
});
