import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * Narrowing parameters: `glob` keeps a result to part of the tree, `declarationKind` to part of the declaration
 * space. Both report what they removed, because a smaller result must not read as "nothing matched".
 */
const FILES: Record<string, string> = {
    "src/net/socket.ts": [
        "export function connect(host: string): void {",
        "    socket.connect(host);",
        "}",
        "",
    ].join("\n"),
    "src/net/client.ts": [
        "export function connectClient(host: string): void {",
        "    socket.connect(host);",
        "}",
        "",
    ].join("\n"),
    "lib/legacy/port.ts": [
        "export class Port {",
        "    connect(host: string): void {",
        "        socket.connect(host);",
        "    }",
        "}",
        "",
    ].join("\n"),
    "docs/guide.md": "# Guide\n\nSocket connect notes.\n",
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline glob filter", () => {
    it("keeps search rows inside the matched path and says what it hid", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            glob: "src/**/*.ts",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).not.toContain("lib/legacy/port.ts");
        expect(result.text).not.toContain("docs/guide.md");
        expect(result.text).toContain("# filter: glob=src/**/*.ts (2 files hidden)");
    });

    it("matches a slash-free glob against the basename at any depth", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            glob: "*.ts",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).toContain("lib/legacy/port.ts");
        expect(result.text).not.toContain("docs/guide.md");
        expect(result.text).toContain("(1 file hidden)");
    });

    it("supports brace alternatives and still names the filter when it hid nothing", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            glob: "*.{ts,md}",
        });

        expect(result.text).toContain("lib/legacy/port.ts");
        expect(result.text).toContain("docs/guide.md");
        expect(result.text).toContain("# filter: glob=*.{ts,md}");
        expect(result.text).not.toContain("hidden)");
    });

    it("says so when the glob matches no file", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            glob: "*.rs",
        });

        expect(result.text).toContain("no files match glob=*.rs");
        expect(result.matches).toBe(0);
    });

    it("filters digest to the matched files", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: ".",
            glob: "src/net/*.ts",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).not.toContain("lib/legacy/port.ts");
        expect(result.text).toContain("# filter: glob=src/net/*.ts (2 files hidden)");
    });

    it("filters usages to the matched files", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: ".",
            symbols: ["connect"],
            glob: "lib/**",
        });

        expect(result.text).toContain("lib/legacy/port.ts");
        expect(result.text).not.toContain("src/net/socket.ts");
        expect(result.text).toContain("# filter: glob=lib/** (3 files hidden)");
    });
});

describe("outline declarationKind filter", () => {
    it("keeps only matching declaration rows in search", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            declarationKind: "method",
        });

        expect(result.text).toContain("method  Port::connect");
        expect(result.text).not.toContain("function  connect ");
        expect(result.text).toContain("# filter: declarationKind=method (3 declarations hidden)");
    });

    it("does not fall back to approximate rows of another kind", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            declarationKind: "class",
        });

        expect(result.matches).toBe(0);
        expect(result.text).toContain("no declarations or approximate matches");
        expect(result.text).toContain("# filter: declarationKind=class (7 declarations hidden)");
    });

    it("lists only matching declarations in digest and reports the rest as hidden", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/net",
            declarationKind: "class",
        });

        expect(result.text).toContain("no matching declarations");
        expect(result.text).toContain("declarationKind=class");
        expect(result.text).not.toContain("connectClient");
    });

    it("renders a function-only digest flat instead of as empty containers", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: ".",
            declarationKind: "function",
        });

        expect(result.text).toContain("function");
        expect(result.text).toContain("connectClient");
        expect(result.text).not.toContain("  class  Port");
    });

    it("pages a kind-filtered digest instead of degrading to a directory map", async () => {
        const files: Record<string, string> = {};

        for (let index = 0; index < 40; index += 1) {
            files[`src/pkg${index % 2}/unit${index}.ts`] = [
                `export function unit${index}(value: string): string {`,
                "    return value;",
                "}",
                "",
            ].join("\n");
        }

        const result = await runDigest(new MemoryCodeSource("/project", files), {
            action: "digest",
            path: ".",
            declarationKind: "function",
            limit: 600,
        });

        // The map would answer a different question: it names directories, not functions.
        expect(result.text).not.toContain("over character limit");
        expect(result.text).toContain("unit");
        expect(result.text).toContain("# next: offset=");
        expect(result.text).toContain("declarationKind=function");
    });
});
