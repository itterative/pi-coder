import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { parseCodeFile } from "../../../src/tools/code/parse";
import { MemoryCodeSource } from "../../helpers/code-source";

const SUITE = `import { beforeEach, describe, expect, it } from "vitest";

describe("outline digest", () => {
    beforeEach(() => {
        reset();
    });

    it("maps a module", async () => {
        const result = await runDigest(source(), { action: "digest" });

        expect(result.text).toContain("socket");
    });

    describe("nested detail", () => {
        it(\`lists files\`, () => {
            expect(1).toBe(1);
        });
    });
});
`;

const ROUTES = `const router = express.Router();

router.get("/users", (request, response) => {
    response.json([]);
});

console.log("starting");

watch("file", handler);

describe(\`suite \${name}\`, () => {
    expect(1).toBe(1);
});

describe(label, () => {
    expect(1).toBe(1);
});
`;

const FILES: Record<string, string> = {
    "test/suite.test.ts": SUITE,
    "src/routes.ts": ROUTES,
    "src/entry.ts": `import { start } from "./server";

start(process.env.PORT);
`,
    "src/barrel.ts": `export { start } from "./server";
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline blocks", () => {
    it("emits a block with its callee, its title, and the blocks inside it", async () => {
        const parsed = await parseCodeFile(SUITE, "/project/test/suite.test.ts", "typescript");
        const suite = parsed.roots[0];

        expect(suite?.kind).toBe("block");
        expect(suite?.name).toBe("outline digest");
        expect(suite?.blockCallee).toBe("describe");
        expect(suite?.signature).toBe('describe("outline digest")');
        expect(suite?.children.map((child) => child.qualifiedName)).toEqual([
            "outline digest::maps a module",
            "outline digest::nested detail",
        ]);
        expect(suite?.children[1]?.children[0]?.qualifiedName).toBe(
            "outline digest::nested detail::lists files",
        );
        // `beforeEach(() => ...)` has a callback but no name of its own, so it is not a block.
        expect(parsed.all.some((declaration) => declaration.name === "beforeEach")).toBe(false);
    });
    it("maps a test suite as a tree of blocks", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "test/suite.test.ts",
        });

        expect(result.text).toContain('describe "outline digest"  :3-19');
        expect(result.text).toContain('  it "maps a module"  :8-12');
        expect(result.text).toContain('  describe "nested detail"  :14-18');
        expect(result.text).toContain('    it "lists files"  :15-17');
        expect(result.text).not.toContain("[def]");
    });

    it("filters a flat list of blocks by kind", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "test/suite.test.ts",
            kind: "block",
        });

        expect(result.text).toContain('describe "outline digest"  :3-19');
        expect(result.text).toContain('it "lists files"  :15-17');
        expect(result.text).not.toContain("beforeEach");
    });

    it("extracts only calls with a literal name and a callback body", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src/routes.ts" });

        expect(result.text).toContain('router.get "/users"  :3-5');
        // A callback without a name, a name without a callback, an identifier handler, a substituted template, and
        // a non-literal name all describe a call rather than a named block.
        expect(result.text).not.toContain("starting");
        expect(result.text).not.toContain("watch");
        expect(result.text).not.toContain("suite");
        expect(result.text).not.toContain("label");
        // Only the router file, and the const that holds the router.
        expect(result.text).toContain("const router = express.Router()");
    });

    it("shows a suite's cases and a case's body", async () => {
        const suite = await runShow(source(), {
            action: "show",
            path: "test/suite.test.ts",
            query: "outline digest",
        });
        const leaf = await runShow(source(), {
            action: "show",
            path: "test/suite.test.ts",
            query: "maps a module",
        });

        expect(suite.text).toContain('· describe "outline digest" · 2 member(s)');
        expect(suite.text).toContain('it "maps a module"  :8-12');
        expect(leaf.text).toContain('· it "maps a module" · definition');
        expect(leaf.text).toContain('expect(result.text).toContain("socket");');
        expect(leaf.text).not.toContain("no public members");
    });

    it("reaches a case by a remembered piece of its title", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "test/suite.test.ts",
            query: "maps a mod",
        });

        expect(result.text).toContain('· it "maps a module" · definition');
        expect(result.text).toContain("1 matched by title text, not the full title");
        expect(result.text).toContain("maps a module (prefix of the title)");
    });

    it("renders a case row as its callee and title, with the suite in parentheses", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "test",
            query: "maps a module",
        });

        expect(result.text).toContain(
            'test/suite.test.ts:8-12  it  "maps a module"  (outline digest)',
        );
        // The signature is the title, so printing it too would say the same thing twice.
        expect(result.text).not.toContain('it("maps a module")');
        // The suite's own `[body]` row would put a case's line under the suite's heading.
        expect(result.text).not.toContain("[body]");
    });

    it("finds a case by the words of its title", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "test",
            query: "maps a module",
        });

        expect(result.text).toContain("test/suite.test.ts:8-12");
        expect(result.text).toContain("outline digest");
        expect(result.text).not.toContain("[def]");
    });

    it("groups usages under the block that contains them", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "test/suite.test.ts",
            query: "expect",
            kind: "call",
        });

        expect(result.text).toContain("outline digest::maps a module");
        expect(result.text).toContain(':11  expect(result.text).toContain("socket");');
    });

    it("names the call sites a script holds instead of reporting nothing", async () => {
        const script = await runDigest(source(), { action: "digest", path: "src/entry.ts" });
        const barrel = await runDigest(source(), { action: "digest", path: "src/barrel.ts" });

        expect(script.text).toContain(
            '# no declarations · 1 top-level call site · outline(action="flow", path="src/entry.ts") lists them',
        );
        expect(barrel.text).toContain(
            "# no declarations · no top-level statements (a re-export, a comment, or a file the parser could not read)",
        );
    });

    it("reports two cases with the same title as two labelled sections", async () => {
        const source = new MemoryCodeSource("/project", {
            "test/twins.test.ts": `describe("a", () => {
    it("throws", () => {
        expect(1).toBe(1);
    });
});

describe("b", () => {
    it("throws", () => {
        expect(2).toBe(2);
    });
});
`,
        });

        const result = await runShow(source, {
            action: "show",
            path: "test/twins.test.ts",
            query: "throws",
        });

        // Neither section is guessed away: the line ranges are what tell them apart.
        expect(result.text).toContain('#   test/twins.test.ts:2-4 · it "throws"');
        expect(result.text).toContain('#   test/twins.test.ts:8-10 · it "throws"');
        expect(result.text).toContain("2 declarations match; use a qualified name");
    });
});
