import type {
    ClassifierAnswer,
    ClassifierContext,
    ClassifierQuestion,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";

import { VETO_CRITERIA, VETO_INSTRUCTION, VETO_QUESTION } from "../questions";
import type { DecisionAction, DecisionReason } from "../types";
import type { StrategyAnswer } from "./types";

/**
 * The criteria the classification form asks about: the veto's six, plus `out_of_scope` last.
 *
 * The wording is the veto's, unchanged, because the criteria sentences are the part of the design that
 * measured best and because reusing them keeps the classification comparable with the second-opinion request
 * it replaced. The order is the order the model reads.
 */
export const CLASSIFICATION_CRITERIA: Record<DecisionReason, string> = {
    ...VETO_CRITERIA,
    out_of_scope: "Out of scope: the runner's rules do not allow this action",
};

/**
 * The criterion to action table.
 *
 * Policy lives here rather than in the model, and every row is justified by what the sandbox is instead of by
 * taste. The sandbox binds cwd read-write and shares the host network, so the three content criteria cannot
 * be contained by it — sandboxing an overwrite or a download is the same as allowing it — and neither can
 * `out_of_scope`, which is about who is asking rather than what the command does. `privileged` is the one row
 * that escalates rather than refuses: an unprivileged user namespace is exactly what contains it.
 *
 * Reading the rows as a group: `host` is the only answer that gains authority, `refuse` withholds, and
 * `sandbox` confines. Change a row when the sandbox changes, not when a case is annoying.
 */
export const ACTION_TABLE: Record<DecisionReason, DecisionAction> = {
    none: "host",
    privileged: "sandbox",
    destructive: "refuse",
    loses_content: "refuse",
    exfiltration: "refuse",
    remote_code: "refuse",
    out_of_scope: "refuse",
};

const CLASSIFICATION_QUESTION: ClassifierQuestion = {
    type: "choice",
    instructions: VETO_INSTRUCTION,
    criteria: CLASSIFICATION_CRITERIA,
};

/** One request: the state a strategy built, asked the classification question. */
export function classificationRequest(state: JsonObject): ClassifierContext {
    return { state, questions: { [VETO_QUESTION]: CLASSIFICATION_QUESTION } };
}

function isDecisionReason(value: string): value is DecisionReason {
    return Object.hasOwn(CLASSIFICATION_CRITERIA, value);
}

/**
 * Read the classification answer, and take its action from the table.
 *
 * Returns `undefined` for a missing answer, a non-choice answer, or a label outside the criteria, so an
 * unrecognized reply abstains rather than being mapped to a default action.
 */
export function classificationAnswerFrom(
    answers: Record<string, ClassifierAnswer>,
): StrategyAnswer | undefined {
    const answer = answers[VETO_QUESTION];
    if (answer === undefined || answer.type !== "choice") {
        return undefined;
    }

    if (!isDecisionReason(answer.choice)) {
        return undefined;
    }

    return {
        action: ACTION_TABLE[answer.choice],
        reason: answer.choice,
        confidence: answer.confidence,
    };
}
