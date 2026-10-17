import type { ClassifierAnswer, ClassifierContext } from "@earendil-works/pi-ai";

import type { DecisionAction, DecisionContext, DecisionReason } from "../types";

/**
 * The strategies the module ships.
 *
 * `veto` is the measured default. `history` asks the same question against the same criteria and differs in
 * one thing only — the session's own earlier commands in the state — which is what makes the two comparable:
 * a difference in their verdicts can only come from the state.
 */
export type DecisionStrategyId = "veto" | "history";

/** The action a strategy read out of the model's answer, with the criterion it came from. */
export interface StrategyAnswer {
    action: DecisionAction;
    /** The criterion the model named. This is what the decision log records. */
    reason: DecisionReason;
    confidence: number;
}

/**
 * One named way of asking the classifier, and of reading its answer.
 *
 * A strategy bundles the three levers the measurements found to be independent: the **state** (which facts
 * reach the model), the **questions** (wording and criteria), and the **table** (criterion to action). They
 * are one object because changing one without the others is how a measurement becomes a guess — `buildRequest`
 * returns both halves of a single request, so a wording and the state it accompanies cannot drift apart, and
 * `actionFrom` is the only place a criterion turns into authority.
 *
 * Policy that is not strategy-specific stays out: a `refuse` applies unconditionally and a `host` needs
 * confidence, so that half lives in `policy.ts`. `decisionModel.strategy` selects one of these.
 */
export interface DecisionStrategy {
    readonly id: DecisionStrategyId;
    /** One line for config help and the decision log. */
    readonly description: string;
    /** The classifier request to send for a context. */
    buildRequest(context: DecisionContext): ClassifierContext;
    /** The action the answers recommend, or `undefined` when they name no criterion. */
    actionFrom(answers: Record<string, ClassifierAnswer>): StrategyAnswer | undefined;
}
