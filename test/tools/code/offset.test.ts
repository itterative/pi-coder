import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { renderWithinBudget } from "../../../src/tools/code/format";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const MANY_FUNCTIONS = [
    "namespace demo {",
    ...Array.from(
        { length: 300 },
        (_, index) => `void function_number_${String(index).padStart(3, "0")}() {}`,
    ),
    "void last_function() {}",
    "}",
].join("\n");

const BIG_FUNCTION = [
    "void big_function() {",
    ...Array.from({ length: 120 }, (_, index) => `    int value_${index} = ${index};`),
    "}",
].join("\n");

const MANY_USES = [
    "void target();",
    "void caller() {",
    ...Array.from({ length: 120 }, () => "    target();"),
    "}",
].join("\n");

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "many.cpp": MANY_FUNCTIONS,
        "big.cpp": BIG_FUNCTION,
        "uses.cpp": MANY_USES,
    });
}

function nextOffset(text: string): number | undefined {
    const match = /# next: offset=(\d+)/u.exec(text);

    return match === null ? undefined : Number(match[1]);
}

async function collectPages(run: (offset: number) => Promise<string>): Promise<string> {
    const pages: string[] = [];
    let offset = 0;

    for (let page = 0; page < 100; page += 1) {
        const text = await run(offset);

        pages.push(text);

        const next = nextOffset(text);

        if (next === undefined || next <= offset) {
            break;
        }

        offset = next;
    }

    return pages.join("\n");
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline output offsets", () => {
    it("joins whole blocks and points at the first omitted block", () => {
        const limit = "H".length + "a\nb".length + 1;
        const first = renderWithinBudget("H", ["a\nb", "c\nd"], limit);

        expect(first.truncated).toBe(true);
        expect(first.nextOffset).toBe(3);
        expect(first.text).toContain("a\nb");
        expect(first.text).toContain("# omitted 1 more block(s)");

        const second = renderWithinBudget("H", ["a\nb", "c\nd"], limit, first.nextOffset);

        expect(second.truncated).toBe(true);
        expect(second.nextOffset).toBeUndefined();
        expect(second.text).toContain("c\nd");
        expect(second.text).not.toContain("a\nb");
    });

    it("resumes inside one oversized block", () => {
        const body = Array.from({ length: 20 }, (_, index) => `line_${index}`).join("\n");
        const limit = "H".length + 10;
        const first = renderWithinBudget("H", [body], limit);

        expect(first.nextOffset).toBeDefined();

        const offset = first.nextOffset ?? 0;
        const second = renderWithinBudget("H", [body], limit, offset);

        expect(offset).toBeGreaterThan(0);
        expect(second.text).toContain(`line_${offset}`);
        expect(second.text).not.toContain("line_0\n");
    });

    it("reports the limit needed when a line cannot fit", () => {
        const result = renderWithinBudget("H", ["x".repeat(200)], 2);

        expect(result.text).toContain(
            "# … the next block needs about 202 chars; raise limit to at least 202 to show it, or continue with offset=",
        );
        expect(result.nextOffset).toBeUndefined();
    });

    it("reports an offset beyond the end", () => {
        const result = renderWithinBudget("H", ["a\nb"], 100, 99);

        expect(result.truncated).toBe(false);
        expect(result.nextOffset).toBeUndefined();
        expect(result.text).toContain("beyond the end");
    });

    it("pages a fitting directory digest instead of falling back to the map", async () => {
        const small = new MemoryCodeSource("/project", {
            "small/a.cpp": "void alpha();\nvoid beta();\n",
            "small/b.cpp": "void gamma();\n",
        });
        const result = await runDigest(small, {
            action: "digest",
            path: "small",
            limit: 400,
            offset: 2,
        });

        expect(result.text).toContain("void beta()");
        expect(result.text).toContain("void gamma()");
        expect(result.text).not.toContain("declarations exceed the");
        expect(result.truncated).toBe(true);
    });

    it("reports an offset beyond a digest body", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "many.cpp",
            limit: 800,
            offset: 9_999,
        });

        expect(result.text).toContain("beyond the end");
        expect(result.truncated).toBe(false);
    });

    it("pages a single-file digest to the end", async () => {
        const text = await collectPages(async (offset) => {
            const result = await runDigest(source(), {
                action: "digest",
                path: "many.cpp",
                limit: 800,
                offset,
            });

            return result.text;
        });

        expect(text).toContain("function_number_000");
        expect(text).toContain("function_number_299");
        expect(text).toContain("last_function");
    });

    it("reports a show continuation as a source line read can resume from", async () => {
        const first = await runShow(source(), {
            action: "show",
            path: "big.cpp",
            query: "big_function",
            limit: 300,
        });
        const offset = nextOffset(first.text);

        expect(first.text).toContain("(source line)");
        expect(offset).toBeGreaterThan(1);
        // `void big_function() {` is line 1, so `int value_N` is source line N + 2.
        expect(offset).toBeLessThanOrEqual(122);

        const resumed = await runShow(source(), {
            action: "show",
            path: "big.cpp",
            query: "big_function",
            limit: 300,
            offset: offset ?? 0,
        });

        // The page starts at the line the note named, exactly as `read offset=<line>` would.
        expect(resumed.text).toContain(`int value_${(offset ?? 0) - 2} = `);
    });

    it("keeps body-line offsets when a show result spans two files", async () => {
        const twoFiles = new MemoryCodeSource("/project", {
            "a.hpp": "void connect(int port);\n",
            "b.cpp": [
                "void connect(int port) {",
                ...Array.from({ length: 120 }, (_, index) => `    int value_${index} = ${index};`),
                "}",
                "",
            ].join("\n"),
        });
        const result = await runShow(twoFiles, {
            action: "show",
            path: ".",
            query: "connect",
            detail: "full",
            limit: 400,
        });

        // A source line cannot say which of the two files it is in, so the older body-line contract stands.
        expect(result.text).toMatch(/# next: offset=\d+/);
        expect(result.text).not.toContain("(source line)");

        const resumed = await runShow(twoFiles, {
            action: "show",
            path: ".",
            query: "connect",
            detail: "full",
            limit: 400,
            offset: nextOffset(result.text) ?? 0,
        });

        expect(resumed.text).toContain("int value_0 = 0;");
    });

    it("keeps blank lines so a source-line offset maps one-to-one", async () => {
        const lines = ["void spaced() {"];

        for (let index = 0; index < 40; index += 1) {
            lines.push(`    int value_${index} = ${index};`, "");
        }

        lines.push("}", "");
        const spaced = new MemoryCodeSource("/project", { "spaced.cpp": lines.join("\n") });
        const first = await runShow(spaced, {
            action: "show",
            path: "spaced.cpp",
            query: "spaced",
            limit: 300,
        });
        const offset = nextOffset(first.text) ?? 0;

        // A dropped blank line would shift every later line against the file.
        expect(first.text).toContain("int value_0 = 0;\n\n    int value_1 = 1;");
        expect(offset).toBeGreaterThan(1);

        const resumed = await runShow(spaced, {
            action: "show",
            path: "spaced.cpp",
            query: "spaced",
            limit: 300,
            offset,
        });

        expect(resumed.text).toContain(lines.slice(offset - 1, offset + 2).join("\n"));
    });

    it("pages a show body to the end", async () => {
        const text = await collectPages(async (offset) => {
            const result = await runShow(source(), {
                action: "show",
                path: "big.cpp",
                query: "big_function",
                limit: 800,
                offset,
            });

            return result.text;
        });

        expect(text).toContain("value_0 ");
        expect(text).toContain("value_119");
    });

    it("pages search results to the end", async () => {
        const text = await collectPages(async (offset) => {
            const result = await runSearch(source(), {
                action: "search",
                path: "many.cpp",
                query: "function_number",
                limit: 800,
                offset,
            });

            return result.text;
        });

        expect(text).toContain("function_number_000");
        expect(text).toContain("function_number_299");
    });

    it("pages usages to the end", async () => {
        const text = await collectPages(async (offset) => {
            const result = await runUsages(source(), {
                action: "usages",
                path: "uses.cpp",
                query: "target",
                limit: 800,
                offset,
            });

            return result.text;
        });

        expect(text).toContain(":1  void target();");
        expect(text).toContain(":122  target();");
    });
});
