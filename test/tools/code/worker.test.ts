import { describe, expect, it } from "vitest";

import {
    WORKER_PARSE_THRESHOLD_BYTES,
    buildUsageIndexInWorker,
    parseFileInWorker,
} from "../../../src/tools/code/worker";

describe("outline parse worker", () => {
    it("parses a large file and builds its usage index off the main thread", async () => {
        const source = `void target();\n${"// padding\n".repeat(24_000)}`;

        expect(Buffer.byteLength(source)).toBeGreaterThan(WORKER_PARSE_THRESHOLD_BYTES);

        const parsed = await parseFileInWorker(source, "/virtual/large.cpp", "cpp");

        expect(parsed?.all.some((declaration) => declaration.name === "target")).toBe(true);

        if (parsed === undefined) {
            return;
        }

        const index = await buildUsageIndexInWorker(parsed);

        expect(index?.entries.some((entry) => entry.name === "target")).toBe(true);
    }, 10_000);

    it("parses a large TypeScript file and builds its usage index in the worker", async () => {
        const source = `export function target(): void {}\n${"// padding\n".repeat(24_000)}`;

        expect(Buffer.byteLength(source)).toBeGreaterThan(WORKER_PARSE_THRESHOLD_BYTES);

        const parsed = await parseFileInWorker(source, "/virtual/large.ts", "typescript");

        expect(parsed?.all.some((declaration) => declaration.name === "target")).toBe(true);

        if (parsed === undefined) {
            return;
        }

        const index = await buildUsageIndexInWorker(parsed);

        expect(index?.entries.some((entry) => entry.name === "target")).toBe(true);
    }, 10_000);

    it("parses a large Java file and builds its usage index in the worker", async () => {
        const source = `public class Target { void target() {} }\n${"// padding\n".repeat(24_000)}`;

        expect(Buffer.byteLength(source)).toBeGreaterThan(WORKER_PARSE_THRESHOLD_BYTES);

        const parsed = await parseFileInWorker(source, "/virtual/Target.java", "java");

        expect(parsed?.all.some((declaration) => declaration.name === "target")).toBe(true);

        if (parsed === undefined) {
            return;
        }

        const index = await buildUsageIndexInWorker(parsed);

        expect(index?.entries.some((entry) => entry.name === "target")).toBe(true);
    }, 10_000);

    it("rejects before starting a request when its signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort(new Error("cancelled before parse"));

        await expect(
            parseFileInWorker("void target();\n", "/virtual/large.cpp", "cpp", controller.signal),
        ).rejects.toThrow("cancelled before parse");
    });
});
