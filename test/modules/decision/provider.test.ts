import { describe, expect, it } from "vitest";

import type { DecisionModelConfig } from "../../../src/modules/decision";
import {
    DECISION_CLASSIFIER_API,
    DECISION_PROVIDER_ID,
    DEFAULT_CONTEXT_WINDOW,
    decisionProviderConfig,
    registerDecisionProvider,
    shouldRegisterDecisionProvider,
} from "../../../src/modules/decision/provider";
import { createPiStub } from "../../helpers/pi-stub";

/**
 * The decision endpoint is registered with pi as a System One classifier provider. These cases pin when a
 * registration happens at all, the shape pi needs to resolve the model, and that a config without an endpoint
 * registers nothing rather than an empty provider.
 */

const endpoint: DecisionModelConfig = {
    enabled: true,
    baseUrl: "https://classifier.example",
    apiKey: "endpoint-token",
    model: "system-one-8b",
    contextWindow: 16384,
};

describe("shouldRegisterDecisionProvider", () => {
    it("accepts an enabled endpoint that names the default provider", () => {
        expect(shouldRegisterDecisionProvider(endpoint)).toBe(true);
        expect(
            shouldRegisterDecisionProvider({ ...endpoint, provider: DECISION_PROVIDER_ID }),
        ).toBe(true);
    });

    it.each([
        ["enabled is missing", { ...endpoint, enabled: undefined }],
        ["enabled is false", { ...endpoint, enabled: false }],
        ["baseUrl is missing", { ...endpoint, baseUrl: undefined }],
        ["model is missing", { ...endpoint, model: undefined }],
        ["another provider is named", { ...endpoint, provider: "llamacpp" }],
    ] as Array<[string, DecisionModelConfig]>)("is false when %s", (_case, config) => {
        expect(shouldRegisterDecisionProvider(config)).toBe(false);
    });
});

describe("decisionProviderConfig", () => {
    it("builds the classifier registration pi needs", () => {
        const registration = decisionProviderConfig(endpoint);

        expect(registration).toMatchObject({
            name: "System One (decision model)",
            baseUrl: "https://classifier.example",
            apiKey: "endpoint-token",
            models: [
                {
                    type: "classifier",
                    id: "system-one-8b",
                    name: "system-one-8b",
                    api: DECISION_CLASSIFIER_API,
                    contextWindow: 16384,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
            ],
        });
        expect(registration?.classifiers?.[DECISION_CLASSIFIER_API]?.classify).toBeTypeOf(
            "function",
        );
    });

    it("declares the default context window and omits an absent apiKey", () => {
        const registration = decisionProviderConfig({
            ...endpoint,
            apiKey: undefined,
            contextWindow: undefined,
        });

        expect(registration).not.toHaveProperty("apiKey");
        expect(registration?.models?.[0]).toMatchObject({
            type: "classifier",
            contextWindow: DEFAULT_CONTEXT_WINDOW,
        });
    });

    it("returns undefined for an endpoint that cannot be registered", () => {
        expect(decisionProviderConfig({ enabled: true, model: "system-one-8b" })).toBeUndefined();
    });
});

describe("registerDecisionProvider", () => {
    it("registers under the systemone id and reports that it did", () => {
        const stub = createPiStub();

        expect(registerDecisionProvider(stub.pi, endpoint)).toBe(true);
        expect(stub.providers).toEqual([
            { id: DECISION_PROVIDER_ID, config: decisionProviderConfig(endpoint) },
        ]);
    });

    it("registers nothing when the config has no endpoint", () => {
        const stub = createPiStub();

        expect(registerDecisionProvider(stub.pi, { enabled: true })).toBe(false);
        expect(stub.providers).toEqual([]);
    });
});
