import { describe, expect, it } from "vitest";

import registerCodeTool from "../../../src/tools/code";
import { createPiStub, stubContext } from "../../helpers/pi-stub";

/** The merged `kind` slot and the pattern rejection are answered by the tool before any action runs. */
async function callTool(params: Record<string, unknown>): Promise<string> {
    const stub = createPiStub();

    registerCodeTool(stub.pi);

    const result = await stub
        .requireTool("outline")
        .execute("call-1", params, undefined, undefined, stubContext({ cwd: process.cwd() }));

    return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("outline merged kind parameter", () => {
    it("rejects a usage kind on digest", async () => {
        const text = await callTool({ action: "digest", path: ".", kind: "def" });

        expect(text).toBe(
            "# kind=def is a usage kind; digest takes declaration kinds like function or heading",
        );
    });

    it("rejects a usage kind on search", async () => {
        const text = await callTool({
            action: "search",
            path: ".",
            query: "connect",
            kind: "call",
        });

        expect(text).toBe(
            "# kind=call is a usage kind; search takes declaration kinds like function or heading",
        );
    });

    it("rejects a declaration kind on usages", async () => {
        const text = await callTool({
            action: "usages",
            path: ".",
            query: "connect",
            kind: "class",
        });

        expect(text).toBe("# kind=class is a declaration kind; usages takes def, call, or ref");
    });

    it("rejects kind on the actions that do not filter by it", async () => {
        expect(
            await callTool({ action: "show", path: ".", query: "connect", kind: "function" }),
        ).toBe("# kind applies to digest, search, and usages, not show");
        expect(await callTool({ action: "deps", path: "src/index.ts", kind: "function" })).toBe(
            "# kind applies to digest, search, and usages, not deps",
        );
    });
});

describe("outline merged path parameter", () => {
    it("rejects a pattern for deps", async () => {
        const text = await callTool({ action: "deps", path: "src/**" });

        expect(text).toBe("# deps takes a file, not a pattern: src/**");
    });
});
