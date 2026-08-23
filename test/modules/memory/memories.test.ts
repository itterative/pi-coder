import { describe, it, expect } from "vitest";

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dedent } from "./utils";
import { scanMemories } from "../../../src/modules/memory/memories";

describe("scanMemories", () => {
    it("returns empty results for non-existent directory", async () => {
        const result = await scanMemories("/non/existent/path");
        expect(result).toEqual({ memories: [], errors: [] });
    });

    it("collects memories and reports parse errors", async () => {
        const dir = join(tmpdir(), `pi-memory-test-${Date.now()}`);
        await mkdir(dir, { recursive: true });

        try {
            await writeFile(
                join(dir, "architecture.md"),
                dedent`
                    ---
                    name: architecture
                    description: Architecture decisions
                    ---

                    # Architecture
                `,
            );
            await writeFile(
                join(dir, "conventions.md"),
                dedent`
                    ---
                    name: conventions
                    description: Code conventions
                    ---

                    # Conventions
                `,
            );
            await writeFile(join(dir, "notes.md"), "# Just notes\n\nNo frontmatter.");
            await writeFile(join(dir, "incomplete.md"), "---\nname: incomplete\n---");

            const result = await scanMemories(dir);

            expect(result.memories.map((m) => m.name).sort()).toEqual(["architecture", "conventions"]);
            expect(result.errors.map((e) => e.filePath).sort()).toEqual([
                join(dir, "incomplete.md"),
                join(dir, "notes.md"),
            ]);
        } finally {
            await rm(dir, { recursive: true });
        }
    });
});
