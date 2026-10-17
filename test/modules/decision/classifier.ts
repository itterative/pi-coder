import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
    ClassifierAnswer,
    ClassifierApi,
    ClassifierContext,
    ClassifierModel,
    ClassifierResult,
} from "@earendil-works/pi-ai";

import {
    SCRIPT_QUESTION,
    VETO_QUESTION,
    type ClassifierRegistry,
} from "../../../src/modules/decision";

export type Classifier = ClassifierModel<ClassifierApi>;

/** A classifier model with the fields the decision module reads. */
export function classifier(provider: string, id: string): Classifier {
    return {
        id,
        name: id,
        api: "typesafe-system-one",
        provider,
        baseUrl: "https://example.invalid",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        type: "classifier",
        contextWindow: 8192,
    };
}

/** A choice answer as the provider returns it: the label, its probability, and a confidence. */
export function choiceAnswer(choice: string, confidence: number): ClassifierAnswer {
    return { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
}

function result(model: Classifier, answers: Record<string, ClassifierAnswer>): ClassifierResult {
    return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers,
        stopReason: "stop",
        timestamp: 0,
    };
}

/**
 * A successful answer to the criterion question: the one request every strategy sends, and the only answer
 * the evaluator reads. The label is a criterion id, not an action — the table in `classification.ts` is what
 * turns it into one.
 */
export function criterionResult(
    model: Classifier,
    reason: string,
    confidence: number,
): ClassifierResult {
    return result(model, { [VETO_QUESTION]: choiceAnswer(reason, confidence) });
}

/** A successful answer to the script capability question, with a capability id as the label. */
export function scriptResult(
    model: Classifier,
    capability: string,
    confidence: number,
): ClassifierResult {
    return result(model, { [SCRIPT_QUESTION]: choiceAnswer(capability, confidence) });
}

/** A registry that resolves models but never classifies; for testing model selection. */
export function selectionRegistry(models: Classifier[]): ClassifierRegistry {
    return {
        getModelOfType: (_type, provider, modelId) =>
            models.find((model) => model.provider === provider && model.id === modelId),
        getModelsOfType: (_type, provider) =>
            provider === undefined ? models : models.filter((model) => model.provider === provider),
        classify: async () => {
            throw new Error("selectionRegistry does not classify");
        },
    };
}

/** How a registry double answers a classification. */
export type ClassifierBehavior = (
    model: Classifier,
    context: ClassifierContext,
    signal: AbortSignal | undefined,
) => Promise<ClassifierResult>;

/** A registry that resolves `models` and answers every classification through `behavior`. */
export function answeringRegistry(
    models: Classifier[],
    behavior: ClassifierBehavior,
): ClassifierRegistry {
    return {
        ...selectionRegistry(models),
        classify: (model, context, options) => behavior(model, context, options?.signal),
    };
}

/**
 * The registry face of an `ExtensionContext`. pi's `ModelRegistry` is a class surface with no partial
 * construction path, so the one cast lives here; the decision module only reads the classifier members this
 * double promises.
 */
export function classifierModelRegistry(
    registry: ClassifierRegistry,
): ExtensionContext["modelRegistry"] {
    return registry as unknown as ExtensionContext["modelRegistry"];
}
