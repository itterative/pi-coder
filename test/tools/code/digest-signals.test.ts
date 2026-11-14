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
        expect(result.text).toContain("gamma.ts queue.ts");
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
});
