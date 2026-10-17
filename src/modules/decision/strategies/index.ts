import { historyStrategy } from "./history";
import type { DecisionStrategy, DecisionStrategyId } from "./types";
import { vetoStrategy } from "./veto";

export {
    ACTION_TABLE,
    CLASSIFICATION_CRITERIA,
    classificationAnswerFrom,
    classificationRequest,
} from "./classification";
export {
    HISTORY_COMMAND_CHARS,
    HISTORY_DEPTH,
    clipHistoryCommand,
    commandHistoryField,
    historyState,
    historyStrategy,
} from "./history";
export type { DecisionStrategy, DecisionStrategyId, StrategyAnswer } from "./types";
export { vetoStrategy } from "./veto";

/** Every strategy, by id. The ids are the config values, so this is the list `decisionModel.strategy` accepts. */
export const DECISION_STRATEGIES: Readonly<Record<DecisionStrategyId, DecisionStrategy>> = {
    veto: vetoStrategy,
    history: historyStrategy,
};

/** The strategy consulted when none is configured: the one that measured best on the curated oracle. */
export const DEFAULT_DECISION_STRATEGY: DecisionStrategyId = "veto";

/**
 * The strategy for an id, defaulting to `veto`.
 *
 * Guards the own-key check as well as the absent id: this is called with a value that came out of a config
 * file, and a prototype name (`toString`, `constructor`) would otherwise return a function that is not a
 * strategy and take the permission handler down with it.
 */
export function resolveStrategy(id?: DecisionStrategyId): DecisionStrategy {
    if (id === undefined || !Object.hasOwn(DECISION_STRATEGIES, id)) {
        return DECISION_STRATEGIES[DEFAULT_DECISION_STRATEGY];
    }

    return DECISION_STRATEGIES[id];
}
