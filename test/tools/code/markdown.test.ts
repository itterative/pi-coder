import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { parseCodeFile } from "../../../src/tools/code/parse";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const MARKDOWN = `---
title: Guide
---

# Guide

Intro text.

## Install

Run \`npm install\`.

\`\`\`sh
# this is code, not a heading
npm install
\`\`\`

## Usage

### Example

\`\`\`ts
const value = 1;
\`\`\`

Setext heading
--------------

### Nested

Done.
`;

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "docs/guide.md": MARKDOWN,
    });
}

beforeEach(() => {
    clearCodeCache();
});

describe("Markdown adapter", () => {
    it("maps heading hierarchy and ignores fenced code and front matter", async () => {
        const parsed = await parseCodeFile(MARKDOWN, "/project/docs/guide.md", "markdown");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.language).toBe("markdown");
        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual([
            "Guide",
            "Guide::Install",
            "Guide::Usage",
            "Guide::Usage::Example",
            "Guide::Setext heading",
            "Guide::Setext heading::Nested",
        ]);
        expect(names).not.toContain("# this is code, not a heading");
        expect(parsed.all.find((item) => item.qualifiedName === "Guide")?.kind).toBe("heading");
    });

    it("digests, searches, and shows a section", async () => {
        const digest = await runDigest(source(), {
            action: "digest",
            path: "docs/guide.md",
        });
        const searched = await runSearch(source(), {
            action: "search",
            path: "docs/guide.md",
            query: "Install",
        });
        const shown = await runShow(source(), {
            action: "show",
            path: "docs/guide.md",
            symbols: ["Guide::Install"],
        });

        expect(digest.text).toContain("markdown");
        expect(digest.text).toContain("## Install");
        expect(digest.text).toContain("### Example");
        expect(searched.text).toContain("heading  Guide::Install");
        expect(shown.text).toContain("heading Guide::Install · definition");
        expect(shown.text).toContain("npm install");
        expect(shown.text).not.toContain("## Usage");
    });

    it("reports no identifier usages for Markdown", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "docs/guide.md",
            symbols: ["Install"],
        });

        expect(result.matches).toBe(0);
        expect(result.parseErrors).toBe(0);
    });
});
