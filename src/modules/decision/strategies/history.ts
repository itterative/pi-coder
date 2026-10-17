import type { JsonObject } from "@earendil-works/pi-ai";

import { buildState } from "../state";
import type { DecisionContext } from "../types";
import { classificationAnswerFrom, classificationRequest } from "./classification";
import type { DecisionStrategy } from "./types";

/** How many earlier commands the state carries, most recent last. */
export const HISTORY_DEPTH = 40;

/** How much of each earlier command survives, after its whitespace is collapsed. */
export const HISTORY_COMMAND_CHARS = 200;

/**
 * The command history field: the last `HISTORY_DEPTH` commands, oldest first, each clipped.
 *
 * Measured, and the measurement is why this is not the default state. On a real session it moved 0 of 80
 * verdicts for +2.4k tokens and roughly 3.5x the latency, and in front of the curated hazards it *lost*
 * detections (10/13 to 9/13): a backdrop of ordinary commands normalises ordinary-looking dangers such as
 * `git push --force` and `pip install`. It stays a strategy so the comparison is one config value away, and
 * it reuses the veto's questions and table, which is what makes the two comparable in the first place.
 *
 * The freeform form (`"Commands already run earlier in this session, oldest first:\n  …"`) measured
 * equivalent, so the structured form ships: it is unambiguous to the model and to a reader of the request
 * snapshot.
 */
export function commandHistoryField(history: readonly string[]): JsonObject {
    const recent = history.slice(-HISTORY_DEPTH);
    if (recent.length === 0) {
        return {};
    }

    return { command_history: recent.map((command) => ({ command: clipHistoryCommand(command) })) };
}

/**
 * One history entry, as the measured arms had it: whitespace collapsed to single spaces, then clipped to
 * `HISTORY_COMMAND_CHARS` with an ellipsis. Collapsing matters because most commands arrive multi-line (a
 * heredoc, a `cd &&` chain), and an unexplained blank line in the state reads as a new instruction.
 */
export function clipHistoryCommand(command: string): string {
    const collapsed = command.split(/\s+/u).filter(Boolean).join(" ");
    if (collapsed.length <= HISTORY_COMMAND_CHARS) {
        return collapsed;
    }

    return `${collapsed.slice(0, HISTORY_COMMAND_CHARS - 1)}…`;
}

/**
 * The production state plus the history, in one field.
 *
 * Nothing else differs, so a verdict that changes between the two strategies changed because of this field.
 */
export function historyState(context: DecisionContext): JsonObject {
    return {
        ...buildState(context, "request_context"),
        ...commandHistoryField(context.history ?? []),
    };
}

/** The veto strategy with this session's own earlier commands in the state. */
export const historyStrategy: DecisionStrategy = {
    id: "history",
    description: "The veto strategy, with the session's own earlier commands in the state.",
    buildRequest: (context) => classificationRequest(historyState(context)),
    actionFrom: classificationAnswerFrom,
};
