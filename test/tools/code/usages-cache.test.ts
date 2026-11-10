import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const parseCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../src/tools/code/tree-sitter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/tools/code/tree-sitter")>();

    return {
        ...actual,
        parseSyntax: async (...args: Parameters<typeof actual.parseSyntax>) => {
            parseCalls.count += 1;

            return await actual.parseSyntax(...args);
        },
    };
});

beforeEach(() => {
    clearCodeCache();
    parseCalls.count = 0;
});

describe("outline usages cache", () => {
    it("parses a file once and reuses the identifier index across symbols", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/a.cpp": "void connect();\nvoid connect() { connect(); }\n",
        });

        const first = await runUsages(source, {
            action: "usages",
            path: "src",
            symbols: ["connect"],
        });

        expect(first.matches).toBeGreaterThan(0);
        expect(parseCalls.count).toBe(2);

        const second = await runUsages(source, {
            action: "usages",
            path: "src",
            symbols: ["connect", "connect"],
        });

        expect(second.matches).toBe(first.matches * 2);
        expect(parseCalls.count).toBe(2);
    });
});
