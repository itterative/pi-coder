import { beforeEach, describe, expect, it } from "vitest";

import { clearCodeCache, loadParsedFile } from "../../../src/tools/code/load";
import { MemoryCodeSource } from "../../helpers/code-source";

beforeEach(() => {
    clearCodeCache();
});

describe("parsed-file cache", () => {
    it("keeps an early entry across a scan larger than the old FIFO limit", async () => {
        const files: Record<string, string> = {};

        for (let index = 0; index < 140; index += 1) {
            files[`src/f${String(index)}.cpp`] = `void f${String(index)}();\n`;
        }

        const source = new MemoryCodeSource("/project", files);
        const target = "/project/src/f0.cpp";
        const first = await loadParsedFile(source, target);

        expect(first.kind).toBe("parsed");

        for (let index = 1; index < 140; index += 1) {
            await loadParsedFile(source, `/project/src/f${String(index)}.cpp`);
        }

        const second = await loadParsedFile(source, target);

        expect(first.kind).toBe("parsed");
        expect(second.kind).toBe("parsed");

        if (first.kind === "parsed" && second.kind === "parsed") {
            expect(second.parsed).toBe(first.parsed);
        }
    });
});
