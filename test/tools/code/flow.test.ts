import { beforeEach, describe, expect, it } from "vitest";

import { runFlow } from "../../../src/tools/code/flow";
import { clearCodeCache } from "../../../src/tools/code/load";
import { MemoryCodeSource } from "../../helpers/code-source";

const MAIN = `import { start } from "./server";

const config = loadConfig(process.env.CONFIG);

start(config, () => {
    console.log("ready");
});

watch("events");
`;

const SUITES = `describe("flow root", () => {
    it("first case", () => {
        expect(one()).toBe(1);
    });

    it("second case", () => {
        expect(two()).toBe(2);
    });
});

describe("flow root", () => {
    it("third case", () => {
        expect(three()).toBe(3);
    });
});
`;

const FILES: Record<string, string> = {
    "src/main.ts": MAIN,
    "test/suites.test.ts": SUITES,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline flow", () => {
    it("lists a script's call sites in source order, one row per call expression", async () => {
        const result = await runFlow(source(), { action: "flow", path: "src/main.ts" });

        expect(result.text).toContain("# flow src/main.ts · 1 file · 4 call sites · typescript");
        expect(result.text).toContain("src/main.ts  · 4 call sites · 1 scope");
        expect(result.text).toContain("  file");
        // The callee and its arguments, not the source line: a row is the unit a reader scans.
        expect(result.text).toContain("    loadConfig(process.env.CONFIG)  :3");
        expect(result.text).toContain('    start(config, () => { console.log("ready"); })  :5');
        expect(result.text).toContain('    console.log("ready")  :6');
        expect(result.text).toContain('    watch("events")  :9');
        // The identifiers inside one call expression are one row, not one row each.
        expect(result.text.match(/loadConfig/g) ?? []).toHaveLength(1);
        expect(result.matches).toBe(4);
    });

    it("keeps a multi-line call on one row", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/multiline.ts": `connect(
    "localhost",
    8080,
);
`,
        });
        const result = await runFlow(source, { action: "flow", path: "src/multiline.ts" });

        expect(result.text).toContain('connect("localhost", 8080)  :1');
    });

    it("aggregates a directory, one block per file", async () => {
        const result = await runFlow(source(), { action: "flow", path: "src" });

        expect(result.text).toContain("# flow src · 1 file · 4 call sites");
        expect(result.text).toContain("src/main.ts  · 4 call sites · 1 scope");
        expect(result.text).toContain('    watch("events")  :9');
    });

    it("groups call sites under the block that owns them", async () => {
        const result = await runFlow(source(), { action: "flow", path: "test/suites.test.ts" });

        // A call that opens a block is the block's heading, not a paragraph of its parent: the suite's own call
        // prints as `describe  :1`, and its cases collapse into one counted row.
        expect(result.text).toContain("  file");
        expect(result.text).toContain("    describe  ×2  :1,:11");
        expect(result.text).toContain('  describe "flow root"  :1-9');
        expect(result.text).toContain("    it  ×2  :2,:6");
        expect(result.text).toContain('  it "second case"  :6-8');
        expect(result.text).toContain("    expect(two()).toBe(2)  :7");
    });

    it("narrows to the scopes a query names, listing each match", async () => {
        const result = await runFlow(source(), {
            action: "flow",
            path: "test/suites.test.ts",
            query: "flow root",
        });

        // Two suites share the title, so both are listed under their own range instead of being guessed between.
        expect(result.text).toContain('# flow "flow root" in test/suites.test.ts');
        expect(result.text).toContain('  describe "flow root"  :1-9');
        expect(result.text).toContain('  describe "flow root"  :11-15');
        expect(result.text).not.toContain("    describe  :1");
        expect(result.matches).toBe(3);
    });

    it("says so when a query names no scope with a call", async () => {
        const result = await runFlow(source(), {
            action: "flow",
            path: "test/suites.test.ts",
            query: "no such suite",
        });

        expect(result.text).toContain("# no call sites in a scope matching that query");
        expect(result.text).toContain("# scope: query selects scopes by name; digest lists them");
        expect(result.matches).toBe(0);
    });

    it("caps one scope's rows and counts the rest", async () => {
        const calls = Array.from({ length: 45 }, (_, index) => `call${index}();`).join("\n");
        const source = new MemoryCodeSource("/project", { "src/many.ts": `${calls}\n` });

        const result = await runFlow(source, { action: "flow", path: "src/many.ts" });

        expect(result.text).toContain("45 call sites");
        expect(result.text).toContain("# +5 more call site(s) in this scope");
        expect(result.matches).toBe(45);
    });

    it("resumes a cut result with the offset it reports", async () => {
        const first = await runFlow(source(), {
            action: "flow",
            path: "test/suites.test.ts",
            limit: 200,
        });

        expect(first.truncated).toBe(true);
        expect(first.text).toContain("# next: offset=");

        const offset = Number(/# next: offset=(\d+)/.exec(first.text)?.[1] ?? "0");
        const second = await runFlow(source(), {
            action: "flow",
            path: "test/suites.test.ts",
            limit: 200,
            offset,
        });

        expect(second.text).not.toBe(first.text);
    });

    it("reports a file with no calls instead of an empty body", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/types.ts": "export type Id = string;\n",
        });

        const result = await runFlow(source, { action: "flow", path: "src/types.ts" });

        expect(result.text).toContain("# flow src/types.ts");
        expect(result.text).toContain("# no call sites");
        expect(result.matches).toBe(0);
    });
});
