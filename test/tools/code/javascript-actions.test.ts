import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const FILES: Record<string, string> = {
    "src/js/runner.js": `export class Runner {
    constructor(value) {
        this.value = value;
    }

    run(input) {
        const helper = (x) => x + this.value;
        return helper(input);
    }
}

export function makeRunner(value) {
    return new Runner(value);
}
`,
    "src/js/closure.js": `export function outer() {
    const local = 1;
    const inner = () => local;
    return inner();
}
`,
    "src/js/component.jsx": `export default function App({ label }) {
    return <section>{label}</section>;
}
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline on JavaScript", () => {
    it("digests JavaScript and JSX files", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/js",
        });

        expect(result.text).toContain("# digest src/js · 3 files · javascript ·");
        expect(result.text).toContain("export class Runner  :1-10");
        expect(result.text).toContain("export default function App");
        expect(result.text).toContain("const inner = () => local");
        expect(result.parseErrors).toBe(0);
    });

    it("shows a nested JavaScript closure", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/js/closure.js",
            symbols: ["outer::inner"],
        });

        expect(result.text).toContain("function outer::inner · definition");
        expect(result.text).toContain("const inner = () => local");
    });

    it("finds JavaScript definitions and calls", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/js",
            symbols: ["Runner"],
        });

        expect(result.text).toContain("src/js/runner.js");
        expect(result.text).toContain("[def]");
        expect(result.text).toContain("[call]");
        expect(result.matches).toBeGreaterThanOrEqual(2);
    });

    it("searches JavaScript declarations", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src/js",
            query: "makeRunner",
        });

        expect(result.text).toContain("function  makeRunner");
        expect(result.matches).toBe(1);
    });
});
