import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { MemoryCodeSource } from "../../helpers/code-source";

/**
 * Literal body-text rows (`[body]`).
 *
 * The fixture is about a download that fails its checksum: no declaration is named after the message, so only the
 * body channel can put the caller on the function that throws it.
 */
const ARTIFACT = [
    "export async function download(spec: string): Promise<void> {",
    "    const response = await fetch(spec);",
    "",
    "    // The digest comparison is the last line of defence.",
    "    if (digest !== expected) {",
    "        throw new Error(`${spec} failed its checksum`);",
    "    }",
    "}",
    "",
].join("\n");

const RETRY = [
    "export function runWithRetry(task: () => void): void {",
    "    // retry with backoff, capped at four attempts",
    "    for (let attempt = 0; attempt < 4; attempt += 1) {",
    "        task();",
    "    }",
    "    // retry with backoff means the comment appears twice",
    "}",
    "",
].join("\n");

const SERVICE = [
    "export class Service {",
    "    handle(): void {",
    "        // quiet fallback keeps the last good value",
    "        this.value ??= fallback;",
    "    }",
    "}",
    "",
].join("\n");

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", {
        "src/store/artifact.ts": ARTIFACT,
        "src/store/retry.ts": RETRY,
        "src/service.ts": SERVICE,
    });
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline search body text", () => {
    it("returns the declaration that contains an exact text query", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "failed its checksum",
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain("1 by body text");
        expect(result.text).toContain("function  download");
        expect(result.text).toContain("[body]");
        // The evidence line, not just the declaration: the throw is on line 6 of the fixture.
        expect(result.text).toMatch(/:6 {2}throw new Error\(`\$\{spec\} failed its checksum`\);/);
        expect(result.text).toContain("# body: the row names the declaration");
    });

    it("does not body-match a single-word identifier query", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "checksum",
        });

        expect(result.text).not.toContain("[body]");
    });

    it("collapses repeated occurrences into one row with a count", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "retry with backoff",
        });

        expect(result.matches).toBe(1);
        expect(result.text).toContain("function  runWithRetry");
        expect(result.text).toContain("×2");
    });

    it("attributes a nested match to the innermost declaration", async () => {
        const result = await runSearch(source(), {
            action: "search",
            path: "src",
            query: "quiet fallback",
        });

        expect(result.text).toContain("method  Service::handle");
        // The class row would repeat the same text one scope up.
        expect(result.text).not.toContain("  class  Service");
    });

    it("moves the evidence onto a row the name or doc channel already listed", async () => {
        const result = await runSearch(
            new MemoryCodeSource("/project", {
                "src/ledger.ts": [
                    "/** Parses the ledger twice. */",
                    "export function parseLedger(text: string): number[] {",
                    "    // parses the ledger twice",
                    "    return [];",
                    "}",
                    "",
                ].join("\n"),
            }),
            { action: "search", path: "src", query: "parses the ledger twice" },
        );

        // One declaration, one row: the body row used to repeat the location and carry the evidence alone.
        expect(result.text.match(/src\/ledger\.ts:2-5/g)).toHaveLength(1);
        expect(result.text).toContain("[doc]");
        expect(result.text).toContain(":3  // parses the ledger twice");
    });

    it("caps body rows when a doc match already leads", async () => {
        const files: Record<string, string> = {
            "src/retry.ts": [
                "/** retry with backoff when a call fails. */",
                "export function retryWithBackoff(task: () => void): void {",
                "    task();",
                "}",
                "",
            ].join("\n"),
        };

        for (let index = 0; index < 5; index += 1) {
            files[`src/other${index}.ts`] = [
                `export function other${index}(): void {`,
                "    // retry with backoff",
                "}",
                "",
            ].join("\n");
        }

        const capped = await runSearch(new MemoryCodeSource("/project", files), {
            action: "search",
            path: "src",
            query: "retry with backoff",
        });

        expect(capped.text.match(/\[body\]/g)).toHaveLength(3);
        expect(capped.text).toContain("# body: 2 more declarations withheld");
        expect(capped.text).toContain("the page keeps the strongest rows");
    });

    it("leaves Markdown prose to the doc channel", async () => {
        const markdown = new MemoryCodeSource("/project", {
            "notes/guide.md": [
                "# Retry",
                "",
                "A retry with backoff is capped at four attempts.",
                "",
            ].join("\n"),
        });

        const result = await runSearch(markdown, {
            action: "search",
            path: "notes",
            query: "retry with backoff",
        });

        expect(result.text).toContain("[doc]");
        expect(result.text).not.toContain("[body]");
    });

    it("shows the line the query hits, not the first line holding any of its words", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/dl.ts": [
                "export function download(spec: string): void {",
                "    // failed requests are retried by the caller",
                "    throw new Error(`checksum failed: ${spec}`);",
                "}",
                "",
            ].join("\n"),
        });
        const result = await runSearch(source, {
            action: "search",
            path: "src",
            query: "failed checksum",
        });

        // Line 2 holds "failed" and no "checksum"; the longest query word is the better evidence line.
        expect(result.text).toMatch(/:3 {2}throw new Error/);
        expect(result.text).not.toMatch(/:2 {2}\/\/ failed requests/);
    });
});
