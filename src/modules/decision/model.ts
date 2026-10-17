import type {
    ClassifierApi,
    ClassifierContext,
    ClassifierModel,
    ClassifierResult,
    ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import type { DecisionModelConfig } from "./types";

type Classifier = ClassifierModel<ClassifierApi>;

/**
 * The subset of pi's `ModelRegistry` the decision module needs.
 *
 * Narrowed to classifier operations so the evaluator can be tested against a stub and so the module never
 * reaches for chat-model behavior it has no business touching.
 */
export interface ClassifierRegistry {
    getModelOfType(type: "classifier", provider: string, modelId: string): Classifier | undefined;
    getModelsOfType(type: "classifier", provider?: string): readonly Classifier[];
    classify(
        model: Classifier,
        context: ClassifierContext,
        options?: ModelsClassifierOptions,
    ): Promise<ClassifierResult>;
}

/**
 * Pick the classifier to consult.
 *
 * An explicit `provider` + `model` must resolve to that model; a `model` on its own resolves by id across
 * providers; naming only a provider takes its first classifier, and naming neither takes the first of any. A
 * named model never resolves to a different one, and a missing one abstains.
 *
 * The "model without a provider" case is a fix, not convenience: treating it as "any model at all" ignored the
 * id, so a config that lost its `provider` key consulted whatever classifier the catalog listed first —
 * measured live, a Cloudflare model with no credentials, which failed every request and then put the model
 * into cooldown, silently turning the gate back into plain prompting.
 */
export function resolveClassifier(
    registry: ClassifierRegistry,
    config: DecisionModelConfig,
): Classifier | undefined {
    if (config.provider !== undefined && config.model !== undefined) {
        return registry.getModelOfType("classifier", config.provider, config.model);
    }

    if (config.model !== undefined) {
        return registry.getModelsOfType("classifier").find((model) => model.id === config.model);
    }

    return registry.getModelsOfType("classifier", config.provider)[0];
}
