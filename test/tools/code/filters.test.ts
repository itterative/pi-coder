import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * Narrowing parameters: a `path` pattern keeps a result to part of the tree, `kind` to part of the declaration
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
    // No heading and no frontmatter: matches a `*.md` pattern without adding a declaration kind tests must count.
    "src/net/notes.md": "Plain notes with no heading.\n",
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline path pattern filter", () => {
    it("keeps search rows inside the matched path and says what it hid", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src/**/*.ts",
            query: "connect",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).not.toContain("lib/legacy/port.ts");
        expect(result.text).not.toContain("docs/guide.md");
        // The walker applies the pattern, so the cap counts matches and there is nothing to report as hidden.
        expect(result.text).toContain("# filter: path=src/**/*.ts");
    });

    it("matches a slash-free pattern against the basename at any depth", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "*.ts",
            query: "connect",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).toContain("lib/legacy/port.ts");
        expect(result.text).not.toContain("docs/guide.md");
        expect(result.text).toContain("# filter: path=*.ts");
        expect(result.text).not.toContain("hidden)");
    });

    it("supports brace alternatives and still names the filter when it hid nothing", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "*.{ts,md}",
            query: "connect",
        });

        expect(result.text).toContain("lib/legacy/port.ts");
        expect(result.text).toContain("docs/guide.md");
        expect(result.text).toContain("# filter: path=*.{ts,md}");
        expect(result.text).not.toContain("hidden)");
    });

    it("says so when the pattern matches no file", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "*.rs",
            query: "connect",
        });

        expect(result.text).toContain('# search "connect" in *.rs · no files match');
        expect(result.matches).toBe(0);
    });

    it("filters digest to the matched files", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/net/*.ts",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).not.toContain("lib/legacy/port.ts");
        expect(result.text).toContain("# filter: path=src/net/*.ts");
        expect(result.text).not.toContain("hidden)");
    });

    it("filters show to the matched files", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net/*.ts",
            query: "connect",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).not.toContain("lib/legacy/port.ts");
        expect(result.text).toContain("# filter: path=src/net/*.ts");
    });

    it("matches an absolute pattern in absolute paths", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "/project/src/net/*.ts",
            query: "connect",
        });

        expect(result.text).toContain("src/net/socket.ts");
        expect(result.text).not.toContain("lib/legacy/port.ts");
    });

    it("filters usages to the matched files", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "lib/**",
            query: "connect",
        });

        expect(result.text).toContain("lib/legacy/port.ts");
        expect(result.text).not.toContain("src/net/socket.ts");
        expect(result.text).toContain("# filter: path=lib/**");
    });
});

describe("outline kind aliases across languages", () => {
    function source(): MemoryCodeSource {
        return new MemoryCodeSource("/project", {
            "src/k.hpp": [
                "struct Buffer {",
                "    int size;",
                "};",
                "",
                "class Pool {",
                "    int count;",
                "};",
                "",
            ].join("\n"),
        });
    }

    it("treats struct and union as classes, because C++ has no class keyword for them", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "Buffer",
            kind: "class",
        });

        expect(result.text).toContain("Buffer");
        expect(result.text).toContain("kind=class");
    });

    it("names the kinds the tree does contain when a filter hides everything", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "nothinghere",
            kind: "enum",
        });

        expect(result.text).toContain("kinds here: field 2");
        expect(result.text).toContain("struct 1");
    });

    it("leads the histogram with the kinds that would answer a near-miss filter", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "nothinghere",
            kind: "class",
        });

        // The point of the histogram is the word the caller can retry with, not the most numerous kind.
        expect(result.text).toMatch(/kinds here: struct \d+/);
    });
});

describe("outline kind filter", () => {
    it("leads a method histogram with functions, the kind that would answer it", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "nothinghere",
            kind: "method",
        });

        // Sorting by count alone would list whatever is most numerous; a `method` filter is answered by `function`.
        expect(result.text).toMatch(/kinds here: function \d+/);
    });
    it("keeps only matching declaration rows in search", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            kind: "method",
        });

        expect(result.text).toContain("method  Port::connect");
        expect(result.text).not.toContain("function  connect ");
        expect(result.text).toContain("# filter: kind=method (3 declarations hidden)");
    });

    it("does not fall back to approximate rows of another kind", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: ".",
            query: "connect",
            kind: "class",
        });

        expect(result.matches).toBe(0);
        expect(result.text).toContain("no declarations or approximate matches");
        expect(result.text).toContain("# filter: kind=class (7 declarations hidden)");
    });

    it("lists only matching declarations in digest and reports the rest as hidden", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/net",
            kind: "class",
        });

        expect(result.text).toContain("no matching declarations");
        expect(result.text).toContain("kind=class");
        expect(result.text).not.toContain("connectClient");
    });

    it("names the container a kind-filtered member was taken out of", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: ".",
            kind: "method",
        });

        // The flat list has no tree to carry the owner, and `connect()` alone leaves "of which class" unanswered.
        expect(result.text).toContain("Port::  ");
        expect(result.text).toContain("connect");
    });

    it("renders a function-only digest flat instead of as empty containers", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: ".",
            kind: "function",
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
            kind: "function",
            limit: 600,
        });

        // The map would answer a different question: it names directories, not functions.
        expect(result.text).not.toContain("declarations exceed the");
        expect(result.text).toContain("unit");
        expect(result.text).toContain("# next: offset=");
        expect(result.text).toContain("kind=function");
    });
});
