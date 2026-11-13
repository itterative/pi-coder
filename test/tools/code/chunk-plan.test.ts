import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import {
    CHUNK_MAX_CHARS,
    CHUNK_MIN_CHARS,
    CHUNK_OVERLAP_LINES,
    MAX_CHUNKS_PER_DECLARATION,
    chunksOf,
} from "../../../src/tools/code/semantic/chunks";
import { liveEntryKeys } from "../../../src/tools/code/semantic";
import { embeddingKey } from "../../../src/tools/code/semantic";
import type { Declaration, ParsedFile } from "../../../src/tools/code/types";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

async function parse(relative: string, source: string, mtime = 1): Promise<ParsedFile> {
    const memory = new MemoryCodeSource("/project", { [relative]: source }, { [relative]: mtime });

    return await parseSource(memory, `/project/${relative}`);
}

async function parseSource(memory: MemoryCodeSource, target: string): Promise<ParsedFile> {
    const loaded = await loadParsedFile(memory, target);

    if (loaded.kind !== "parsed") {
        throw new Error("expected a parsed file");
    }

    return loaded.parsed;
}

function declarationNamed(file: ParsedFile, name: string): Declaration {
    const declaration = file.all.find((candidate) => candidate.name === name);

    if (declaration === undefined) {
        throw new Error(`missing declaration ${name}`);
    }

    return declaration;
}

/** Roughly 30 characters per line, so a fixture's size is predictable from its line count. */
function filler(lines: number, prefix = "value"): string {
    return Array.from(
        { length: lines },
        (_, index) => `    const ${prefix}${index} = compute(${index});`,
    ).join("\n");
}

function longFunction(lines: number, name = "long"): string {
    return [`export function ${name}(): number {`, filler(lines), "    return 0;", "}", ""].join(
        "\n",
    );
}

describe("outline body chunks", () => {
    it("leaves a small body to the declaration's head vector", async () => {
        const file = await parse(
            "src/small.ts",
            ["export function small(): number {", filler(4), "    return 0;", "}", ""].join("\n"),
        );
        const declaration = declarationNamed(file, "small");

        expect(declaration.bodyRange!.endIndex - declaration.bodyRange!.startIndex).toBeLessThan(
            CHUNK_MIN_CHARS,
        );
        expect(chunksOf(file, declaration)).toEqual([]);
    });

    it("splits at nested declarations and collapses a chunked child to its signature line", async () => {
        const file = await parse(
            "src/nested.ts",
            [
                "export function outer(): number {",
                filler(6, "base"),
                "    function innerA(): number {",
                filler(40, "a"),
                "        return 0;",
                "    }",
                "    function innerB(): number {",
                filler(40, "b"),
                "        return 0;",
                "    }",
                "    return innerA() + innerB();",
                "}",
                "",
            ].join("\n"),
        );
        const outer = declarationNamed(file, "outer");
        const innerA = declarationNamed(file, "innerA");
        const chunks = chunksOf(file, outer);
        const innerChunks = chunksOf(file, innerA);
        const marker = "const a20 = compute(20);";

        expect(innerChunks.length).toBeGreaterThan(0);
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.map((chunk) => chunk.index)).toEqual(
            chunks.map((_, position) => position + 1),
        );
        expect(chunks.every((chunk) => chunk.total === chunks.length)).toBe(true);
        expect(
            chunks.every((chunk) =>
                chunk.text.startsWith(
                    `title: /project/src/nested.ts | text: function outer (§${chunk.index}/${chunk.total})`,
                ),
            ),
        ).toBe(true);
        // The parent keeps the child's signature for context, but not its statements: the child's own chunk owns
        // those, and duplicating them would mean two vectors and two rows for one span of code.
        expect(chunks.some((chunk) => chunk.text.includes("function innerA(): number {"))).toBe(
            true,
        );
        expect(innerChunks.some((chunk) => chunk.text.includes(marker))).toBe(true);
        expect(chunks.some((chunk) => chunk.text.includes(marker))).toBe(false);
    });

    it("cuts an oversized single block into line windows with overlap", async () => {
        const file = await parse("src/window.ts", longFunction(200));
        const chunks = chunksOf(file, declarationNamed(file, "long"));

        expect(chunks.length).toBeGreaterThan(1);

        for (const [position, chunk] of chunks.entries()) {
            const previous = chunks[position - 1];

            if (previous === undefined) {
                continue;
            }

            const overlapLines = previous.endLine - chunk.startLine + 1;

            expect(overlapLines).toBeGreaterThan(0);
            expect(overlapLines).toBeLessThanOrEqual(CHUNK_OVERLAP_LINES + 1);
            expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 400);
        }
    });

    it("caps an enormous declaration's chunk count", async () => {
        const file = await parse("src/huge.ts", longFunction(1_200, "huge"));
        const chunks = chunksOf(file, declarationNamed(file, "huge"));

        expect(chunks).toHaveLength(MAX_CHUNKS_PER_DECLARATION);
    });

    it("is deterministic across parses, so query keys match built vectors", async () => {
        const source = longFunction(200);
        // Distinct mtimes force two parses: the code cache would otherwise hand back one ParsedFile and the chunk
        // cache with it, which would make this test compare a plan with itself.
        const firstFile = await parse("src/window.ts", source, 1);
        const first = chunksOf(firstFile, declarationNamed(firstFile, "long"));
        const secondFile = await parse("src/window.ts", source, 2);
        const second = chunksOf(secondFile, declarationNamed(secondFile, "long"));

        expect(second.map((chunk) => [chunk.index, chunk.startLine, chunk.key])).toEqual(
            first.map((chunk) => [chunk.index, chunk.startLine, chunk.key]),
        );
    });

    it("invalidates only the chunks an edit touches", async () => {
        const source = longFunction(200);
        const edited = source.replace("compute(150)", "compute(151)");

        expect(edited.length).toBe(source.length);

        const beforeFile = await parse("src/window.ts", source, 1);
        const afterFile = await parse("src/window.ts", edited, 2);
        const before = chunksOf(beforeFile, declarationNamed(beforeFile, "long"));
        const after = chunksOf(afterFile, declarationNamed(afterFile, "long"));
        const beforeKeys = new Set(before.map((chunk) => chunk.key));
        const afterKeys = after.map((chunk) => chunk.key);
        const shared = afterKeys.filter((key) => beforeKeys.has(key));

        expect(shared.length).toBeGreaterThan(0);
        expect(shared.length).toBeLessThan(afterKeys.length);
        // The head is doc + comments + signature; an edit to a statement leaves it alone.
        expect(embeddingKey(afterFile, declarationNamed(afterFile, "long"))).toBe(
            embeddingKey(beforeFile, declarationNamed(beforeFile, "long")),
        );
    });

    it("counts heads and chunks as live entries", async () => {
        const file = await parse("src/window.ts", longFunction(200));
        const chunks = chunksOf(file, declarationNamed(file, "long"));

        expect(liveEntryKeys([file]).size).toBe(1 + chunks.length);
    });
});
