import type { EventBus } from "@earendil-works/pi-coding-agent";

import { isReminderPhase, type ReminderStateLabels } from "./reminder";

/** Shared pi event channel for decision-model activity changes. */
export const DECISION_STATUS_EVENT = "pi-coder:decision-status";

/** How many decision-model consults are in flight; the status footer animates while it is nonzero. */
export interface DecisionStatusEvent {
    checking: number;
}

export function emitDecisionStatus(events: EventBus | undefined, checking: number): void {
    events?.emit(DECISION_STATUS_EVENT, { checking } satisfies DecisionStatusEvent);
}

export function isDecisionStatusEvent(value: unknown): value is DecisionStatusEvent {
    if (!value || typeof value !== "object") return false;
    const event = value as Partial<DecisionStatusEvent>;
    return typeof event.checking === "number";
}

/**
 * Consults in flight across every surface; the status footer animates while it is nonzero.
 *
 * One counter for all of them, because there is one badge: overlapping consults count up, and the last one to
 * finish returns it to zero.
 */
let checksInFlight = 0;

/**
 * Run one model consult under the shared in-flight count.
 *
 * Every surface that asks the endpoint goes through here, so a new consult cannot forget to bracket its own
 * call. The count is released on the failure path too, since a failed consult is still a finished one.
 */
export async function withDecisionCheck<T>(
    events: EventBus | undefined,
    consult: () => Promise<T>,
): Promise<T> {
    checksInFlight += 1;
    emitDecisionStatus(events, checksInFlight);

    try {
        return await consult();
    } finally {
        checksInFlight = Math.max(0, checksInFlight - 1);
        emitDecisionStatus(events, checksInFlight);
    }
}

/** Shared pi event channel for the session state the decision model last judged. */
export const DECISION_STATE_EVENT = "pi-coder:decision-state";

/**
 * The labels the session was last judged to be in, so a surface can show the phase without a model call.
 *
 * Published by the parent reminder module alone. The status bus is shared with delegated children, whose
 * gates emit the in-flight count on it; a child's state must never overwrite the parent's badge.
 */
export interface DecisionStateEvent {
    labels: ReminderStateLabels;
}

export function emitDecisionState(events: EventBus | undefined, labels: ReminderStateLabels): void {
    events?.emit(DECISION_STATE_EVENT, { labels } satisfies DecisionStateEvent);
}

/** Read the payload structurally: a phase the vocabulary cannot name is dropped rather than rendered. */
export function isDecisionStateEvent(value: unknown): value is DecisionStateEvent {
    if (value === null || typeof value !== "object" || !("labels" in value)) {
        return false;
    }

    const { phase } = value.labels as ReminderStateLabels;
    return phase === undefined || isReminderPhase(phase);
}
