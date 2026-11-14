import { beforeEach, describe, expect, it } from "vitest";

import { commentSyntaxFor, commentTextIn } from "../../../src/tools/code/comments";
import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { embedTextOf, stripComments } from "../../../src/tools/code/text";
import type { ParsedFile } from "../../../src/tools/code/types";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

async function parse(relative: string, source: string): Promise<ParsedFile> {
    const memory = new MemoryCodeSource("/project", { [relative]: source });
    const loaded = await loadParsedFile(memory, `/project/${relative}`);

    if (loaded.kind !== "parsed") {
        throw new Error("expected a parsed file");
    }

    return loaded.parsed;
}

describe("outline comment extraction", () => {
    it("reads line and block comments and strips their markers", () => {
        const source = [
            "{",
            "    // keep the last good value",
            "    value ??= fallback;",
            "    /* the block",
            "     * explains itself */",
            "}",
        ].join("\n");
        const syntax = commentSyntaxFor("cpp");

        expect(syntax).toBeDefined();
        expect(commentTextIn(source, 0, source.length, syntax!)).toBe(
            "keep the last good value the block explains itself",
        );
    });

    it("does not read a // inside a string literal as a comment", () => {
        const source = '{ const url = "https://example.test/path"; } // real note';
        const syntax = commentSyntaxFor("typescript");

        expect(commentTextIn(source, 0, source.length, syntax!)).toBe("real note");
    });

    it("uses # for Python and ignores it inside strings", () => {
        const source = ["def f():", '    color = "#fff"  # actual note', ""].join("\n");
        const syntax = commentSyntaxFor("python");

        expect(commentTextIn(source, 0, source.length, syntax!)).toBe("actual note");
    });

    it("has no comment syntax for Markdown, whose prose is the doc channel", () => {
        expect(commentSyntaxFor("markdown")).toBeUndefined();
    });

    it("caps how much of a large body is lifted", () => {
        const source = `// ${"x".repeat(5_000)}`;
        const syntax = commentSyntaxFor("go");

        expect(commentTextIn(source, 0, source.length, syntax!, 100).length).toBeLessThanOrEqual(
            100,
        );
    });
});

describe("signature text", () => {
    it("removes comments without eating a glob or a URL in a string", () => {
        const globs = 'const G: readonly string[] = [...DIRS, "cmake-build-*/**", "moc_*/**"];';
        const url = 'const u = "https://example.com//x";';
        const regex = "const re = /a\\/\\//;";
        const commented = "void f(int a /* count */, int b);";

        expect(stripComments(globs)).toBe(globs);
        expect(stripComments(url)).toBe(url);
        expect(stripComments(regex)).toBe(regex);
        expect(stripComments(commented).replace(/\s+/g, " ")).toBe("void f(int a , int b);");
    });

    it("keeps a signature whose initializer holds a glob intact", async () => {
        const file = await parse(
            "src/languages.ts",
            `export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
    ...Array.from(DIRECTORIES, (directory) => \`\${directory}/**\`),
    "cmake-build-*/**",
];
`,
        );
        const declaration = file.all.find((candidate) => candidate.name === "DEFAULT_IGNORE_GLOBS");

        expect(declaration?.signature).toContain("`${directory}/**`");
        expect(declaration?.signature).toContain('"cmake-build-*/**"');
    });
});

describe("outline embedded text", () => {
    it("includes inline body comments next to the doc and signature", async () => {
        const file = await parse(
            "src/retry.ts",
            [
                "/** Retries a task. */",
                "export function retry(task: () => void): void {",
                "    // fall back to the last good value when the task throws",
                '    const url = "https://example.test/not-a-comment";',
                "    task();",
                "}",
                "",
            ].join("\n"),
        );
        const declaration = file.all.find((candidate) => candidate.name === "retry")!;
        const text = embedTextOf(file, declaration);

        expect(text).toContain("Retries a task.");
        expect(text).toContain("fall back to the last good value");
        expect(text).toContain("export function retry(task: () => void): void");
        // The string literal is skipped by the comment scanner, so its text never becomes prose.
        expect(text).not.toContain("not-a-comment");
    });

    it("does not scan a Markdown section for comments", async () => {
        const file = await parse("notes/guide.md", "# Retry\n\nA retry loop with backoff.\n");
        const heading = file.all.find((candidate) => candidate.kind === "heading")!;
        const text = embedTextOf(file, heading);

        expect(text).toContain("A retry loop with backoff.");
        expect(text).toContain("# Retry");
    });
});
