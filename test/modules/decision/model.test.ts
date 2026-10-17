import { describe, expect, it } from "vitest";

import { resolveClassifier } from "../../../src/modules/decision";

import { classifier, selectionRegistry } from "./classifier";

describe("resolveClassifier", () => {
    const jev = classifier("typesafe", "jev-latest");
    const laya = classifier("llamacpp", "laya");
    const registry = selectionRegistry([jev, laya]);

    it("resolves an explicit provider and model", () => {
        expect(resolveClassifier(registry, { provider: "llamacpp", model: "laya" })).toBe(laya);
    });

    it("does not fall back when the named model is missing", () => {
        expect(
            resolveClassifier(registry, { provider: "llamacpp", model: "missing" }),
        ).toBeUndefined();
    });

    it("resolves a named model without a provider by id", () => {
        expect(resolveClassifier(registry, { model: "laya" })).toBe(laya);
    });

    it("does not take an unrelated classifier when a provider-less model is missing", () => {
        // The regression this pins: "model without provider" used to mean "any classifier at all", so a config
        // that lost its `provider` key consulted a different provider's model instead of abstaining.
        expect(resolveClassifier(registry, { model: "missing" })).toBeUndefined();
    });

    it("takes the first classifier for a named provider", () => {
        expect(resolveClassifier(registry, { provider: "llamacpp" })).toBe(laya);
    });

    it("takes the first classifier overall when nothing is named", () => {
        expect(resolveClassifier(registry, {})).toBe(jev);
    });

    it("returns undefined when no classifier exists", () => {
        expect(resolveClassifier(selectionRegistry([]), {})).toBeUndefined();
    });
});
