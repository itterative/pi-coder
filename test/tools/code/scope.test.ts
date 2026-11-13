import { beforeEach, describe, expect, it } from "vitest";

import registerCodeTool from "../../../src/tools/code";
import { clearCodeCache } from "../../../src/tools/code/load";
import { parseWithin, withinScope } from "../../../src/tools/code/scope";
import { runSearch } from "../../../src/tools/code/search";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";
import { createPiStub, stubContext } from "../../helpers/pi-stub";

const APP = [
    'import { download } from "./store/artifact";',
    "",
    "export function handler(name: string): string {",
    "    return download(name);",
    "}",
    "",
].join("\n");

const ARTIFACT = [
    'import { retry } from "./retry";',
    "",
    "export function download(name: string): string {",
    "    return retry(name);",
    "}",
    "",
].join("\n");

const RETRY = ["export function retry(name: string): string {", "    return name;", "}", ""].join(
    "\n",
);

const OTHER = ["export function downloadOther(): string {", '    return "other";', "}", ""].join(
    "\n",
);

const HELPER = [
    'import { retry } from "../src/store/retry";',
    'import { sibling } from "./sibling";',
    "",
    "export function downloadHelper(name: string): string {",
    "    return retry(sibling(name));",
    "}",
    "",
].join("\n");

const SIBLING = ["export function sibling(name: string): string { return name; }", ""].join("\n");

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "src/app.ts": APP,
        "src/store/artifact.ts": ARTIFACT,
        "src/store/retry.ts": RETRY,
        "src/store/other.ts": OTHER,
        "lib/helper.ts": HELPER,
        "lib/sibling.ts": SIBLING,
    });
}

beforeEach(() => {
    clearCodeCache();
});

/** A source whose readability check cannot stat, the way a container source answers over the protocol. */
class ContainerLikeSource extends MemoryCodeSource {
    override async assertReadable(): Promise<void> {
        // The mount set is the boundary; a missing file is reported by the read, not by this check.
    }
}

describe("outline within parsing", () => {
    it("defaults to imports and accepts an explicit direction", () => {
        expect(parseWithin("src/app.ts")).toEqual({
            direction: "imports",
            anchor: "src/app.ts",
        });
        expect(parseWithin("dependents:src/app.ts")).toEqual({
            direction: "dependents",
            anchor: "src/app.ts",
        });
        expect(parseWithin("imports:src/app.ts")).toEqual({
            direction: "imports",
            anchor: "src/app.ts",
        });
    });

    it("treats an unknown prefix as part of the path and an empty anchor as an error", () => {
        expect(parseWithin("notes:app.ts")).toEqual({
            direction: "imports",
            anchor: "notes:app.ts",
        });
        expect(parseWithin("dependents:")).toHaveProperty("error");
    });

    it("reports a missing anchor a container source cannot detect up front", async () => {
        const result = await withinScope({
            source: new ContainerLikeSource("/project", { "src/app.ts": APP }),
            root: "/project",
            raw: "src/missing.ts",
            parsed: [],
        });

        expect(result).toEqual({ error: "# within: no such file: src/missing.ts" });
    });

    it("reports a missing anchor and an unsupported one", async () => {
        const missing = await withinScope({
            source: source(),
            root: "/project",
            raw: "missing.ts",
            parsed: [],
        });
        const unsupported = await withinScope({
            source: new MemoryCodeSource("/project", { "notes.txt": "hello\n" }),
            root: "/project",
            raw: "notes.txt",
            parsed: [],
        });

        expect(missing).toEqual({ error: "# within: no such file: missing.ts" });
        expect(unsupported).toEqual(
            expect.objectContaining({
                error: expect.stringContaining("is not a supported source file"),
            }),
        );
    });
});

describe("outline search within a dependency neighbourhood", () => {
    it("searches the anchor and its direct imports only", async () => {
        const result = await runSearch(source(), {
            action: "search",
            query: "download",
            within: "src/app.ts",
        });

        expect(result.files).toBe(2);
        expect(result.text).toContain("src/app.ts");
        expect(result.text).toContain("src/store/artifact.ts");
        expect(result.text).not.toContain("src/store/retry.ts");
        expect(result.text).not.toContain("src/store/other.ts");
        expect(result.text).toContain("# within: imports of src/app.ts · 2 files");
    });

    it("searches the files that import the anchor with the dependents prefix", async () => {
        const result = await runSearch(source(), {
            action: "search",
            query: "download",
            within: "dependents:src/store/retry.ts",
        });

        // `helper` imports `retry` too, so it is a dependent even though it lives outside `src`.
        expect(result.files).toBe(3);
        expect(result.text).toContain("src/store/artifact.ts");
        expect(result.text).toContain("lib/helper.ts");
        expect(result.text).not.toContain("src/app.ts");
        expect(result.text).toContain("# within: dependents of src/store/retry.ts · 3 files");
    });

    it("keeps an anchor that lives outside the searched path and counts neighbours outside it", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "download",
            within: "../lib/helper.ts",
        });

        expect(result.files).toBe(2);
        expect(result.text).toContain("lib/helper.ts");
        expect(result.text).toContain("# within: imports of lib/helper.ts · 2 files");
    });

    it("resolves a relative anchor against path", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "download",
            within: "store/artifact.ts",
        });

        // `src/store/artifact.ts` is the anchor, not `<cwd>/store/artifact.ts`.
        expect(result.files).toBe(2);
        expect(result.text).toContain("# within: imports of src/store/artifact.ts · 2 files");
    });

    it("counts a neighbour hidden by the path pattern as outside the searched path", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "**/src/**",
            query: "download",
            within: "lib/helper.ts",
        });

        // `retry` matches the pattern, `sibling` does not: the anchor's edge to it is still real.
        expect(result.files).toBe(2);
        expect(result.text).toContain("# filter: path=**/src/**");
        expect(result.text).toContain(
            "# within: imports of lib/helper.ts · 2 files (1 file outside the searched path)",
        );
    });

    it("intersects with a path pattern and still names both narrowings", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "**/artifact.ts",
            query: "download",
            within: "src/app.ts",
        });

        expect(result.files).toBe(2);
        expect(result.text).toContain("# filter: path=**/artifact.ts");
        expect(result.text).toContain("# within: imports of src/app.ts · 2 files");
    });

    it("answers a within error in the tool's own words", async () => {
        const result = await runSearch(source(), {
            action: "search",
            query: "download",
            within: "imports:",
        });

        expect(result.text).toBe('# within needs a file · within="imports:<file>"');
    });
});

describe("outline usages within a dependency neighbourhood", () => {
    it("scans the anchor and its direct imports only", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            query: "retry",
            within: "src/app.ts",
        });

        expect(result.text).toContain("src/store/artifact.ts");
        expect(result.text).not.toContain("lib/helper.ts");
        expect(result.text).toContain("# within: imports of src/app.ts · 2 files");
    });
});

describe("outline within on other actions", () => {
    it("rejects within outside search and usages", async () => {
        const stub = createPiStub();

        registerCodeTool(stub.pi);

        const result = await stub
            .requireTool("outline")
            .execute(
                "call-1",
                { action: "digest", path: ".", within: "src/index.ts" },
                undefined,
                undefined,
                stubContext({ cwd: process.cwd() }),
            );
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";

        expect(text).toBe("# within applies to search and usages, not digest");
    });
});
