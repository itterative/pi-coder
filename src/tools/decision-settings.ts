/**
 * Decision Model Settings Bridge
 *
 * The domain half of the decision-model settings dialog: it projects the effective config into dialog state,
 * lists the classifier models the user's providers offer, saves dialog patches to the global config, and
 * re-registers this extension's endpoint provider so a change takes effect without a reload.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import decisionConfig, {
    findDecisionConfigLocations,
    saveDecisionConfig,
    type DecisionModelPatch,
} from "../modules/decision/config";
import { DECISION_PROVIDER_ID, syncDecisionProvider } from "../modules/decision/provider";
import type { DecisionModelConfig } from "../modules/decision/types";
import type { AgentSetting } from "../tui/agents/types";
import {
    decisionModelDialog,
    type DecisionSettingsChoice,
    type DecisionSettingsPatch,
    type DecisionSettingsState,
} from "../tui/decision";

/** The settings-tab row for the decision model. */
export function decisionModelSetting(cwd: string): AgentSetting {
    const config = decisionConfig.load(cwd);
    return {
        id: "decisionModel",
        label: "Decision model",
        description:
            "Optional classifier for commands the rules leave unresolved. Pick one of your providers' classifiers, or point at a custom System One endpoint.",
        status: `${config.enabled === true ? "On" : "Off"} · ${decisionModelName(config)}`,
    };
}

function decisionModelName(config: DecisionModelConfig): string {
    if (config.model === undefined) {
        return "not configured";
    }
    if (config.provider !== undefined && config.provider !== DECISION_PROVIDER_ID) {
        return `${config.provider}/${config.model}`;
    }
    if (config.provider === undefined && config.baseUrl === undefined) {
        return config.model;
    }
    return `custom · ${config.model}`;
}

/** Open the dialog and persist every change immediately. */
export async function openDecisionModelSettings(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const config = decisionConfig.load(ctx.cwd);
    const choices = await classifierChoices(ctx);
    const locations = findDecisionConfigLocations(ctx.cwd);

    await decisionModelDialog(
        {
            state: settingsState(config),
            choices,
            ...(locations.project === undefined ? {} : { projectConfigPath: locations.project }),
            onChange: (patch) => {
                saveDecisionConfig(decisionModelPatch(patch));
                if (touchesProvider(patch)) {
                    syncDecisionProvider(pi, decisionConfig.load(ctx.cwd));
                }
            },
            onError: (error) => {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not save the decision model settings: ${message}`, "warning");
            },
        },
        ctx,
    );
}

function settingsState(config: DecisionModelConfig): DecisionSettingsState {
    const custom =
        config.provider === DECISION_PROVIDER_ID ||
        (config.provider === undefined && config.baseUrl !== undefined);

    return {
        enabled: config.enabled === true,
        apply: config.apply === true,
        custom,
        ...(config.provider === undefined ? {} : { provider: config.provider }),
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        apiKeySet: config.apiKey !== undefined,
    };
}

/** Dialog terms to config terms: the custom choice is the `systemone` provider. */
function decisionModelPatch(patch: DecisionSettingsPatch): DecisionModelPatch {
    const { custom, ...fields } = patch;
    if (custom === true) {
        return { ...fields, provider: DECISION_PROVIDER_ID };
    }
    return fields;
}

const PROVIDER_PATCH_FIELDS = [
    "enabled",
    "custom",
    "provider",
    "model",
    "baseUrl",
    "apiKey",
] as const;

function touchesProvider(patch: DecisionSettingsPatch): boolean {
    return PROVIDER_PATCH_FIELDS.some((field) => patch[field] !== undefined);
}

/** Classifiers from the user's providers; the extension's own endpoint is the custom choice instead. */
async function classifierChoices(ctx: ExtensionCommandContext): Promise<DecisionSettingsChoice[]> {
    try {
        const models = await ctx.modelRegistry.getAvailableOfType("classifier");
        return models
            .filter((model) => model.provider !== DECISION_PROVIDER_ID)
            .map((model) => ({
                provider: model.provider,
                model: model.id,
                ...(model.name === undefined || model.name === model.id
                    ? {}
                    : { name: model.name }),
            }))
            .sort((left, right) =>
                `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
            );
    } catch {
        // A registry that cannot list classifiers still leaves the custom endpoint usable.
        return [];
    }
}
