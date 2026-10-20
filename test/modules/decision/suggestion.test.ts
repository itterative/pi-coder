import { describe, expect, it, vi } from "vitest";

import type {
    ClassifierContext,
    ClassifierResult,
    ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import {
    SUGGESTION_QUESTION_ID,
    SuggestionEvaluator,
    buildSuggestionState,
    consultSuggestionRole,
    suggestionRequest,
    suggestionRoleFrom,
    type ClassifierRegistry,
    type DecisionModelConfig,
    type SuggestionContext,
    type SuggestionEvaluatorOptions,
} from "../../../src/modules/decision";
import { DECISION_PROVIDER_ID } from "../../../src/modules/decision/provider";
import { stubContext, stubSessionManager } from "../../helpers/pi-stub";

import { classifier, suggestionResult, type Classifier } from "./classifier";

/**
 * The suggestion subject: one bool that names whether an argument is executed code, read against a
 * probability threshold, with its own cache and cooldown so a failed suggestion request cannot pause a
 * permission verdict.
 */

type Behavior = (
    model: Classifier,
    context: ClassifierContext,
    signal: AbortSignal | undefined,
) => Promise<ClassifierResult>;

const MODEL = classifier(DECISION_PROVIDER_ID, "test-classifier");

interface HarnessOptions {
    models?: Classifier[];
    behavior?: Behavior;
    config?: DecisionModelConfig;
    clock?: { t: number };
}

function harness(options: HarnessOptions = {}) {
    const models = options.models ?? [MODEL];
    const behavior = options.behavior ?? (async (model) => suggestionResult(model, 0.1));
    const classify = vi.fn(
        (model: Classifier, context: ClassifierContext, opts?: ModelsClassifierOptions) =>
            behavior(model, context, opts?.signal),
    );
    const registry: ClassifierRegistry = {
        getModelOfType: (_type, provider, modelId) =>
            models.find((model) => model.provider === provider && model.id === modelId),
        getModelsOfType: (_type, provider) =>
            provider === undefined ? models : models.filter((model) => model.provider === provider),
        classify,
    };
    const clock = options.clock ?? { t: 0 };
    const evaluatorOptions: SuggestionEvaluatorOptions = {
        registry,
        config: {
            enabled: true,
            provider: DECISION_PROVIDER_ID,
            model: MODEL.id,
            ...options.config,
        },
        now: () => clock.t,
    };
    const evaluator = new SuggestionEvaluator(evaluatorOptions);

    return { evaluator, classify, models, clock };
}

const segment: SuggestionContext = { command: "npx zorch script.ts", cwd: "/repo" };

describe("suggestion state and request", () => {
    it("carries the segment and cwd, and the recent window only when it has items", () => {
        expect(buildSuggestionState(segment)).toEqual({
            command: "npx zorch script.ts",
            cwd: "/repo",
        });
        expect(
            buildSuggestionState({ ...segment, recentCommands: ["npx zorch other.ts"] }),
        ).toEqual({
            command: "npx zorch script.ts",
            cwd: "/repo",
            recent_commands: ["npx zorch other.ts"],
        });
    });

    it("asks one bool question with the measured id", () => {
        const request = suggestionRequest(buildSuggestionState(segment));
        const question = request.questions[SUGGESTION_QUESTION_ID];

        expect(question).toMatchObject({ type: "bool" });
        expect(question?.instructions).toContain("execute code");
        expect((question as { criteria: Record<string, string> }).criteria).toHaveProperty("true");
    });

    it("reads the probability against the threshold and abstains on an unreadable answer", () => {
        expect(
            suggestionRoleFrom({ [SUGGESTION_QUESTION_ID]: { type: "bool", probability: 0.9 } }),
        ).toBe("code");
        expect(
            suggestionRoleFrom({ [SUGGESTION_QUESTION_ID]: { type: "bool", probability: 0.1 } }),
        ).toBe("data");
        expect(
            suggestionRoleFrom({ [SUGGESTION_QUESTION_ID]: { type: "bool", probability: 0.5 } }),
        ).toBe("code");
        expect(suggestionRoleFrom({})).toBeUndefined();
        expect(
            suggestionRoleFrom({
                [SUGGESTION_QUESTION_ID]: {
                    type: "choice",
                    choice: "data",
                    probabilities: {},
                    confidence: 1,
                },
            }),
        ).toBeUndefined();
    });
});

describe("suggestion evaluator", () => {
    it("is disabled when the model or the subject is off, without a request", async () => {
        for (const config of [{ enabled: false }, { enabled: true, suggestions: false }]) {
            const { evaluator, classify } = harness({ config });
            await expect(evaluator.evaluate(segment)).resolves.toMatchObject({
                status: "disabled",
            });
            expect(classify).not.toHaveBeenCalled();
        }
    });

    it("is disabled when no classifier resolves", async () => {
        const { evaluator, classify } = harness({ models: [] });

        await expect(evaluator.evaluate(segment)).resolves.toMatchObject({ status: "disabled" });
        expect(classify).not.toHaveBeenCalled();
    });

    it("answers the role and sends the segment and its history", async () => {
        const { evaluator, classify } = harness({
            behavior: async (model) => suggestionResult(model, 0.8),
        });

        const consult = await evaluator.evaluate({
            ...segment,
            recentCommands: ["npx zorch other.ts"],
        });

        expect(consult).toMatchObject({ role: "code", status: "answered" });
        const context = classify.mock.calls[0]?.[1];
        expect(context?.state).toEqual({
            command: "npx zorch script.ts",
            cwd: "/repo",
            recent_commands: ["npx zorch other.ts"],
        });
    });

    it("serves an identical segment from the cache", async () => {
        const { evaluator, classify } = harness();

        const first = await evaluator.evaluate(segment);
        const second = await evaluator.evaluate(segment);

        expect(first.status).toBe("answered");
        expect(second).toMatchObject({ role: "data", status: "cached" });
        expect(classify).toHaveBeenCalledTimes(1);
    });

    it("keys the cache on the recent window, because it can change the answer", async () => {
        const { evaluator, classify } = harness();

        await evaluator.evaluate(segment);
        await evaluator.evaluate({ ...segment, recentCommands: ["npx zorch other.ts"] });

        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("cools down after a failure and calls again once it expires", async () => {
        let failing = true;
        const { evaluator, classify, clock } = harness({
            behavior: async (model) =>
                failing
                    ? { ...suggestionResult(model, 0.1), stopReason: "error", errorMessage: "down" }
                    : suggestionResult(model, 0.2),
        });

        await expect(evaluator.evaluate(segment)).resolves.toMatchObject({ status: "error" });
        await expect(evaluator.evaluate(segment)).resolves.toMatchObject({ status: "cooldown" });
        expect(classify).toHaveBeenCalledTimes(1);

        failing = false;
        clock.t = 60_000;
        await expect(evaluator.evaluate(segment)).resolves.toMatchObject({
            role: "data",
            status: "answered",
        });
        expect(classify).toHaveBeenCalledTimes(2);
    });

    it("reports a timeout from the abort signal", async () => {
        const { evaluator } = harness({
            config: { timeoutMs: 10 },
            behavior: (model, _context, signal) =>
                new Promise((resolve) => {
                    signal?.addEventListener(
                        "abort",
                        () => {
                            resolve({
                                ...suggestionResult(model, 1),
                                stopReason: "aborted",
                            });
                        },
                        { once: true },
                    );
                }),
        });

        await expect(evaluator.evaluate(segment)).resolves.toMatchObject({ status: "timeout" });
    });

    it("treats a thrown classifier call as an error and abstains on an unreadable answer", async () => {
        const thrown = await harness({ behavior: async () => Promise.reject(new Error("boom")) });
        await expect(thrown.evaluator.evaluate(segment)).resolves.toMatchObject({
            status: "error",
        });

        const unreadable = await harness({
            behavior: async (model) => ({
                ...suggestionResult(model, 0.1),
                answers: {},
            }),
        });
        await expect(unreadable.evaluator.evaluate(segment)).resolves.toMatchObject({
            status: "abstained",
        });
    });
});

describe("consultSuggestionRole", () => {
    it("passes the caller's recent commands through and reports disabled without a role", async () => {
        const classify = vi.fn(async (model: Classifier, _context: ClassifierContext) =>
            suggestionResult(model, 0.2),
        );
        const registry: ClassifierRegistry = {
            getModelOfType: () => MODEL,
            getModelsOfType: () => [MODEL],
            classify,
        };
        const ctx = stubContext({ sessionManager: stubSessionManager() });
        const config: DecisionModelConfig = {
            enabled: true,
            provider: DECISION_PROVIDER_ID,
            model: MODEL.id,
        };

        const consulted = await consultSuggestionRole({
            ctx,
            config,
            command: "npx zorch script.ts",
            recentCommands: ["npx zorch other.ts"],
            registry,
        });

        expect(consulted).toMatchObject({ role: "data", status: "answered" });
        expect(classify.mock.calls[0]?.[1]?.state).toMatchObject({
            recent_commands: ["npx zorch other.ts"],
        });

        const disabled = await consultSuggestionRole({
            ctx,
            config: { enabled: false },
            command: "x",
        });
        expect(disabled).toMatchObject({ status: "disabled" });
    });
});
