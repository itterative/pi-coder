import { describe, it, expect } from "vitest";

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dedent } from "./utils";
import {
    budgetedPinned,
    PINNED_TEXT_LIMIT,
    PINNED_TOTAL_LIMIT,
    scanMemories,
} from "../../../src/modules/memory/memories";

describe("scanMemories", () => {
    it("returns empty results for non-existent directory", async () => {
        const result = await scanMemories("/non/existent/path");
        expect(result).toEqual({ memories: [], errors: [], pinned: [] });
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

            expect(result.memories.map((m) => m.name).sort()).toEqual([
                "architecture",
                "conventions",
            ]);
            expect(result.errors.map((e) => e.filePath).sort()).toEqual([
                join(dir, "incomplete.md"),
                join(dir, "notes.md"),
            ]);
        } finally {
            await rm(dir, { recursive: true });
        }
    });

    it("collects pinned bodies, keeping over-budget ones for the audit to report", async () => {
        const dir = join(tmpdir(), `pi-memory-pinned-${Date.now()}`);
        await mkdir(dir, { recursive: true });

        try {
            await writeFile(
                join(dir, "rule.md"),
                dedent`
                    ---
                    name: rule
                    description: A pinned rule
                    pinned: true
                    ---

                    # Rule

                    Always do the thing.
                `,
            );
            await writeFile(
                join(dir, "long.md"),
                `---\nname: long\ndescription: Too long to inject\npinned: true\n---\n\n${"x".repeat(PINNED_TEXT_LIMIT + 1)}\n`,
            );

            const result = await scanMemories(dir);

            expect(result.pinned.map((entry) => entry.name).sort()).toEqual(["long", "rule"]);
            expect(result.pinned.find((entry) => entry.name === "rule")?.text).toBe(
                "# Rule\n\nAlways do the thing.",
            );
            expect(budgetedPinned(result.pinned).map((entry) => entry.name)).toEqual(["rule"]);
        } finally {
            await rm(dir, { recursive: true });
        }
    });

    it("skips a pinned memory past the per-memory and total budgets, never truncating it", () => {
        const entry = (name: string, length: number) => ({ name, text: "a".repeat(length) });

        const kept = budgetedPinned([
            entry("first", PINNED_TEXT_LIMIT),
            entry("too-long", PINNED_TEXT_LIMIT + 1),
            entry("second", 1),
            entry("past-total", PINNED_TOTAL_LIMIT),
        ]);

        expect(kept.map((memory) => memory.name)).toEqual(["first", "second"]);
    });
});
