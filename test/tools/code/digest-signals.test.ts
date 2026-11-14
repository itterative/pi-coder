import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * What a digest says about itself.
 *
 * Signatures mode is a filtered view, and a filter the reader cannot see reads as absence: a class whose members are
 * all private looks like a class with no members. The directory map has the opposite problem — it can name every
 * directory and still not answer "which file", which is the question a caller with one directory in mind asked.
 */
const QUEUE = [
    "export class Queue {",
    "    private items: string[] = [];",
    "    public push(item: string): void {",
    "        this.items.push(item);",
    "    }",
    "    protected drain(): void {}",
    "    private reset(): void {}",
    "}",
    "",
].join("\n");

const FILES: Record<string, string> = {
    "src/queue.ts": QUEUE,
    "src/a/alpha.ts": manyFunctions("alpha"),
    "src/a/alias.ts": manyFunctions("alias"),
    "src/b/beta.ts": manyFunctions("beta"),
    "src/gamma.ts": manyFunctions("gamma"),
};

function manyFunctions(prefix: string): string {
    return Array.from(
        { length: 12 },
        (_, index) => `export function ${prefix}${index}(): number { return ${index}; }`,
    ).join("\n");
}

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline digest visibility", () => {
    it("counts the members signatures mode drops for their access", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src/queue.ts" });

        expect(result.text).toContain("push");
        expect(result.text).not.toContain("drain");
        expect(result.text).not.toContain("reset");
        // `items` is a class field, which signatures mode never lists; only access hides are counted here.
        expect(result.text).toContain("# visibility: 2 non-public member(s) hidden");
    });

    it("stays quiet when detail=full already lists every member", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/queue.ts",
            detail: "full",
        });

        expect(result.text).toContain("drain");
        expect(result.text).toContain("reset");
        expect(result.text).not.toContain("# visibility:");
    });

    it("says nothing when there is nothing to hide", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src/gamma.ts" });

        expect(result.text).not.toContain("# visibility:");
    });
});

describe("outline digest directory map", () => {
    it("names the files it is mapping, root first", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 400 });

        expect(result.text).toContain("declarations exceed the");
        expect(result.text).toContain(".  2 files");
        expect(result.text).toContain("gamma.ts (");
        expect(result.text).toContain("queue.ts (");
        // The count is what makes the map answerable: names alone leave the next call a guess.
        expect(result.text).toMatch(/gamma\.ts \(\d+\)/);
        expect(result.text).toContain("a/  2 files");
        expect(result.text).toContain("alias.ts");
        expect(result.text).toContain("# deeper: outline digest src/a");
    });

    it("drops names before it drops the map, and never leaves a partial list unlabelled", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 120 });

        expect(result.text).toContain("declarations exceed the");
        expect(result.text).toContain("a/  2 files");

        for (const line of result.text.split("\n")) {
            if (line.trimStart().startsWith("# … ")) {
                expect(line).toMatch(/^ {2}# … \d+ more$/);

                continue;
            }

            // A names line only ever holds whole names, and a truncated one is always followed by its count.
        }
    });

    it("leaves the visibility note off a result that shows no members", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 400 });

        expect(result.text).toContain("declarations exceed the 400-char limit");
        expect(result.text).not.toContain("# visibility:");
    });

    it("names every file when a pattern matches a few files at depth", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/modules/sandbox/permissions.ts": manyFunctions("permission"),
            "test/modules/sandbox/permissions.test.ts": manyFunctions("testPermission"),
        });
        const result = await runDigest(source, {
            action: "digest",
            path: "**/permissions*.ts",
            limit: 120,
        });

        // The map grouped these as `src/ 1 file · modules/ 1` and named neither, which is not an answer to
        // "which files matched?".
        expect(result.text).toContain("src/modules/sandbox/permissions.ts");
        expect(result.text).toContain("test/modules/sandbox/permissions.test.ts");
        expect(result.text).not.toContain("modules/ 1");
    });
});

describe("outline digest kind-filtered rows", () => {
    it("does not put a namespace in front of a namespace-level function", async () => {
        // `vibes::hip::blas::  [[nodiscard]] bool valid_dtype(...)` reads like a qualified name with no member on
        // the end, and `show` cannot use it. Only a type owner is worth printing.
        const source = new MemoryCodeSource("/project", {
            "src/ops.cpp": [
                "namespace vibes::hip {",
                "void plain() {",
                "}",
                "",
                "struct Ops {",
                "    void member() {",
                "    }",
                "};",
                "}",
                "",
            ].join("\n"),
        });
        const result = await runDigest(source, {
            action: "digest",
            path: "src/ops.cpp",
            kind: "function",
        });

        expect(result.text).toContain("void plain()");
        expect(result.text).not.toContain("vibes::hip::  void plain");

        // A member still carries its type, which is the case the prefix exists for.
        const members = await runDigest(source, {
            action: "digest",
            path: "src/ops.cpp",
            kind: "method",
        });

        expect(members.text).toContain("Ops::");
    });
});

describe("outline digest directory map layout", () => {
    function declarations(prefix: string, count: number): string {
        return Array.from(
            { length: count },
            (_, index) => `export function ${prefix}${index}(): number {\n    return ${index};\n}`,
        ).join("\n\n");
    }

    function source(): MemoryCodeSource {
        const files: Record<string, string> = {
            "src/big/empty.ts": 'import "./nothing";\n',
            "src/big/nested/deep.ts": declarations("deep", 1),
            "src/small/only.ts": declarations("only", 1),
            "src/third/x.ts": declarations("x", 1),
        };

        for (let index = 0; index < 12; index += 1) {
            files[`src/big/file-${index}-with-a-long-name.ts`] = declarations(`file${index}`, 1);
        }

        files["src/big/heavy.ts"] = declarations("heavy", 20);

        return new MemoryCodeSource("/project", files);
    }

    it("names a small directory before a large one takes a second line", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 560 });

        // Greedy size order spent the whole budget on `big/`; one line per directory per sweep is the fix.
        expect(result.text).toContain("only.ts");
        expect(result.text).toContain("x.ts");
        expect(result.text).toContain("# …");
    });

    it("shows a child directory as its own row instead of a longer file path", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 1200 });

        expect(result.text).toContain("nested/ 1");
        expect(result.text).not.toContain("nested/deep.ts");
    });

    it("puts the file with the most declarations first", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 1200 });

        expect(result.text.indexOf("heavy.ts (20)")).toBeLessThan(
            result.text.indexOf("file-0-with-a-long-name.ts"),
        );
    });

    it("drops the count for a file that declares nothing", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 1200 });

        expect(result.text).toContain("empty.ts");
        expect(result.text).not.toContain("empty.ts (0)");
    });

    it("suggests the three largest directories to descend into", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src", limit: 1200 });

        expect(result.text).toMatch(
            /# deeper: outline digest src\/big · outline digest src\/small · outline digest src\/third$/m,
        );
    });
});
