import { describe, expect, it } from "vitest";

import { randomSlug, SLUG_ADJECTIVES, SLUG_NOUNS } from "../../src/common/slug";

describe("randomSlug", () => {
    it("combines supplied words with a collision suffix", () => {
        expect(randomSlug(["quiet"], ["lantern"])).toMatch(/^quiet-lantern-[a-z0-9]{3}$/);
    });

    it("provides a broad default vocabulary", () => {
        expect(SLUG_ADJECTIVES.length).toBeGreaterThanOrEqual(24);
        expect(SLUG_NOUNS.length).toBeGreaterThanOrEqual(24);
        expect(randomSlug()).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
    });
});
