import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { classify as classifySystemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";

import type { DecisionModelConfig } from "./types";

/**
 * Register the configured endpoint as a classifier provider inside pi.
 *
 * The endpoint speaks System One — `POST {baseUrl}/systemone` with `{model, state, questions}` — which pi
 * already implements as the classifier api `typesafe-system-one`; its URL builder appends exactly that last
 * path segment. Reusing it means the module holds no HTTP client of its own and the request picks up pi's
 * credential resolution, usage, and cancellation.
 *
 * `models.json` cannot express this: its model entries have no type, and classifier models need an explicit
 * discriminant plus an implementation, both of which only an extension registration can carry.
 */

/** Provider id the endpoint is registered under; also the config's default provider. */
export const DECISION_PROVIDER_ID = "systemone";
/** The classifier api the endpoint speaks. */
export const DECISION_CLASSIFIER_API = "typesafe-system-one";
/** Declared context window when the config does not name one. The requests are small; this is a ceiling. */
export const DEFAULT_CONTEXT_WINDOW = 32768;

/** Whether the config asks for a registration at all. */
export function shouldRegisterDecisionProvider(config: DecisionModelConfig): boolean {
    if (config.enabled !== true) {
        return false;
    }

    if ((config.provider ?? DECISION_PROVIDER_ID) !== DECISION_PROVIDER_ID) {
        return false;
    }

    return config.baseUrl !== undefined && config.model !== undefined;
}

/**
 * The registration for a configured endpoint, or `undefined` when there is nothing to register.
 *
 * The model is the only one on the provider, so a wrong `model` cannot silently resolve to a different
 * classifier; `resolveClassifier` looks it up by id.
 */
export function decisionProviderConfig(config: DecisionModelConfig): ProviderConfig | undefined {
    if (!shouldRegisterDecisionProvider(config)) {
        return undefined;
    }

    const modelId = config.model;
    if (modelId === undefined || config.baseUrl === undefined) {
        return undefined;
    }

    return {
        name: "System One (decision model)",
        baseUrl: config.baseUrl,
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        models: [
            {
                type: "classifier",
                id: modelId,
                name: modelId,
                api: DECISION_CLASSIFIER_API,
                contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
        classifiers: { [DECISION_CLASSIFIER_API]: { classify: classifySystemOne } },
    };
}

/** Register the configured endpoint with pi. Returns whether anything was registered. */
export function registerDecisionProvider(pi: ExtensionAPI, config: DecisionModelConfig): boolean {
    const registration = decisionProviderConfig(config);
    if (registration === undefined) {
        return false;
    }

    pi.registerProvider(DECISION_PROVIDER_ID, registration);
    return true;
}

/**
 * Replace this extension's endpoint registration with whatever the config now asks for.
 *
 * Registration after load takes effect immediately in pi and unregistering an unknown provider is a no-op,
 * so the settings dialog can switch the endpoint on, off, or to another model without a reload. Known
 * classifier providers need no registration at all — `resolveClassifier` finds their models in the registry.
 */
export function syncDecisionProvider(pi: ExtensionAPI, config: DecisionModelConfig): boolean {
    pi.unregisterProvider(DECISION_PROVIDER_ID);
    return registerDecisionProvider(pi, config);
}
