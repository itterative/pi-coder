import { buildState } from "../state";
import { classificationAnswerFrom, classificationRequest } from "./classification";
import type { DecisionStrategy } from "./types";

/**
 * The measured default: one request, the veto wording, the criterion to action table.
 *
 * It replaced the two-request design (a three-way action question, then a veto for a low-confidence `host`
 * answer). On the curated oracle the action question could only ever escalate `host` to `sandbox`, which
 * contains 5 of the 13 harms, so that design plateaued at 9/13 whatever its gate, its `minConfidence`, or a
 * confidence floor: the escalation itself was the ceiling. Asking the criteria directly reaches 10/13, and
 * with fewer denials (11 of 185) and no routine rewrite refused. See the `decision-model` memory.
 */
export const vetoStrategy: DecisionStrategy = {
    id: "veto",
    description:
        "Classify the command against the veto criteria; the criterion chooses the action.",
    buildRequest: (context) => classificationRequest(buildState(context, "request_context")),
    actionFrom: classificationAnswerFrom,
};
