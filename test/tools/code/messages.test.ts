import { beforeEach, describe, expect, it } from "vitest";

import { runDeps } from "../../../src/tools/code/deps";
import { runDigest } from "../../../src/tools/code/digest";
import { runFlow } from "../../../src/tools/code/flow";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const FILES: Record<string, string> = {
    "src/alpha.ts": `export function alpha(): number {
    return 1;
}
`,
    "src/beta.ts": `import { alpha } from "./alpha";

export function beta(): number {
    return alpha();
}
`,
    "src/gamma.ts": `// ghost is mentioned here but never declared.
export function gamma(): number {
    return 2;
}
`,
    "test/beta.test.ts": `import { beta } from "../src/beta";

describe("beta", () => {
    it("returns one", () => {
        expect(beta()).toBe(1);
    });
});
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline message honesty", () => {
    it("counts one file as one file", async () => {
        const result = await runDigest(source(), { action: "digest", path: "src/alpha.ts" });

        expect(result.text).toContain("· 1 file ·");
        expect(result.text).not.toContain("1 files");
    });

    it("names an unnamed scope as the whole tree, not a dot", async () => {
        const shown = await runShow(source(), { action: "show", query: "beta" });
        const depended = await runDeps(source(), { action: "deps", path: "src/gamma.ts" });

        expect(shown.text).toContain("# show (whole tree) beta");
        expect(depended.text).toContain("# no file under (whole tree) imports it");
    });

    it("points a zero-hit usages result at the wider search", async () => {
        // The name is mentioned in a comment, so the file is discovered and parsed, but no identifier carries it.
        const result = await runUsages(source(), {
            action: "usages",
            path: "src",
            query: "ghost",
        });

        expect(result.text).toContain("# no usages found in src");
        expect(result.text).toContain(
            '# next: outline(action="usages", path=".", query="ghost") searches the whole tree',
        );
    });

    it("points a scope-less flow result at the digest that names scopes", async () => {
        const result = await runFlow(source(), {
            action: "flow",
            path: "test/beta.test.ts",
            query: "no such suite",
        });

        expect(result.text).toContain("# no call sites in a scope matching that query");
        expect(result.text).toContain(
            '# next: outline(action="digest", path=...) lists what the file declares',
        );
    });

    it("warns that a one-character query is a substring scan", async () => {
        const result = await runSearch(source(), { action: "search", path: "src", query: "a" });

        expect(result.text).toContain("# note: a one-character query matches by substring only");
    });
});
