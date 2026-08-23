import { describe, it, expect } from "vitest";

import { formatMemoryList } from "../../../src/modules/memory";
import type { MemoryMeta } from "../../../src/modules/memory/memories";

function mem(over: Partial<MemoryMeta> & Pick<MemoryMeta, "name" | "description">): MemoryMeta {
    return { ...over };
}

describe("formatMemoryList", () => {
    it("returns None when there are no memories", () => {
        expect(formatMemoryList([])).toBe("None");
    });

    it("renders known categories in fixed order, then Other last", () => {
        const out = formatMemoryList([
            mem({ name: "conv", description: "d", category: "convention" }),
            mem({ name: "tools", description: "d", category: "tools" }),
            mem({ name: "arch", description: "d", category: "architecture" }),
            mem({ name: "loose", description: "d" }),
        ]);

        const archIdx = out.indexOf("#### Architecture");
        const toolsIdx = out.indexOf("#### Tools");
        const convIdx = out.indexOf("#### Convention");
        const otherIdx = out.indexOf("#### Other");

        expect(archIdx).toBeGreaterThan(-1);
        expect(toolsIdx).toBeGreaterThan(archIdx);
        expect(convIdx).toBeGreaterThan(toolsIdx);
        expect(otherIdx).toBeGreaterThan(convIdx);
    });

    it("renders unknown categories between known ones and Other, alphabetically", () => {
        const out = formatMemoryList([
            mem({ name: "loose", description: "d" }),
            mem({ name: "zeta", description: "d", category: "zeta" }),
            mem({ name: "alpha", description: "d", category: "alpha" }),
            mem({ name: "arch", description: "d", category: "architecture" }),
        ]);

        const archIdx = out.indexOf("#### Architecture");
        const alphaIdx = out.indexOf("#### Alpha");
        const zetaIdx = out.indexOf("#### Zeta");
        const otherIdx = out.indexOf("#### Other");

        // known category first
        expect(archIdx).toBeLessThan(alphaIdx);
        // unknown categories alphabetical
        expect(alphaIdx).toBeLessThan(zetaIdx);
        // unknown categories come before Other
        expect(zetaIdx).toBeLessThan(otherIdx);
    });

    it("sorts within a category by priority ascending, defaulting to 99", () => {
        const out = formatMemoryList([
            mem({ name: "late", description: "d", category: "architecture" }),
            mem({ name: "early", description: "d", category: "architecture", priority: 1 }),
        ]);

        expect(out.indexOf("- **early**")).toBeLessThan(out.indexOf("- **late**"));
    });

    it("annotates high-churn memories with [high-churn]", () => {
        const out = formatMemoryList([mem({ name: "m", description: "d", keep_updated: true })]);

        expect(out).toContain("- **m** [high-churn] — d");
    });
});
