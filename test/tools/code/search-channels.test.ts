import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

function sourceWith(relative: string, content: string): MemoryCodeSource {
    return new MemoryCodeSource("/project", { [relative]: content });
}

describe("outline search channels", () => {
    it("matches doc text when no declaration name contains the query", async () => {
        const source = sourceWith(
            "src/fuzzy.ts",
            [
                "/**",
                " * The edit-distance budget for one query.",
                " */",
                "export function fuzzyLimit(query: string): number | undefined {",
                "    return query.length < 3 ? undefined : 1;",
                "}",
                "",
            ].join("\n"),
        );

        const result = await runSearch(source, {
            action: "search",
            path: "src",
            query: "edit distance",
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain("fuzzyLimit");
        expect(result.text).toContain("[doc]");
        expect(result.text).toContain("1 by doc text");
    });

    it("matches doc tokens in any order", async () => {
        const source = sourceWith(
            "src/fuzzy.ts",
            [
                "/** The edit-distance budget for one query. */",
                "export function fuzzyLimit() {}",
                "",
            ].join("\n"),
        );

        const result = await runSearch(source, {
            action: "search",
            path: "src",
            query: "distance edit",
        });

        expect(result.text).toContain("fuzzyLimit");
        expect(result.text).toContain("[doc]");
    });

    it("prefers a doc match to an approximate name match", async () => {
        const source = sourceWith(
            "src/fuzzy.ts",
            [
                "/** Two edits recover a typo in a long identifier. */",
                "export function fuzzyLimit() {}",
                "",
                'export function typeKind(type: string): "class" | "enum" {',
                '    return "class";',
                "}",
                "",
            ].join("\n"),
        );

        const result = await runSearch(source, {
            action: "search",
            path: "src",
            query: "typo",
        });

        expect(result.text).toContain("fuzzyLimit");
        expect(result.text).toContain("[doc]");
        expect(result.text).not.toContain("typeKind");
        expect(result.text).not.toContain("~1");
    });

    it("still fuzzy-matches a misspelled identifier when nothing literal matches", async () => {
        const source = sourceWith(
            "src/adapters.ts",
            [
                "export function adapterForLanguage(language: string): string {",
                "    return language;",
                "}",
                "",
            ].join("\n"),
        );

        const result = await runSearch(source, {
            action: "search",
            path: "src",
            query: "adpaterForLanguage",
        });

        expect(result.text).toContain("no name or doc matches");
        expect(result.text).toContain("adapterForLanguage");
        expect(result.text).toContain("~1");
    });

    it("caps approximate rows and reports how many were withheld", async () => {
        const declarations = Array.from(
            { length: 10 },
            (_, index) => `export function valu${index}(): number {\n    return ${index};\n}\n`,
        );
        const source = sourceWith("src/budget.ts", ["\n", ...declarations].join(""));

        const result = await runSearch(source, {
            action: "search",
            path: "src",
            query: "value",
        });

        const rows = result.text.split("\n").filter((line) => line.includes(" ~1"));

        expect(rows).toHaveLength(8);
        expect(result.text).toContain("nearest 8 of 10");
    });
});
