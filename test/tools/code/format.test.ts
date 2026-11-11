import { describe, expect, it } from "vitest";

import { sourceForDeclaration, splitSymbolList } from "../../../src/tools/code/format";
import { parseMarkdownFile } from "../../../src/tools/code/markdown";
import { parseCodeFile } from "../../../src/tools/code/parse";

function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

describe("sourceForDeclaration", () => {
    it("prints a doc comment that precedes the declaration", async () => {
        const parsed = await parseCodeFile(
            "/** Kept. */\nexport function f(): void {}\n",
            "/project/src/a.ts",
            "typescript",
        );
        const text = sourceForDeclaration(parsed.source, parsed.all[0]!, true).join("\n");

        expect(occurrences(text, "/** Kept. */")).toBe(1);
        expect(text).toContain("export function f");
    });

    it("does not print a doc range that sits inside the declaration's own range", async () => {
        const parsed = await parseMarkdownFile("# Title\n\nBody line.\n", "/project/docs/a.md");
        const text = sourceForDeclaration(parsed.source, parsed.all[0]!, true).join("\n");

        // A Markdown section's doc text is its prose, which the section range already contains.
        expect(occurrences(text, "Body line.")).toBe(1);
        expect(text).toContain("# Title");
    });
});

describe("splitSymbolList", () => {
    it("splits a comma-joined entry an agent sent as one string", () => {
        expect(splitSymbolList(["Qwen35Model::attention_block, Qwen35Model::mlp_block"])).toEqual([
            "Qwen35Model::attention_block",
            "Qwen35Model::mlp_block",
        ]);
    });

    it("keeps commas inside an overload's parameter list", () => {
        expect(splitSymbolList(["Socket::connect(const Address&, int), Socket::fd"])).toEqual([
            "Socket::connect(const Address&, int)",
            "Socket::fd",
        ]);
    });

    it("trims entries, drops empties, and keeps repeats in order", () => {
        expect(splitSymbolList([" a::b , , c::d,", "a::b"])).toEqual(["a::b", "c::d", "a::b"]);
    });
});
