import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

describe("outline search cache", () => {
    it("reuses per-file hits until the parsed file is replaced", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/a.cpp": "void connect();\nvoid connect() { connect(); }\n",
        });
        const first = await runSearch(source, {
            action: "search",
            path: "src",
            query: "connect",
        });

        expect(first.matches).toBeGreaterThan(0);

        const loaded = await loadParsedFile(source, "/project/src/a.cpp");

        expect(loaded.kind).toBe("parsed");

        if (loaded.kind !== "parsed") {
            throw new Error("expected a parsed file");
        }

        // The cached hits refer to the declarations, so removing them from `all` exposes a cache miss.
        loaded.parsed.all.length = 0;

        const second = await runSearch(source, {
            action: "search",
            path: "src",
            query: "connect",
        });

        expect(second.matches).toBe(first.matches);
        expect(second.text).toBe(first.text);
    });

    it("drops cached hits when the file stat changes", async () => {
        const source = new MemoryCodeSource("/project", {
            "src/a.cpp": "void connect();\nvoid connect() { connect(); }\n",
        });
        const originalStat = source.stat.bind(source);
        const originalRead = source.readFile.bind(source);
        let content = "void connect();\nvoid connect() { connect(); }\n";
        let mtimeMs = 1;

        vi.spyOn(source, "stat").mockImplementation(async (target) =>
            target.endsWith("/a.cpp")
                ? { isDirectory: false, isFile: true, size: content.length, mtimeMs }
                : originalStat(target),
        );
        vi.spyOn(source, "readFile").mockImplementation(async (target) =>
            target.endsWith("/a.cpp") ? content : originalRead(target),
        );

        const first = await runSearch(source, {
            action: "search",
            path: "src",
            query: "connect",
        });

        expect(first.matches).toBeGreaterThan(0);

        content = "void other();\n";
        mtimeMs = 2;

        const second = await runSearch(source, {
            action: "search",
            path: "src",
            query: "connect",
        });

        expect(second.matches).toBe(0);
    });
});
